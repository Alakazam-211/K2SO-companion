import { describe, expect, it, vi } from "vitest";
import type { ServerProject } from "./serverPins";
import type { StubAgent } from "./stubData";
import {
  ICON_BUDGET_CHARS,
  ICON_MAX_CHARS,
  ICON_PX,
  canChangeIcon,
  centreSquare,
  encodeIcon,
  iconFromFile,
  iconTargetFor,
  withWorkspaceLook,
  workspaceLookOf,
  type IconCanvas,
} from "./workspaceIcon";
import { lookUpdateBody } from "./workspaceLookSave";

vi.mock("../api/client", () => ({
  getCliProjectsList: vi.fn(),
  updateProjectLook: vi.fn(),
}));

function fakeCanvas(out: (type?: string, q?: number) => string) {
  const drawImage = vi.fn();
  const clearRect = vi.fn();
  const canvas: IconCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage, clearRect }),
    toDataURL: vi.fn(out),
  };
  return { canvas, drawImage };
}

const project = (p: Partial<ServerProject> & { id: string }): ServerProject => ({
  name: p.id,
  path: null,
  handle: null,
  pinned: false,
  tabOrder: 0,
  focusGroupId: null,
  ...p,
});

describe("centreSquare", () => {
  it("crops the middle of a landscape and a portrait image", () => {
    expect(centreSquare(800, 600)).toEqual({ sx: 100, sy: 0, side: 600 });
    expect(centreSquare(300, 500)).toEqual({ sx: 0, sy: 100, side: 300 });
    expect(centreSquare(64, 64)).toEqual({ sx: 0, sy: 0, side: 64 });
  });
});

describe("encodeIcon", () => {
  it("keeps PNG when it fits the budget", () => {
    const { canvas } = fakeCanvas(() => "data:image/png;base64,AAAA");
    expect(encodeIcon(canvas)).toBe("data:image/png;base64,AAAA");
  });

  it("falls back to the first JPEG quality that fits", () => {
    const big = "x".repeat(ICON_BUDGET_CHARS);
    const { canvas } = fakeCanvas((type, q) =>
      type === "image/png"
        ? `data:image/png;base64,${big}`
        : q === 0.85
          ? `data:image/jpeg;base64,${big}`
          : "data:image/jpeg;base64,small"
    );
    expect(encodeIcon(canvas)).toBe("data:image/jpeg;base64,small");
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.7);
  });

  it("refuses an icon over the hard cap", () => {
    const huge = "x".repeat(ICON_MAX_CHARS + 1);
    const { canvas } = fakeCanvas((type) => `data:${type};base64,${huge}`);
    expect(() => encodeIcon(canvas)).toThrow(/too large/);
  });
});

describe("iconFromFile", () => {
  it("centre-crops the picked image into a 256px square data URL", async () => {
    const { canvas, drawImage } = fakeCanvas(() => "data:image/png;base64,SQUARE");
    const source = {} as CanvasImageSource;
    const url = await iconFromFile(new Blob(["x"], { type: "image/jpeg" }), {
      readAsDataUrl: async () => "data:image/jpeg;base64,ORIG",
      loadImage: async (src) => {
        expect(src).toBe("data:image/jpeg;base64,ORIG");
        return { width: 4032, height: 3024, source };
      },
      makeCanvas: () => canvas,
    });
    expect(url).toBe("data:image/png;base64,SQUARE");
    expect(canvas.width).toBe(ICON_PX);
    expect(canvas.height).toBe(ICON_PX);
    expect(drawImage).toHaveBeenCalledWith(source, 504, 0, 3024, 3024, 0, 0, 256, 256);
  });

  it("refuses a file that is not an image", async () => {
    await expect(iconFromFile(new Blob(["x"], { type: "text/plain" }))).rejects.toThrow(/image/);
  });
});

const main: StubAgent = {
  id: "/w/alpha",
  name: "Alpha",
  initial: "A",
  path: "/w/alpha",
  addr: "alpha",
  kind: "agent",
  color: "#3b82f6",
  iconUrl: null,
};
const side: StubAgent = { ...main, id: "/w/alpha::alpha/notes", addr: "alpha/notes", chatTitle: "notes" };
const ownIconSide: StubAgent = { ...side, id: "/w/alpha::alpha/own", addr: "alpha/own", iconUrl: "data:image/png;base64,OWN" };
const other: StubAgent = { ...main, id: "/w/beta", name: "Beta", path: "/w/beta", addr: "beta" };
const projects = [
  project({ id: "p-alpha", name: "Alpha", path: "/w/alpha", handle: "alpha" }),
  project({ id: "p-notes", name: "notes", path: "/w/alpha", handle: "alpha/notes" }),
  project({ id: "p-beta", name: "Beta", path: "/w/beta", handle: "beta" }),
];

describe("iconTargetFor", () => {
  it("a main chat edits its own workspace", () => {
    expect(iconTargetFor(main, projects)).toEqual({ projectId: "p-alpha", path: "/w/alpha", name: "Alpha" });
  });

  it("a sidecar chat edits its parent workspace", () => {
    expect(iconTargetFor(side, projects)?.projectId).toBe("p-alpha");
  });

  it("no target for a group or an unknown workspace", () => {
    expect(iconTargetFor({ ...main, kind: "group" }, projects)).toBeNull();
    expect(iconTargetFor({ ...main, path: "/w/gone", addr: "gone" }, projects)).toBeNull();
  });
});

describe("withWorkspaceLook", () => {
  const next = { iconUrl: "data:image/png;base64,NEW", color: "#22c55e" };
  const before = workspaceLookOf([side, main], "/w/alpha");

  it("reads the look from the main row", () => {
    expect(before).toEqual({ iconUrl: null, color: "#3b82f6" });
  });

  it("moves the workspace and inheriting sidecars, not other rows", () => {
    const out = withWorkspaceLook([main, side, ownIconSide, other], "/w/alpha", before, next);
    expect(out[0]).toMatchObject(next);
    expect(out[1]).toMatchObject(next);
    expect(out[2].iconUrl).toBe("data:image/png;base64,OWN");
    expect(out[2].color).toBe("#22c55e");
    expect(out[3]).toBe(other);
  });

  it("rolls back symmetrically", () => {
    const rows = [main, side, other];
    const moved = withWorkspaceLook(rows, "/w/alpha", before, next);
    expect(withWorkspaceLook(moved, "/w/alpha", next, before)).toEqual(rows);
  });
});

describe("lookUpdateBody", () => {
  it("sends only what changed; removing sends an empty iconUrl", () => {
    const a = { iconUrl: "data:image/png;base64,A", color: "#3b82f6" };
    expect(lookUpdateBody(a, { ...a, iconUrl: "data:image/png;base64,B" })).toEqual({
      iconUrl: "data:image/png;base64,B",
    });
    expect(lookUpdateBody(a, { ...a, iconUrl: null })).toEqual({ iconUrl: "" });
    expect(lookUpdateBody(a, { ...a, color: "#ef4444" })).toEqual({ color: "#ef4444" });
    expect(lookUpdateBody(a, a)).toEqual({});
  });
});

describe("canChangeIcon", () => {
  it("member and up, or unknown, may change icons", () => {
    expect(canChangeIcon(null)).toBe(true);
    expect(canChangeIcon({ owner: true })).toBe(true);
    expect(canChangeIcon({ role: "member" })).toBe(true);
    expect(canChangeIcon({ role: "admin" })).toBe(true);
    expect(canChangeIcon({ role: "" })).toBe(true);
  });

  it("a known role below member may not", () => {
    expect(canChangeIcon({ role: "guest" })).toBe(false);
  });
});
