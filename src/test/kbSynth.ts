// SYNTHETIC keyboard-drag traces: a simple finger / keyboard / scroll
// model, for the replay suite to run before real device traces exist.
// Regenerate the committed JSON with:
//   npx vite-node scripts/gen-kb-traces.ts
//
// Model (120 Hz frames, iPhone-ish geometry):
//   - the list scrolls 1:1 with the finger while it is down (no rubber
//     band: the Thread keeps scroll room above), then coasts with iOS
//     momentum (velocity · e^(−t/325ms)) after the lift;
//   - the keyboard tracks the finger at the dismiss padding once the
//     finger is past the composer's top (keyboardTop = finger + padding,
//     clamped to rest … bottom), back at rest above it;
//   - on lift UIKit animates the rest (hide to the bottom, or spring back
//     to rest) on curve 7 — modelled with the same cubic-bezier the page
//     uses (KEYBOARD_EASING), so the tail cannot show curve mismatch;
//     real traces can.

import { KEYBOARD_EASING } from "../lib/useViewportHeight";
import { TRACE_VERSION, type KbEvent, type KbTrace } from "../lib/kbDragScore";

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0…1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < p) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

/** A CSS timing function string → its curve (cubic-bezier / linear /
 *  the ease keywords). */
export function easingFn(css: string): (p: number) => number {
  const m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(css);
  if (m) return cubicBezier(+m[1], +m[2], +m[3], +m[4]);
  if (/ease-in-out/.test(css)) return cubicBezier(0.42, 0, 0.58, 1);
  if (/ease-out/.test(css)) return cubicBezier(0, 0, 0.58, 1);
  if (/ease-in/.test(css)) return cubicBezier(0.42, 0, 1, 1);
  if (/ease/.test(css)) return cubicBezier(0.25, 0.1, 0.25, 1);
  return (p) => Math.min(1, Math.max(0, p));
}

export const SYNTH = {
  hz: 120,
  viewH: 844,
  keyboard: 336,
  padding: 64,
  scroll0: 1500,
  momentumTauMs: 325,
};

/** A finger path: segments of [durationMs, endY] after a start y; then
 *  lift. `release`: what the keyboard does on lift. */
export type FingerScript = {
  name: string;
  startY: number;
  moves: [number, number][];
  release: { show: boolean; ms: number };
};

export function synthTrace(script: FingerScript): KbTrace {
  const { hz, viewH, keyboard, padding, scroll0, momentumTauMs } = SYNTH;
  const frame = 1000 / hz;
  const rest = viewH - keyboard;
  const line = rest - padding;
  const ease = easingFn(KEYBOARD_EASING);

  // Finger y(t) while down.
  const legs: { t0: number; t1: number; y0: number; y1: number }[] = [];
  let t = 0;
  let y = script.startY;
  for (const [ms0, to] of script.moves) {
    // On the frame grid: the lift (UIKit's begin frame) is a sampled frame.
    const ms = Math.max(1, Math.round(ms0 / frame)) * frame;
    legs.push({ t0: t, t1: t + ms, y0: y, y1: to });
    t += ms;
    y = to;
  }
  const liftAt = t;
  const fingerAt = (tt: number) => {
    for (const l of legs) {
      if (tt <= l.t1) return l.y0 + ((l.y1 - l.y0) * (tt - l.t0)) / Math.max(1e-9, l.t1 - l.t0);
    }
    return y;
  };
  const last = legs[legs.length - 1];
  const vLift = last && last.t1 > last.t0 ? (last.y1 - last.y0) / (last.t1 - last.t0) : 0;
  const kbFollow = (fy: number) => Math.min(viewH, Math.max(rest, fy + padding));
  const kbAtLift = kbFollow(y);
  const target = script.release.show ? rest : viewH;
  const end = liftAt + script.release.ms + 150;

  const samples: KbTrace["samples"] = [];
  const events: KbEvent[] = [];
  const r1 = (n: number) => Math.round(n * 10) / 10;
  for (let i = 0; i * frame <= end + 1e-6; i++) {
    const tt = i * frame;
    let top: number;
    let scroll: number;
    if (tt <= liftAt + 1e-6) {
      const fy = fingerAt(tt);
      top = fy >= line ? kbFollow(fy) : rest;
      scroll = scroll0 - (fy - script.startY);
      events.push({ t: r1(tt), k: "touch", y: r1(fy) });
    } else {
      const p = ease((tt - liftAt) / script.release.ms);
      top = kbAtLift + (target - kbAtLift) * p;
      const coast = vLift * momentumTauMs * (1 - Math.exp(-(tt - liftAt) / momentumTauMs));
      scroll = scroll0 - (y - script.startY) - coast;
    }
    samples.push([r1(tt), r1(top), r1(scroll)]);
  }
  events.push({ t: r1(liftAt), k: "lift" });
  events.push({ t: r1(liftAt), k: "will", show: script.release.show, ms: script.release.ms });
  events.sort((a, b) => a.t - b.t);
  return {
    v: TRACE_VERSION,
    synthetic: true,
    name: script.name,
    device: "synthetic",
    ios: "",
    dpr: 3,
    refreshHz: hz,
    restTop: rest,
    viewH,
    padding,
    clockErrMs: 0,
    samples,
    page: [],
    events,
  };
}

export const SYNTH_SCRIPTS: FingerScript[] = [
  {
    name: "synthetic-slow-drag",
    startY: 300,
    moves: [[1150, 700]],
    release: { show: false, ms: 250 },
  },
  {
    name: "synthetic-fast-flick",
    startY: 380,
    moves: [[140, 690]],
    release: { show: false, ms: 250 },
  },
  {
    name: "synthetic-reverse-mid-drag",
    startY: 300,
    moves: [
      [430, 560],
      [270, 400],
      [300, 640],
    ],
    release: { show: false, ms: 250 },
  },
  {
    name: "synthetic-spring-back",
    startY: 300,
    moves: [
      [380, 490],
      [100, 490],
    ],
    release: { show: true, ms: 200 },
  },
];
