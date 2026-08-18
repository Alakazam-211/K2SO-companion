import { describe, expect, it } from "vitest";

import { ptyInputFrames } from "./ptyInput";

describe("ptyInputFrames", () => {
  it("drops empty text (never a lone set_mode)", () => {
    expect(ptyInputFrames("", false)).toEqual([]);
    expect(ptyInputFrames("", true)).toEqual([]);
  });

  it("Watch first keystroke flips claimer then writes — no set_active", () => {
    expect(ptyInputFrames("\x1b", false)).toEqual([
      { action: "set_mode", mode: "claimer" },
      { action: "input", text: "\x1b" },
    ]);
    expect(ptyInputFrames("\x1b\r", false)).toEqual([
      { action: "set_mode", mode: "claimer" },
      { action: "input", text: "\x1b\r" },
    ]);
    expect(JSON.stringify(ptyInputFrames("a", false))).not.toContain(
      "set_active",
    );
  });

  it("already-claimer (Drive or a prior key) is input only", () => {
    expect(ptyInputFrames("hi", true)).toEqual([{ action: "input", text: "hi" }]);
    expect(ptyInputFrames("\x03", true)).toEqual([
      { action: "input", text: "\x03" },
    ]);
  });
});
