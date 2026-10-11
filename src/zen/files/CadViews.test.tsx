// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// jsdom has no WebGL: the three.js module is a stand-in, so these tests
// check ModelView's wiring (lazy load, stats, fallback, dispose).
const scene = vi.hoisted(() => {
  const dispose = vi.fn();
  return {
    dispose,
    parseModel: vi.fn(async () => ({
      root: { isStub: true },
      stats: { triangles: 288, meshes: 1, size: [120, 60, 6] as [number, number, number] },
    })),
    hasWebGL2: vi.fn(() => true),
    createViewer: vi.fn((_host: HTMLElement, _root: unknown) => ({ dispose, reset: vi.fn() })),
    disposeObject: vi.fn(),
  };
});
vi.mock("./modelScene", () => ({
  parseModel: scene.parseModel,
  hasWebGL2: scene.hasWebGL2,
  createViewer: scene.createViewer,
  disposeObject: scene.disposeObject,
}));
vi.mock("../../api/client", () => ({
  getFsReadBinary: vi.fn(),
  getFsReadRange: vi.fn(),
  getFsZipList: vi.fn(),
}));

import { getFsReadBinary } from "../../api/client";
import FileBody from "./FileBody";
import { DXF_FIXTURE } from "./dxfFixture";
import { MODEL_MAX_BYTES, modelSizeError } from "./ModelView";
import type { StubFile } from "../stubData";

const text = (id: string, body: string): StubFile => ({
  id,
  name: id.split("/").pop()!,
  body,
  loaded: true,
  fsPath: id,
  readError: null,
});
const bin = (id: string): StubFile => ({ ...text(id, ""), body: "" });

beforeEach(() => {
  vi.mocked(getFsReadBinary).mockReset();
  vi.mocked(getFsReadBinary).mockResolvedValue({ ok: true, data: { base64: btoa("solid x\nendsolid x\n") } });
  scene.parseModel.mockClear();
  scene.createViewer.mockClear();
  scene.dispose.mockClear();
  scene.disposeObject.mockClear();
  scene.hasWebGL2.mockReturnValue(true);
});
afterEach(() => cleanup());

describe("DXF viewer", () => {
  it("draws the fixture as SVG lines, circles, arc paths and text", async () => {
    render(<FileBody file={text("/ws/plan.dxf", DXF_FIXTURE)} source={false} stub={false} />);
    const svg = await screen.findByTestId("dxf-svg");
    expect(svg.querySelectorAll("line")).toHaveLength(1);
    expect(svg.querySelectorAll("circle")).toHaveLength(2);
    expect(svg.querySelectorAll("path")).toHaveLength(3);
    expect(svg.querySelectorAll("text")).toHaveLength(2);
    expect(svg.querySelector("path")!.getAttribute("d")).toContain(" A20 20 0 0 1 ");
    // Y flipped once at the root; text flips itself back.
    expect(screen.getByTestId("dxf-shapes").getAttribute("transform")).toBe("scale(1 -1)");
    expect(svg.querySelector("text")!.getAttribute("transform")).toContain("scale(1 -1)");
    expect(svg.getAttribute("viewBox")).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
  });

  it("notes the entities it could not draw", async () => {
    render(<FileBody file={text("/ws/plan.dxf", DXF_FIXTURE)} source={false} stub={false} />);
    const note = await screen.findByTestId("dxf-skipped");
    expect(note.textContent).toContain("2 entities not shown");
    expect(note.textContent).toMatch(/POINT/);
    expect(note.textContent).toMatch(/HATCH/);
    expect(screen.getByTestId("dxf-stats").textContent).toMatch(/entities ·/);
  });

  it("binary DXF says so", async () => {
    render(<FileBody file={text("/ws/b.dxf", "AutoCAD Binary DXF\r\n\u001a\u0000")} source={false} stub={false} />);
    expect((await screen.findByTestId("dxf-error")).textContent).toContain("Binary DXF is not supported");
  });

  it("read-file's binary refusal on a .dxf names binary DXF", () => {
    const f = { ...text("/ws/b.dxf", ""), readError: "Cannot read binary file" };
    render(<FileBody file={f} source={false} stub={false} />);
    expect(screen.getByTestId("file-binary").textContent).toContain("Binary DXF is not supported");
  });

  it("Source shows the DXF text", async () => {
    render(<FileBody file={text("/ws/plan.dxf", DXF_FIXTURE)} source stub={false} />);
    await waitFor(() => expect(screen.getByTestId("file-code").textContent).toContain("ENTITIES"));
  });
});

