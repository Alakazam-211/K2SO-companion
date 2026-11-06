import { describe, expect, it } from "vitest";
import {
  EASE_DURATION,
  easeOut,
  pickCorner,
  planSnap,
  project,
  releaseVelocity,
  REST,
  settleTime,
  SNAP_SPRING,
  springAt,
  type Corner,
  type Vec,
} from "./miniSnap";

// A 375×812 phone: the tile's centre in each corner.
const HOMES: Record<Corner, Vec> = {
  "top-left": { x: 72, y: 144 },
  "top-right": { x: 303, y: 144 },
  "bottom-left": { x: 72, y: 694 },
  "bottom-right": { x: 303, y: 694 },
};

describe("which corner a release goes to", () => {
  it("a slow release goes to the nearest corner", () => {
    expect(pickCorner({ x: 250, y: 200 }, { x: 0, y: 0 }, HOMES)).toBe("top-right");
    expect(pickCorner({ x: 150, y: 450 }, { x: -40, y: 30 }, HOMES)).toBe("bottom-left");
    expect(pickCorner({ x: 200, y: 400 }, { x: 60, y: -50 }, HOMES)).toBe("top-right");
  });

  it("a fling across the screen goes to the far corner", () => {
    // Barely moved from the top right, flung down and left.
    expect(pickCorner({ x: 280, y: 170 }, { x: -1500, y: 2500 }, HOMES)).toBe("bottom-left");
    // Straight down from the top right.
    expect(pickCorner({ x: 300, y: 170 }, { x: 0, y: 2400 }, HOMES)).toBe("bottom-right");
    // Dragged past the middle, then flung back: it goes back.
    expect(pickCorner({ x: 160, y: 450 }, { x: 1200, y: -2600 }, HOMES)).toBe("top-right");
  });

  it("coasts like a scroll view: about a quarter second of the velocity", () => {
    expect(project(1000)).toBeCloseTo(249, 0);
    expect(project(-400)).toBeCloseTo(-99.6, 1);
    expect(project(0)).toBe(0);
  });

  it("reads the finger's velocity from its last 100 ms", () => {
    const steady = Array.from({ length: 8 }, (_, i) => ({ t: i * 16, x: 100 + i * 10, y: 300 - i * 5 }));
    const v = releaseVelocity(steady);
    expect(v.x).toBeCloseTo(625, 0);
    expect(v.y).toBeCloseTo(-312.5, 0);
    // It stopped before letting go: no fling.
    expect(releaseVelocity([...steady, { t: 112 + 150, x: 170, y: 265 }])).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([{ t: 0, x: 1, y: 1 }])).toEqual({ x: 0, y: 0 });
    // Two events a moment apart are no velocity at all.
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 1, x: 50, y: 0 }])).toEqual({ x: 0, y: 0 });
  });
});

