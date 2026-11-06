import type { TileAnimation } from "./videoTile";

// The mini video tile's motion, as plain maths (videoLayer's `Mini` runs it):
//   - let go, it goes to the corner its centre would coast to: the release
//     point projected by the finger's velocity (FaceTime's PiP, after
//     Apple's "Designing Fluid Interfaces": a fling crosses the screen, a
//     slow release stays near);
//   - it gets there on a spring that carries the finger's velocity in and
//     overshoots a little, settling in about 0.4 s;
//   - with Reduce Motion, a plain short ease-out instead.
// The page runs this spring on its tile in JS; Swift runs the very same one
// on the native video layer (CASpringAnimation with these mass, stiffness
// and damping: `pipFrame`'s `animate`), so the two never drift apart.

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const CORNERS: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export type Vec = { x: number; y: number };

/** Where the tile is drawn: its offset from its corner's spot, and scale. */
export type Pose = { x: number; y: number; s: number };
export const REST: Pose = { x: 0, y: 0, s: 1 };

export type Spring = { mass: number; stiffness: number; damping: number };

/** Damping ratio 0.75 (about 3% overshoot), within a point of its corner
 *  about 0.4 s after a typical release. */
export const SNAP_SPRING: Spring = { mass: 1, stiffness: 400, damping: 30 };
/** Reduce Motion: this long, ease-out, no overshoot. */
export const EASE_DURATION = 0.22;
/** Picked up: this much bigger, over LIFT_DURATION. */
export const LIFT_SCALE = 1.04;
export const LIFT_DURATION = 0.15;
/** How far a release coasts: UIScrollView-style deceleration per ms. */
export const PROJECT_RATE = 0.996;
/** The most velocity (points/s, each axis) carried into the spring. */
const MAX_VELOCITY = 4000;
/** The spring stops once it's this close (points): the rest is invisible. */
const SETTLE_TOLERANCE = 0.25;
const STEP = 1 / 240;

/** How far a release at `v` points/s coasts before it stops. */
export function project(v: number, rate = PROJECT_RATE): number {
  return ((v / 1000) * rate) / (1 - rate);
}

/** The corner a tile let go at `center` with `velocity` goes to: the one
 *  whose spot (`homes`: each corner's tile centre) is nearest to where it
 *  would coast. */
export function pickCorner(center: Vec, velocity: Vec, homes: Record<Corner, Vec>): Corner {
  const px = center.x + project(velocity.x);
  const py = center.y + project(velocity.y);
  let best: Corner = CORNERS[0];
  let bestD = Infinity;
  for (const c of CORNERS) {
    const d = Math.hypot(homes[c].x - px, homes[c].y - py);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export type Sample = { t: number; x: number; y: number };

/** The finger's velocity (points/s) from its last positions (`t` in ms,
 *  the release last): over the last 100 ms, nothing if it had stopped. */
export function releaseVelocity(samples: Sample[]): Vec {
  const n = samples.length;
  if (n < 2) return { x: 0, y: 0 };
  const last = samples[n - 1];
  let i = n - 1;
  while (i > 0 && last.t - samples[i - 1].t <= 100) i--;
  // Too short a span is noise: reach back a little further.
  while (i > 0 && last.t - samples[i].t < 16 && last.t - samples[i - 1].t <= 200) i--;
  const first = samples[i];
  const dt = (last.t - first.t) / 1000;
  if (dt < 0.004) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/** A damped spring's displacement from its target `t` s after it was let
 *  go `d0` away at `v0` (units/s). What CASpringAnimation computes. */
export function springAt(sp: Spring, d0: number, v0: number, t: number): number {
  const w0 = Math.sqrt(sp.stiffness / sp.mass);
  const zeta = sp.damping / (2 * Math.sqrt(sp.stiffness * sp.mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const b = (v0 + zeta * w0 * d0) / wd;
    return Math.exp(-zeta * w0 * t) * (d0 * Math.cos(wd * t) + b * Math.sin(wd * t));
  }
  if (zeta === 1) return (d0 + (v0 + w0 * d0) * t) * Math.exp(-w0 * t);
  const r = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - r);
  const r2 = -w0 * (zeta + r);
  const c2 = (v0 - r1 * d0) / (r2 - r1);
  return (d0 - c2) * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
}

/** When the spring is within SETTLE_TOLERANCE for good (s, up to 1.5). */
export function settleTime(sp: Spring, d0: number, v0: number, tolerance = SETTLE_TOLERANCE): number {
  let last = 0;
  for (let i = 1; i <= 360; i++) {
    const t = i * STEP;
    if (Math.abs(springAt(sp, d0, v0, t)) > tolerance) last = t;
  }
  return last > 0 ? last + STEP : 0;
}

/** CSS / Core Animation `ease-out`: cubic-bezier(0, 0, 0.58, 1). */
export function easeOut(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let s = u;
  for (let i = 0; i < 40; i++) {
    s = (lo + hi) / 2;
    const x = 3 * (1 - s) * s * s * 0.58 + s * s * s;
    if (x < u) lo = s;
    else hi = s;
  }
  return 3 * (1 - s) * s * s + s * s * s;
}

export type SnapPlan = {
  /** Seconds, the same on both sides. */
  duration: number;
  /** When it first reaches its corner (the haptic): crosses it, or ends. */
  landAt: number;
  /** `pipFrame`'s `animate`, for Swift to run the same motion. */
  animate: TileAnimation;
  /** The pose `t` s in (REST from `duration` on). */
  at(t: number): Pose;
};

const clampVelocity = (v: number) => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));

/** From `from` (offsets from the new corner's spot) home: a spring carrying
 *  `velocity` in, or with Reduce Motion an ease-out that carries nothing. */
export function planSnap(from: Pose, velocity: Vec, reduceMotion: boolean): SnapPlan {
  if (reduceMotion) {
    const duration = EASE_DURATION;
    return {
      duration,
      landAt: duration,
      animate: { duration },
      at(t) {
        if (t >= duration) return REST;
        const k = 1 - easeOut(Math.max(0, t) / duration);
        return { x: from.x * k, y: from.y * k, s: 1 + (from.s - 1) * k };
      },
    };
  }
  const sp = SNAP_SPRING;
  // An axis it hardly moves on can't carry velocity (Core Animation's
  // spring velocity is relative to the distance), on either side.
  const vx = Math.abs(from.x) < 0.5 ? 0 : clampVelocity(velocity.x);
  const vy = Math.abs(from.y) < 0.5 ? 0 : clampVelocity(velocity.y);
  // Scale settles in points too (about the tile's width).
  const settle = Math.max(
    settleTime(sp, from.x, vx),
    settleTime(sp, from.y, vy),
    settleTime(sp, (from.s - 1) * 200, 0)
  );
  const duration = Math.round(Math.min(1.2, Math.max(0.25, settle)) * 1000) / 1000;
  const pose = (t: number): Pose => ({
    x: springAt(sp, from.x, vx, t),
    y: springAt(sp, from.y, vy, t),
    s: 1 + springAt(sp, from.s - 1, 0, t),
  });
  let landAt = duration;
  const start = from.x * from.x + from.y * from.y;
  if (start < 1) landAt = 0;
  else {
    for (let t = STEP; t < duration; t += STEP) {
      const p = pose(t);
      if (p.x * from.x + p.y * from.y <= 0 || Math.hypot(p.x, p.y) < 1) {
        landAt = t;
        break;
      }
    }
  }
  return {
    duration,
    landAt,
    animate: { duration, ...sp, velocityX: vx, velocityY: vy },
    at: (t) => (t >= duration ? REST : pose(Math.max(0, t))),
  };
}
