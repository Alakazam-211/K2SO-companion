// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  findOccurrences,
  findThreadMatches,
  markdownSearchText,
  searchRanges,
  stepMatchIndex,
  threadSearchStatus,
} from "./threadSearch";

describe("thread search (K2's rules)", () => {
  it("searches Markdown as it reads: marks and link targets gone, code spans kept, fences out", () => {
    const text = markdownSearchText("**Bold** [docs](https://x.example/secret) and `code`\n```\nfenced\n```");
    expect(text).toContain("Bold docs and code");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("**");
  });

  it("matches without case, never overlapping", () => {
    expect(findOccurrences("Aaaa", "aa")).toEqual([0, 2]);
    expect(findOccurrences("abc", "   ")).toEqual([]);
  });

  it("numbers from the newest, and steps older with wrap", () => {
    const m = findThreadMatches(
      [
        { id: "old", text: "deploy" },
        { id: "new", text: "deploy then deploy" },
      ],
      "deploy"
    );
    expect(m.map((x) => `${x.id}:${x.n}`)).toEqual(["new:1", "new:0", "old:0"]);
    expect(stepMatchIndex(0, 3, 1)).toBe(1);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(threadSearchStatus({ query: "x", index: 0, total: 3, searching: true }).text).toBe("1 of 3+");
    expect(threadSearchStatus({ query: "x", index: -1, total: 0, searching: false }).text).toBe("No matches");
  });

  it("finds ranges in the drawn text without touching it", () => {
    const div = document.createElement("div");
    div.innerHTML = "<p>Ship <strong>it</strong> today, ship it</p>";
    const before = div.innerHTML;
    const r = searchRanges([div], "ship it");
    expect(r.map((x) => x.toString())).toEqual(["Ship it", "ship it"]);
    expect(div.innerHTML).toBe(before);
  });
});
