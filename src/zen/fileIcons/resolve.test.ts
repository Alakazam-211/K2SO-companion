import { describe, expect, it } from "vitest";
import { entryIcon, resolveSetiIcon, resolveSetiIconId } from "./resolve";
import { SETI_DEFAULT_ID, SETI_ICON_DEFS } from "./setiData";

describe("file icons (desktop K2's Seti mapping)", () => {
  it.each([
    ["app.ts", "_typescript"],
    ["App.tsx", "_react"],
    ["README.md", "_info"],
    ["notes.md", "_markdown"],
    ["data.json", "_json"],
    ["package.json", "_npm_1"],
    ["Dockerfile", "_docker"],
    ["Makefile", "_makefile"],
    ["shot.png", "_image"],
    ["main.rs", "_rust"],
    ["app.spec.ts", "_typescript_1"],
  ])("%s → %s", (name, id) => {
    expect(resolveSetiIconId(name)).toBe(id);
    expect(SETI_ICON_DEFS[id]).toBeDefined();
  });

  it("uses the basename of a path", () => {
    expect(resolveSetiIconId("/Users/Baden/Appa/src/package.json")).toBe("_npm_1");
  });

  it("unknown types fall back to the default glyph", () => {
    expect(resolveSetiIconId("mystery.zzzzunknown")).toBe(SETI_DEFAULT_ID);
    expect(resolveSetiIconId("LICENSEZ")).toBe(SETI_DEFAULT_ID);
    expect(resolveSetiIcon(undefined)).toEqual(SETI_ICON_DEFS[SETI_DEFAULT_ID]);
    expect(entryIcon("mystery.zzzzunknown")).toMatchObject({ kind: "file", id: SETI_DEFAULT_ID });
  });

  it("every mapped file gets a Seti code point and a colour", () => {
    const def = resolveSetiIcon("main.ts");
    expect(def.code).toBeGreaterThanOrEqual(0xe000);
    expect(def.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("folders use K2's folder, open or closed — no special folder icons on desktop", () => {
    for (const name of ["src", "node_modules", ".git", "test"]) {
      expect(entryIcon(name, true)).toEqual({ kind: "folder", open: false });
      expect(entryIcon(name, true, true)).toEqual({ kind: "folder", open: true });
    }
  });
});