describe("3D viewer", () => {
  it("lazy-loads the scene module, parses the bytes and shows stats", async () => {
    render(<FileBody file={bin("/ws/k2-bracket.stl")} source={false} stub={false} />);
    const stats = await screen.findByTestId("model-stats");
    expect(stats.textContent).toBe("288 triangles · 120 × 60 × 6 units");
    expect(getFsReadBinary).toHaveBeenCalledWith(expect.anything(), "/ws/k2-bracket.stl");
    expect(scene.parseModel).toHaveBeenCalledWith(expect.any(Uint8Array), ".stl");
    await waitFor(() => expect(scene.createViewer).toHaveBeenCalledTimes(1));
    expect(scene.createViewer.mock.calls[0][0]).toBe(screen.getByTestId("model-host"));
  });

  it("disposes the renderer on unmount", async () => {
    const view = render(<FileBody file={bin("/ws/k2-cube.obj")} source={false} stub={false} />);
    await waitFor(() => expect(scene.createViewer).toHaveBeenCalled());
    expect(scene.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(scene.dispose).toHaveBeenCalledTimes(1);
  });

  it("no WebGL: says so and keeps the stats", async () => {
    scene.hasWebGL2.mockReturnValue(false);
    render(<FileBody file={bin("/ws/k2-bracket.3mf")} source={false} stub={false} />);
    expect((await screen.findByTestId("model-nogl")).textContent).toContain("3D preview needs WebGL");
    expect(screen.getByTestId("model-stats").textContent).toContain("288 triangles");
    expect(scene.createViewer).not.toHaveBeenCalled();
    expect(scene.disposeObject).toHaveBeenCalled();
  });

  it("the daemon's size refusal reads as too large to preview", async () => {
    vi.mocked(getFsReadBinary).mockResolvedValue({ ok: false, error: "File too large (>50MB)" });
    render(<FileBody file={bin("/ws/huge.stl")} source={false} stub={false} />);
    expect((await screen.findByTestId("model-error")).textContent).toContain("Too large to preview");
    expect(scene.parseModel).not.toHaveBeenCalled();
  });

  it("size guard", () => {
    expect(modelSizeError(MODEL_MAX_BYTES)).toBeNull();
    expect(modelSizeError(MODEL_MAX_BYTES + 1)).toMatch(/over the 50\.0 MB preview limit/);
  });

  it("a parse error shows the message", async () => {
    scene.parseModel.mockRejectedValueOnce(new Error("No triangles in this STL."));
    render(<FileBody file={bin("/ws/empty.stl")} source={false} stub={false} />);
    expect((await screen.findByTestId("model-error")).textContent).toContain("No triangles in this STL.");
  });

  it("a truncated STL shows the can't-preview note, never a raw throw", async () => {
    // What the real parseModel rejects with for a 20-byte STL (modelParse.test.ts).
    scene.parseModel.mockRejectedValueOnce(
      new Error("This STL could not be read (Offset is outside the bounds of the DataView).")
    );
    render(<FileBody file={bin("/ws/truncated.stl")} source={false} stub={false} />);
    const note = await screen.findByTestId("model-error");
    expect(note.textContent).toContain("Could not open the model");
    expect(note.textContent).toContain("This STL could not be read");
    expect(scene.createViewer).not.toHaveBeenCalled();
  });
});
