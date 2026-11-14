import { describe, expect, it } from "vitest";
import { chatterOffset, chatterPhase, chatterSettlesOpen } from "./chatterSwipe";

describe("chatterSwipe", () => {
  it("closed: a leftward drag tracks, rightward or vertical is rejected", () => {
    expect(chatterPhase("armed", -20, 2, false)).toBe("tracking");
    expect(chatterPhase("armed", 20, 2, false)).toBe("rejected");
    expect(chatterPhase("armed", -5, 30, false)).toBe("rejected");
    expect(chatterPhase("armed", -4, 2, false)).toBe("armed");
  });

  it("open: a rightward drag tracks, leftward is rejected", () => {
    expect(chatterPhase("armed", 20, 2, true)).toBe("tracking");
    expect(chatterPhase("armed", -20, 2, true)).toBe("rejected");
  });

  it("the panel stays between open and off screen", () => {
    expect(chatterOffset(-100, 400, false)).toBe(300);
    expect(chatterOffset(-600, 400, false)).toBe(0);
    expect(chatterOffset(50, 400, false)).toBe(400);
    expect(chatterOffset(100, 400, true)).toBe(100);
    expect(chatterOffset(-50, 400, true)).toBe(0);
  });

  it("settles past the fraction or on a flick; a flick back cancels", () => {
    expect(chatterSettlesOpen(-200, 0, 400, false)).toBe(true);
    expect(chatterSettlesOpen(-100, 0, 400, false)).toBe(false);
    expect(chatterSettlesOpen(-40, -0.8, 400, false)).toBe(true);
    expect(chatterSettlesOpen(-300, 0.8, 400, false)).toBe(false);
    expect(chatterSettlesOpen(200, 0, 400, true)).toBe(false);
    expect(chatterSettlesOpen(60, 0, 400, true)).toBe(true);
    expect(chatterSettlesOpen(40, 0.8, 400, true)).toBe(false);
  });
});
