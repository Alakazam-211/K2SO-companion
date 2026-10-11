import { describe, expect, it } from "vitest";
import { buildDrawing, censusEntities, FG, mtextLines, type DxfNode } from "./dxfModel";
import { DXF_FIXTURE } from "./dxfFixture";

const flat = (nodes: DxfNode[]): DxfNode[] =>
  nodes.flatMap((n) => (n.k === "group" ? [n, ...flat(n.children)] : [n]));

describe("dxfModel", () => {
  const d = buildDrawing(DXF_FIXTURE);
  const all = flat(d.nodes);
  const of = <K extends DxfNode["k"]>(k: K) => all.filter((n): n is Extract<DxfNode, { k: K }> => n.k === k);

  it("draws lines, circles, arcs, polylines, ellipses and text", () => {
    expect(of("line")).toHaveLength(1);
    expect(of("circle")).toHaveLength(2);
    expect(of("path")).toHaveLength(3);
    expect(of("text")).toHaveLength(2);
    expect(of("group")).toHaveLength(1);
  });

  it("ARC is an SVG arc, counter-clockwise (sweep 1)", () => {
    expect(of("path")[0].d).toBe("M70 50 A20 20 0 0 1 50 70");
  });

  it("LWPOLYLINE bulge 1 becomes a half-circle arc", () => {
    expect(of("path")[1].d).toBe("M0 0 A5 5 0 0 1 10 0");
  });

  it("colours: layer colour, entity ACI, ByBlock from the INSERT, ACI 7 → theme", () => {
    expect(of("line")[0].c).toBe("#ff0000");
    expect(of("circle")[0].c).toBe("#00ff00");
    expect(of("circle")[1].c).toBe("#0000ff");
    expect(of("text")[0].c).toBe(FG);
  });

  it("INSERT nests the block under its transform", () => {
    const grp = of("group")[0];
    expect(grp.k === "group" && grp.m).toEqual([1, 0, 0, 1, 20, 20]);
  });

  it("TEXT decodes %%c; MTEXT strips formatting and splits \\P", () => {
    expect(of("text")[0].lines).toEqual(["HELLO ⌀10"]);
    expect(of("text")[1].lines).toEqual(["Top", "Second"]);
    expect(mtextLines("\\H2.5;Big\\~gap\\Pnext")).toEqual(["Big gap", "next"]);
  });

  it("hidden layers are not drawn; unsupported types are counted", () => {
    expect(d.skipped).toEqual({ POINT: 1, HATCH: 1 });
    expect(d.skippedTotal).toBe(2);
    expect(censusEntities(DXF_FIXTURE).HATCH).toBe(1);
  });

  it("bounds cover the drawing", () => {
    expect(d.bounds).not.toBeNull();
    expect(d.bounds!.minX).toBeLessThanOrEqual(-10);
    expect(d.bounds!.maxX).toBeGreaterThanOrEqual(100);
    expect(d.bounds!.maxY).toBeGreaterThanOrEqual(80);
  });

  it("binary DXF is refused with a clear message", () => {
    expect(() => buildDrawing("AutoCAD Binary DXF\r\n\u001a\u0000...")).toThrow(/Binary DXF/);
  });
});
