// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INCOMING_MS,
  arrivedRows,
  createListGlider,
  cubicBezierProgress,
  curveProgress,
  drawerMotion,
  incomingMotion,
} from "./listGlide";

type FakeAnim = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };

function harness() {
  let clock = 0;
  const el = document.createElement("div");
  const calls: { frames: Keyframe[]; timing: KeyframeAnimationOptions; anim: FakeAnim }[] = [];
  el.animate = vi.fn((frames: Keyframe[], timing: KeyframeAnimationOptions) => {
    const anim: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
    calls.push({ frames, timing, anim });
    return anim;
  }) as never;
  const g = createListGlider(() => el, () => clock);
  return { el, calls, g, at: (t: number) => void (clock = t) };
}

const y = (k: Keyframe) => parseFloat(/, ([-\d.]+)px, 0px\)/.exec(String(k.transform))![1]);

afterEach(() => vi.restoreAllMocks());

describe("curves", () => {
  it("cubic-bezier: exact ends, the CSS shapes", () => {
    expect(cubicBezierProgress(0.2, 0.9, 0.3, 1, 0)).toBe(0);
    expect(cubicBezierProgress(0.2, 0.9, 0.3, 1, 1)).toBe(1);
    expect(cubicBezierProgress(0, 0, 1, 1, 0.37)).toBeCloseTo(0.37, 3);
    // An ease-out is well ahead at the middle.
    expect(cubicBezierProgress(0.2, 0.9, 0.3, 1, 0.5)).toBeGreaterThan(0.85);
  });

  it("arrivals ride the send's spring, shorter; the drawer its own ease", () => {
    expect(incomingMotion()).toMatchObject({ ms: INCOMING_MS, easing: "spring" });
    expect(curveProgress(incomingMotion(), 0.5)).toBeGreaterThan(0.8);
    expect(curveProgress(drawerMotion(), 0.5)).toBeCloseTo(cubicBezierProgress(0.2, 0.9, 0.3, 1, 0.5), 5);
  });
});

describe("the glider", () => {
  it("draws the list where it was and glides it home; will-change only while it runs", () => {
    const { el, calls, g } = harness();
    g.shift(100);
    expect(calls).toHaveLength(1);
    expect(y(calls[0].frames[0])).toBe(100);
    expect(y(calls[0].frames[calls[0].frames.length - 1])).toBe(0);
    expect(g.offset()).toBe(100);
    expect(el.style.willChange).toBe("transform");
    calls[0].anim.onfinish?.();
    expect(el.style.willChange).toBe("");
  });

  it("a hold keeps it still (the first frame fills through the delay), then a shift folds in from there", () => {
    const { calls, g, at } = harness();
    g.shift(-18, { motion: drawerMotion(), holdMs: 300 });
    expect(calls[0].timing).toMatchObject({ delay: 300, fill: "backwards" });
    at(200);
    expect(g.holding()).toBe(true);
    expect(g.moving()).toBe(false);
    expect(g.offset()).toBe(-18);
    g.shift(100);
    expect(calls[0].anim.cancel).toHaveBeenCalled();
    expect(y(calls[1].frames[0])).toBe(82);
    expect(calls[1].timing.delay).toBe(0);
  });

  it("a small change mid-glide rides the curve (same clock, rescaled); a big one restarts", () => {
    const { calls, g, at } = harness();
    g.shift(100);
    at(40);
    const before = g.offset();
    g.shift(-18);
    const ride = calls[1];
    expect(ride.timing.delay).toBe(-40);
    // Continuous: drawn exactly where it was, plus the change.
    expect(g.offset()).toBeCloseTo(before - 18, 5);
    at(60);
    g.shift(300); // bigger than what is left: from rest
    expect(calls[2].timing.delay).toBe(0);
    expect(y(calls[2].frames[0])).toBeCloseTo(g.offset(), 1);
  });

  it("nothing to move: no animation; cancel snaps home", () => {
    const { el, calls, g } = harness();
    g.shift(0.2);
    expect(calls).toHaveLength(0);
    g.shift(50);
    g.cancel();
    expect(calls[0].anim.cancel).toHaveBeenCalled();
    expect(g.offset()).toBe(0);
    expect(el.style.willChange).toBe("");
  });

  it("no Web Animations: a no-op", () => {
    const el = document.createElement("div");
    const g = createListGlider(() => el);
    expect(() => g.shift(40)).not.toThrow();
    expect(g.offset()).toBe(0);
  });
});

describe("arrivedRows", () => {
  const r = (key: string, own = false) => ({ key, own });
  it("new rows after the first known one, not our own; prepends are history", () => {
    const before = new Set(["a", "b", "o1"]);
    expect(arrivedRows([r("z"), r("a"), r("b"), r("c"), r("o1", true), r("o2", true)], before).map((x) => x.key)).toEqual([
      "c",
    ]);
    // An arrival lands above our still-sending row: still an arrival.
    expect(arrivedRows([r("a"), r("b"), r("d"), r("o1", true)], before).map((x) => x.key)).toEqual(["d"]);
    expect(arrivedRows([r("x")], new Set())).toEqual([]);
  });
});