describe("the snap spring", () => {
  const derivative = (f: (t: number) => number, t: number) => (f(t + 1e-5) - f(Math.max(0, t - 1e-5))) / (t > 0 ? 2e-5 : 1e-5);

  it("is a damped spring: starts where let go, at the finger's velocity, and obeys m·x″ + c·x′ + k·x = 0", () => {
    for (const sp of [SNAP_SPRING, { mass: 1, stiffness: 100, damping: 20 }, { mass: 1, stiffness: 100, damping: 40 }]) {
      const f = (t: number) => springAt(sp, -200, 900, t);
      expect(f(0)).toBeCloseTo(-200, 6);
      expect(derivative(f, 0)).toBeCloseTo(900, 0);
      for (const t of [0.05, 0.13, 0.3]) {
        const h = 1e-4;
        const x = f(t);
        const v = (f(t + h) - f(t - h)) / (2 * h);
        const a = (f(t + h) - 2 * x + f(t - h)) / (h * h);
        expect(Math.abs(sp.mass * a + sp.damping * v + sp.stiffness * x)).toBeLessThan(0.5);
      }
    }
  });

  it("overshoots a little and is within a point of its corner by about 0.4 s", () => {
    let overshoot = 0;
    for (let t = 0; t < 1; t += 1 / 240) overshoot = Math.max(overshoot, springAt(SNAP_SPRING, -300, 0, t));
    expect(overshoot / 300).toBeGreaterThan(0.01);
    expect(overshoot / 300).toBeLessThan(0.06);
    expect(settleTime(SNAP_SPRING, -300, 0, 1)).toBeGreaterThan(0.35);
    expect(settleTime(SNAP_SPRING, -300, 0, 1)).toBeLessThan(0.45);
    for (let t = 0.45; t < 1.5; t += 0.01) expect(Math.abs(springAt(SNAP_SPRING, -300, 0, t))).toBeLessThan(1);
  });

  it("plans the same motion for the page and for Swift, carrying the velocity in", () => {
    const plan = planSnap({ x: 180, y: -400, s: 1.04 }, { x: -900, y: 1600 }, false);
    expect(plan.animate).toEqual({ duration: plan.duration, ...SNAP_SPRING, velocityX: -900, velocityY: 1600 });
    expect(plan.at(0)).toEqual({ x: 180, y: -400, s: 1.04 });
    expect(plan.at(plan.duration)).toEqual(REST);
    expect(plan.duration).toBeGreaterThan(0.35);
    expect(plan.duration).toBeLessThan(0.8);
    // Moving at the finger's speed at first.
    expect((plan.at(0.0002).y - plan.at(0).y) / 0.0002).toBeCloseTo(1600, -2);
    // Still within a fraction of a point when it hands over to REST.
    const end = plan.at(plan.duration - 0.001);
    expect(Math.hypot(end.x, end.y)).toBeLessThan(0.5);
    // Lands (the haptic) partway, once it reaches the corner.
    expect(plan.landAt).toBeGreaterThan(0.05);
    expect(plan.landAt).toBeLessThan(plan.duration);
  });

  it("an axis it hardly moves on carries no velocity (on either side)", () => {
    const plan = planSnap({ x: 0.2, y: -300, s: 1 }, { x: 800, y: 500 }, false);
    expect(plan.animate).toMatchObject({ velocityX: 0, velocityY: 500 });
    expect(Math.abs(plan.at(0.1).x)).toBeLessThan(0.3);
  });

  it("lands at once when let go right on its corner", () => {
    const plan = planSnap({ x: 0, y: 0, s: 1.04 }, { x: 0, y: 0 }, false);
    expect(plan.landAt).toBe(0);
    expect(plan.at(plan.duration)).toEqual(REST);
  });
});

describe("Reduce Motion", () => {
  it("eases out in a short fixed time: no spring, no overshoot, no velocity", () => {
    const plan = planSnap({ x: 180, y: -400, s: 1.04 }, { x: -3000, y: 3000 }, true);
    expect(plan.duration).toBe(EASE_DURATION);
    expect(plan.animate).toEqual({ duration: EASE_DURATION });
    expect(plan.landAt).toBe(EASE_DURATION);
    let prev = plan.at(0);
    expect(prev).toEqual({ x: 180, y: -400, s: 1.04 });
    for (let t = 0.01; t <= EASE_DURATION + 0.01; t += 0.01) {
      const p = plan.at(t);
      expect(p.x).toBeLessThanOrEqual(prev.x);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(prev.y);
      expect(p.y).toBeLessThanOrEqual(0);
      prev = p;
    }
    expect(plan.at(EASE_DURATION)).toEqual(REST);
  });

  it("uses Core Animation's ease-out curve, cubic-bezier(0, 0, 0.58, 1)", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    // The curve at bezier parameter 0.5: x = 0.3425, y = 0.5.
    expect(easeOut(0.3425)).toBeCloseTo(0.5, 4);
    let prev = 0;
    for (let u = 0.05; u < 1; u += 0.05) {
      expect(easeOut(u)).toBeGreaterThan(prev);
      expect(easeOut(u)).toBeGreaterThan(u);
      prev = easeOut(u);
    }
  });
});
