import { describe, expect, it } from "vitest";
import {
  COMPLETE_FRACTION,
  FLICK_MIN_DX_PX,
  FLICK_VELOCITY_PX_PER_MS,
  RELEASE_MAX_MS,
  RELEASE_MIN_MS,
  UNDERLAY_MIN_OPACITY,
  UNDERLAY_PARALLAX,
  releaseAnimation,
  shouldComplete,
  underlayFrame,
} from "./swipeBack";

const W = 390;

describe("shouldComplete", () => {
  it("completes past the distance threshold on a still release", () => {
    expect(shouldComplete(W * COMPLETE_FRACTION, 0, W)).toBe(true);
    expect(shouldComplete(W * COMPLETE_FRACTION - 1, 0, W)).toBe(false);
  });

  it("completes an early release on a rightward flick", () => {
    expect(shouldComplete(FLICK_MIN_DX_PX + 10, FLICK_VELOCITY_PX_PER_MS, W)).toBe(true);
    expect(shouldComplete(FLICK_MIN_DX_PX + 10, FLICK_VELOCITY_PX_PER_MS - 0.1, W)).toBe(false);
  });

  it("cancels a fast leftward flick even past the threshold", () => {
    expect(shouldComplete(W * 0.8, -FLICK_VELOCITY_PX_PER_MS, W)).toBe(false);
    expect(shouldComplete(W * 0.8, -0.2, W)).toBe(true);
  });
});

describe("releaseAnimation", () => {
  it("is remaining distance over speed, clamped", () => {
    // 200px at 1 px/ms (the floor) → 200ms.
    expect(releaseAnimation(190, 390, 0).durationMs).toBe(200);
    // A fast flick finishes at the floor.
    expect(releaseAnimation(100, 390, 5).durationMs).toBe(RELEASE_MIN_MS);
    // A long, slow remainder caps.
    expect(releaseAnimation(0, 1024, 0).durationMs).toBe(RELEASE_MAX_MS);
    // Cancel from a short drag: min duration.
    expect(releaseAnimation(60, 0, 0).durationMs).toBe(RELEASE_MIN_MS);
  });

  it("starts the curve at the finger's speed toward the target", () => {
    // 2 px/ms over 290px in 180ms → normalised slope 2*180/290 ≈ 1.24.
    const fast = releaseAnimation(100, 390, 2);
    expect(fast.easing).toBe("cubic-bezier(0.25, 0.31, 0.25, 1)");
    // Still finger: linear start, ease-out tail.
    expect(releaseAnimation(100, 390, 0).easing).toBe("cubic-bezier(0.25, 0.25, 0.25, 1)");
    // Moving away from the target (cancel while moving right) is not a boost.
    expect(releaseAnimation(100, 0, 2).easing).toBe("cubic-bezier(0.25, 0.25, 0.25, 1)");
    // Very fast: slope capped (no overshoot past the end).
    expect(releaseAnimation(300, 390, 10).easing).toBe("cubic-bezier(0.25, 1, 0.25, 1)");
  });
});

describe("underlayFrame", () => {
  it("parallax + dim at rest, none once the screen has left", () => {
    expect(underlayFrame(0, W)).toEqual({ x: -UNDERLAY_PARALLAX * W, opacity: UNDERLAY_MIN_OPACITY });
    expect(underlayFrame(W, W)).toEqual({ x: 0, opacity: 1 });
    expect(underlayFrame(W / 2, W)).toEqual({
      x: -UNDERLAY_PARALLAX * W * 0.5,
      opacity: (UNDERLAY_MIN_OPACITY + 1) / 2,
    });
  });
});
