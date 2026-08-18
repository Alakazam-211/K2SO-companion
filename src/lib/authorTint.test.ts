import { describe, expect, it } from "vitest";
import { authorHue, authorTint } from "./authorTint";

describe("authorHue", () => {
  it("is stable for the same key", () => {
    expect(authorHue("scribe")).toBe(authorHue("scribe"));
  });
  it("differs across authors", () => {
    expect(authorHue("scribe")).not.toBe(authorHue("jane"));
  });
});

describe("authorTint", () => {
  it("mine uses the accent wash, others a hashed hue", () => {
    const mine = authorTint("jane", true);
    expect(mine.background).toContain("--accent");
    const theirs = authorTint("scribe", false);
    expect(theirs.background).toMatch(/^hsla\(/);
    expect(theirs.background).not.toBe(authorTint("jane", false).background);
  });
});
