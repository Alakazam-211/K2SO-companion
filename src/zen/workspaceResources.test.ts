import { describe, expect, it } from "vitest";
import { parseWorkspaceResources, resourceHint } from "./workspaceResources";

const WS = "/Users/z3thon/DevProjects/Alakazam Labs/K2SO-companion";

describe("resourceHint", () => {
  it("is the folder relative to the workspace", () => {
    expect(resourceHint(`${WS}/docs/ios-keyboard-layout.md`, WS)).toBe("docs");
    expect(resourceHint(`${WS}/a/b/c.md`, WS)).toBe("a/b");
  });

  it("is null at the workspace root", () => {
    expect(resourceHint(`${WS}/AGENTS.md`, WS)).toBeNull();
  });

  it("is the absolute folder for a file outside the workspace", () => {
    expect(resourceHint("/Users/z3thon/notes/brief.md", WS)).toBe("/Users/z3thon/notes");
  });
});

describe("parseWorkspaceResources", () => {
  it("maps the live K2 0.45 answer", () => {
    const rows = parseWorkspaceResources(
      {
        ok: true,
        workspaceId: "5333cb83-0290-4719-a67c-f2627fc1026c",
        docs: [
          {
            addedAt: 1791702163,
            fileName: "ios-keyboard-layout.md",
            filePath: `${WS}/docs/ios-keyboard-layout.md`,
            missing: false,
          },
        ],
      },
      WS
    );
    expect(rows).toEqual([
      {
        id: `${WS}/docs/ios-keyboard-layout.md`,
        name: "ios-keyboard-layout.md",
        body: "",
        hint: "docs",
        missing: false,
      },
    ]);
  });

  it("keeps missing docs, drops unusable paths and duplicates", () => {
    const rows = parseWorkspaceResources(
      {
        docs: [
          { filePath: `${WS}/gone.md`, fileName: "gone.md", missing: true },
          { filePath: "relative.md", fileName: "relative.md" },
          { filePath: "/", fileName: "root" },
          { filePath: `${WS}/gone.md`, fileName: "gone.md" },
          { filePath: `${WS}/x/noname.txt` },
          null,
        ],
      },
      WS
    );
    expect(rows?.map((r) => [r.name, r.missing])).toEqual([
      ["gone.md", true],
      ["noname.txt", false],
    ]);
  });

  it("is null when the body has no docs array", () => {
    expect(parseWorkspaceResources([], WS)).toBeNull();
    expect(parseWorkspaceResources({ ok: false }, WS)).toBeNull();
    expect(parseWorkspaceResources(undefined, WS)).toBeNull();
  });
});
