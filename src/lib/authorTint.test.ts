import { describe, expect, it } from "vitest";
import { authorHue, authorTint } from "./authorTint";

describe("authorHue", () => {
  it("is stable for the same key", () => {
    expect(authorHue("scout")).toBe(authorHue("scout"));
  });
  it("differs across authors", () => {
    expect(authorHue("scout")).not.toBe(authorHue("julie"));
  });
});

describe("authorTint", () => {
  it("mine uses the accent wash, others a hashed hue", () => {
    const mine = authorTint("julie", true);
    expect(mine.background).toContain("--accent");
    const theirs = authorTint("scout", false);
    expect(theirs.background).toMatch(/^hsla\(/);
    expect(theirs.background).not.toBe(authorTint("julie", false).background);
  });
});
