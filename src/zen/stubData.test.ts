import { describe, expect, it } from "vitest";
import { STUB_AGENTS, STUB_FILES, STUB_THREAD, STUB_THREAD_FALLBACK } from "./stubData";

const FLEET = ["k2", "appa", "companion"];
const REALISH_FILES = ["AGENT.md", "Home.md", "notes.txt"];

describe("stub catalog cannot pass as live", () => {
  it("agent ids and names are marked STUB and are not fleet handles", () => {
    for (const a of STUB_AGENTS) {
      expect(a.id).toMatch(/^stub-/);
      expect(a.name).toMatch(/\[STUB\]/);
      expect(FLEET).not.toContain(a.id);
      expect(FLEET).not.toContain(a.name);
    }
  });

  it("file names are marked STUB and are not real workspace files", () => {
    for (const f of STUB_FILES) {
      expect(f.name).toMatch(/\[STUB\]/);
      expect(REALISH_FILES).not.toContain(f.name);
    }
  });

  it("thread has no user-authored You line", () => {
    const authors = [
      ...Object.values(STUB_THREAD).flatMap((msgs) => msgs.map((m) => m.author)),
      ...STUB_THREAD_FALLBACK.map((m) => m.author),
    ];
    expect(authors.some((a) => a === "You" || a.toLowerCase() === "you")).toBe(false);
    expect(authors.every((a) => a.includes("STUB"))).toBe(true);
    expect(Object.values(STUB_THREAD).flat().every((m) => m.mine === false)).toBe(true);
  });
});
