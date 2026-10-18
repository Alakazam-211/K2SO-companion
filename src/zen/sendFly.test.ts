// @vitest-environment jsdom
// The send flight's motion: one tunable curve shared by the bubble, the
// list glide and the composer collapse; the DEV-only override; no jolt
// leaving the composer and no overshoot landing.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FLY_MOTION,
  FLY_BLUE_AT,
  FLY_EASING,
  FLY_MS,
  SEND_FLY_DEBUG_KEY,
  alongCurve,
  curveEasing,
  flyMotion,
  glideList,
  springDamping,
  springProgress,
} from "./sendFly";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the curve", () => {
  it("defaults: a calm ~half-second spring, blue in by a quarter", () => {
    expect(flyMotion()).toEqual({ ms: FLY_MS, easing: FLY_EASING, blueAt: FLY_BLUE_AT, collapse: true });
    expect(FLY_MS).toBeGreaterThanOrEqual(450);
    expect(FLY_MS).toBeLessThanOrEqual(520);
  });

  it("a spring from rest: exact ends, monotonic (no overshoot), a gentle first frame", () => {
    expect(springProgress(0)).toBe(0);
    expect(springProgress(1)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const p = springProgress(i / 100);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
    // First 60fps frame of a 480ms flight: a few percent, not a jump
    // (the old overshoot bezier moved ~15% there).
    expect(springProgress(16.7 / FLY_MS)).toBeLessThan(0.06);
    // Mostly there by the middle, the rest is a calm settle.
    expect(springProgress(0.5)).toBeGreaterThan(0.85);
  });

  it("spring is baked into ~one keyframe per frame (linear between); a CSS easing is two ends", () => {
    const frames = alongCurve(DEFAULT_FLY_MOTION, (p) => ({ opacity: p }));
    expect(frames.length).toBeGreaterThanOrEqual(25);
    expect(frames[0]).toEqual({ opacity: 0, offset: 0 });
    expect(frames[frames.length - 1]).toEqual({ opacity: 1, offset: 1 });
    expect(curveEasing(DEFAULT_FLY_MOTION)).toBe("linear");
    const bez = { ...DEFAULT_FLY_MOTION, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    expect(alongCurve(bez, (p) => ({ opacity: p }))).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(curveEasing(bez)).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(springDamping("spring(0.8)")).toBe(0.8);
    expect(springDamping("ease-out")).toBeNull();
  });

  it("the list glide rides the same curve and holds will-change only while it runs", () => {
    const content = document.createElement("div");
    const anim = { onfinish: null as null | (() => void), oncancel: null, cancel: vi.fn() };
    const animate = vi.fn(() => anim);
    content.animate = animate as never;
    glideList(content, 60, DEFAULT_FLY_MOTION);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[0].transform).toBe("translate3d(0px, 60px, 0px)");
    expect(timing).toEqual({ duration: FLY_MS, easing: "linear" });
    expect(content.style.willChange).toBe("transform");
    anim.onfinish?.();
    expect(content.style.willChange).toBe("");
    // Less than a pixel: nothing to glide.
    animate.mockClear();
    glideList(content, 0.4, DEFAULT_FLY_MOTION);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("DEV tuning override (k2.debug.sendFly)", () => {
  it("applies in a DEV build, read on every send", () => {
    vi.stubEnv("DEV", true);
    localStorage.setItem(
      SEND_FLY_DEBUG_KEY,
      JSON.stringify({ ms: 600, easing: "cubic-bezier(0.22, 1, 0.36, 1)", blueAt: 0.3, collapse: false })
    );
    expect(flyMotion()).toEqual({
      ms: 600,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      blueAt: 0.3,
      collapse: false,
    });
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ ms: 420 }));
    expect(flyMotion()).toEqual({ ...DEFAULT_FLY_MOTION, ms: 420 });
  });

  it("is ignored in a production build", () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ ms: 900, easing: "linear", blueAt: 0.9 }));
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
  });

  it("bad JSON, out-of-range values or a throwing storage fall back to the defaults", () => {
    vi.stubEnv("DEV", true);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, "{nope");
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
    localStorage.setItem(SEND_FLY_DEBUG_KEY, JSON.stringify({ ms: 5, blueAt: 3, easing: 7 }));
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(flyMotion()).toEqual(DEFAULT_FLY_MOTION);
  });
});
