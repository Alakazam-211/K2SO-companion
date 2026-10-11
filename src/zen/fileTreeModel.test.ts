// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRef,
  fileRefText,
  renameSelection,
  treeEntries,
  validateEntryName,
} from "./fileTreeModel";
import { composerAt, useFileDrag } from "./fileDrag";
import { classifyHref, looksLikeFileRef, resolveFileRef } from "./chatLinks";

const WS = "/Users/Baden/Appa";
const e = (name: string, isDirectory = false) => ({ name, path: `${WS}/${name}`, isDirectory });

describe("treeEntries", () => {
  it("folders first, then files, A–Z; dotfiles and heavy folders only when shown", () => {
    const rows = [e("b.md"), e("node_modules", true), e("A.md"), e(".env"), e("src", true), e(".git", true), e("Docs", true)];
    expect(treeEntries(rows, false).map((r) => r.name)).toEqual(["Docs", "src", "A.md", "b.md"]);
    expect(treeEntries(rows, true).map((r) => r.name)).toEqual([
      ".git", "Docs", "node_modules", "src", ".env", "A.md", "b.md",
    ]);
  });
});

describe("validateEntryName", () => {
  it("refuses empty, slashes, dot names and duplicates (any case)", () => {
    expect(validateEntryName("", [])).toMatch(/Enter a name/);
    expect(validateEntryName("  ", [])).toMatch(/Enter a name/);
    expect(validateEntryName("a/b", [])).toMatch(/slashes/);
    expect(validateEntryName("a\\b", [])).toMatch(/slashes/);
    expect(validateEntryName("..", [])).toMatch(/reserved/);
    expect(validateEntryName("Notes", ["notes"])).toMatch(/already here/);
    expect(validateEntryName("fresh", ["notes"])).toBeNull();
  });

  it("a rename may change only the case of its own name", () => {
    expect(validateEntryName("plan.md", ["plan.md"], { current: "plan.md" })).toMatch(/current name/);
    expect(validateEntryName("Plan.md", ["plan.md"], { current: "plan.md" })).toBeNull();
  });

  it("selects the stem of a file, all of a folder", () => {
    expect(renameSelection("report.final.pdf", false)).toEqual([0, 12]);
    expect(renameSelection(".env", false)).toEqual([0, 4]);
    expect(renameSelection("src.v2", true)).toEqual([0, 6]);
  });
});

describe("fileRefText (what a drop inserts)", () => {
  it("is the workspace-relative path in backticks, which chat renders as a file link", () => {
    const ref = fileRefText(`${WS}/src/zen/FilePane.tsx`, WS);
    expect(ref).toBe("`src/zen/FilePane.tsx`");
    const inner = ref.slice(1, -1);
    expect(looksLikeFileRef(inner)).toBe(true);
    expect(resolveFileRef(inner, WS)).toBe(`${WS}/src/zen/FilePane.tsx`);
  });

  it("outside the workspace it is the absolute path", () => {
    expect(fileRefText("/Users/Baden/Other/x.md", WS)).toBe("`/Users/Baden/Other/x.md`");
  });

  it("a path with spaces is a markdown link the link renderer decodes", () => {
    const ref = fileRefText(`${WS}/My Notes/plan v2.md`, WS);
    expect(ref).toBe("[plan v2.md](My%20Notes/plan%20v2.md)");
    const href = ref.slice(ref.indexOf("(") + 1, -1);
    expect(classifyHref(href)).toBe("file");
    expect(resolveFileRef(href, WS)).toBe(`${WS}/My Notes/plan v2.md`);
  });

  it("appends to the draft as its own word", () => {
    expect(appendRef("", "`a.md`")).toBe("`a.md` ");
    expect(appendRef("see", "`a.md`")).toBe("see `a.md` ");
    expect(appendRef("see ", "`a.md`")).toBe("see `a.md` ");
  });
});

describe("fileDrag", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useFileDrag.setState({ drag: null, overComposer: false, pendingInsert: null });
  });

  it("drops on the composer rect queue an insert; elsewhere cancels", () => {
    const field = document.createElement("div");
    field.setAttribute("data-k2-drop", "composer");
    field.getBoundingClientRect = () =>
      ({ left: 0, top: 500, right: 300, bottom: 540, width: 300, height: 40 }) as DOMRect;
    document.body.appendChild(field);
    expect(composerAt(10, 520)).toBe(true);
    expect(composerAt(10, 100)).toBe(false);
    const s = useFileDrag.getState();
    s.begin({ path: `${WS}/a.md`, name: "a.md", ref: "`a.md`", x: 10, y: 100 });
    expect(useFileDrag.getState().end(10, 100)).toBe(false);
    expect(useFileDrag.getState().pendingInsert).toBeNull();
    s.begin({ path: `${WS}/a.md`, name: "a.md", ref: "`a.md`", x: 10, y: 100 });
    useFileDrag.getState().move(10, 520);
    expect(useFileDrag.getState().overComposer).toBe(true);
    expect(useFileDrag.getState().end(10, 520)).toBe(true);
    expect(useFileDrag.getState().pendingInsert?.text).toBe("`a.md`");
    expect(useFileDrag.getState().drag).toBeNull();
  });
});
