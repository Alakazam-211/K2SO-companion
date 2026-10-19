// The render window's growth rule (threadWindow.ts): open at WINDOW_ROWS,
// grow WINDOW_EXTEND at a time, never more than WINDOW_MAX_ROWS drawn —
// the far end gives way, but never a row on screen.
import { describe, expect, it } from "vitest";
import { WINDOW_EXTEND, WINDOW_MAX_ROWS, WINDOW_ROWS, growWindow } from "./threadWindow";

const none = (len: number) => ({ lo: len, hi: 0 });

describe("growWindow", () => {
  it("the two knobs: open at 30, at most 50", () => {
    expect(WINDOW_ROWS).toBe(30);
    expect(WINDOW_MAX_ROWS).toBe(50);
  });

  it("up from the opening window: grows to the cap, nothing leaves", () => {
    const r = growWindow({ lo: 170, hi: 200 }, 200, "top", none(200));
    expect(r).toEqual({ lo: 170 - WINDOW_EXTEND, hi: 200 });
    expect(r.hi - r.lo).toBe(WINDOW_MAX_ROWS);
  });

  it("up past the cap: rows at the bottom leave", () => {
    const r = growWindow({ lo: 150, hi: 200 }, 200, "top", none(200));
    expect(r).toEqual({ lo: 150 - WINDOW_EXTEND, hi: 150 - WINDOW_EXTEND + WINDOW_MAX_ROWS });
  });

  it("down past the cap: rows at the top leave", () => {
    const r = growWindow({ lo: 100, hi: 150 }, 200, "bottom", none(200));
    expect(r).toEqual({ lo: 150 + WINDOW_EXTEND - WINDOW_MAX_ROWS, hi: 150 + WINDOW_EXTEND });
  });

  it("a row on screen never leaves (the cap gives way)", () => {
    expect(growWindow({ lo: 150, hi: 200 }, 200, "top", { lo: 160, hi: 195 })).toEqual({
      lo: 130,
      hi: 195,
    });
    expect(growWindow({ lo: 100, hi: 150 }, 200, "bottom", { lo: 105, hi: 140 })).toEqual({
      lo: 105,
      hi: 170,
    });
  });

  it("nothing past an edge: unchanged", () => {
    const top = { lo: 0, hi: 50 };
    expect(growWindow(top, 200, "top", none(200))).toBe(top);
    const bottom = { lo: 150, hi: 200 };
    expect(growWindow(bottom, 200, "bottom", none(200))).toBe(bottom);
  });
});
