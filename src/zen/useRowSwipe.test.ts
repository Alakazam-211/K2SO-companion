import { describe, expect, it } from "vitest";
import { SWIPE_OPEN_PX, swipeRelease, swipeReveal } from "./useRowSwipe";

describe("swipeReveal", () => {
  it("fades and scales the glass pin in up to the open threshold", () => {
    expect(swipeReveal(0, false)).toEqual({ opacity: 0, scale: 0.6 });
    expect(swipeReveal(SWIPE_OPEN_PX / 2, false)).toEqual({ opacity: 0.5, scale: 0.8 });
    expect(swipeReveal(SWIPE_OPEN_PX, false)).toEqual({ opacity: 1, scale: 1 });
    expect(swipeReveal(400, false)).toEqual({ opacity: 1, scale: 1 });
  });

  it("reduced motion only fades, never scales", () => {
    expect(swipeReveal(0, true)).toEqual({ opacity: 0, scale: 1 });
    expect(swipeReveal(SWIPE_OPEN_PX / 2, true)).toEqual({ opacity: 0.5, scale: 1 });
  });
});

describe("swipeRelease", () => {
  it("closes, opens, or runs the action by distance", () => {
    expect(swipeRelease(20, 375)).toBe("close");
    expect(swipeRelease(SWIPE_OPEN_PX, 375)).toBe("open");
    expect(swipeRelease(200, 375)).toBe("full");
  });
});
