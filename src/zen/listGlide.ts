// The Thread list's glides: one controller owns the message list's
// transform, so every reason it moves — a send making room, an agent
// message arriving, the working drawer opening or folding away — is one
// continuous motion. When the layout jumps by `dy` (the scroller stuck to
// the newest), the list is drawn `dy` back where it was and glides home.
// A second jump mid-glide folds what is left into the new glide: the list
// never snaps, and never runs two motions against each other.
//
// Arrivals (iMessage): while the reader follows the newest, a message that
// is not this phone's own send keeps the old content in place, then the
// list glides up by the new rows' height while each new row fades in and
// rises a little (`fadeInRows`). Compositor-only: transform and opacity.

import {
  alongCurve,
  curveEasing,
  flyMotion,
  springDamping,
  springProgress,
  type FlyMotion,
} from "./sendFly";

/** The arrival glide: shorter than a send's flight (480ms), same spring. */
export const INCOMING_MS = 320;
export const INCOMING_EASING = "spring";
/** Each new row rises this far (px) as it fades in… */
export const INCOMING_RISE_PX = 8;
/** …over this long… */
export const INCOMING_FADE_MS = 260;
/** …one after another (a batch), at most this far apart in total. */
export const INCOMING_STAGGER_MS = 40;
export const INCOMING_STAGGER_CAP_MS = 160;
/** A big batch: only the newest rows fade (the rest are above the fold). */
export const INCOMING_MAX_FADED = 6;
/** The working drawer opening / folding away on its own (no reply). */
export const DRAWER_GLIDE_MS = 200;
export const DRAWER_GLIDE_EASING = "cubic-bezier(0.2, 0.9, 0.3, 1)";
/** The drawer folded away with no reply yet: the list holds still this
 *  long for the reply, so both become one motion (no "bounce"). */
export const REPLY_FOLD_MS = 300;
/** An arrival this recent already is the turn's reply: no hold. */
export const ARRIVAL_RECENT_MS = 1500;

const SOFT_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** A glide this much (of its distance) from done can take a small change
 *  in stride; nearer the end it restarts instead. */
const RIDE_MIN_LEFT = 0.35;

/** The arrival motion (the send's `blueAt` / `collapse` are unused here). */
export function incomingMotion(): FlyMotion {
  return { ...flyMotion(), ms: INCOMING_MS, easing: INCOMING_EASING };
}

export function drawerMotion(): FlyMotion {
  return { ...flyMotion(), ms: DRAWER_GLIDE_MS, easing: DRAWER_GLIDE_EASING };
}

const NAMED: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/** A CSS cubic-bezier's progress at time fraction `t` (Newton + bisection). */
export function cubicBezierProgress(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const x = sx(u) - t;
    const d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(x) < 1e-5) return sy(u);
    if (Math.abs(d) < 1e-6) break;
    u -= x / d;
  }
  let lo = 0;
  let hi = 1;
  u = t;
  for (let i = 0; i < 30; i++) {
    const x = sx(u);
    if (Math.abs(x - t) < 1e-5) break;
    if (x < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return sy(u);
}

/** How far along `motion` is at time fraction `t` (0–1). */
export function curveProgress(motion: FlyMotion, t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  const zeta = springDamping(motion.easing);
  if (zeta != null) return springProgress(t, zeta);
  const e = motion.easing.trim().toLowerCase();
  const named = NAMED[e];
  if (named) return cubicBezierProgress(...named, t);
  const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(e);
  if (m) return cubicBezierProgress(+m[1], +m[2], +m[3], +m[4], t);
  return t;
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;

export interface ListGlider {
  /** The list's layout just moved up by `dy` px (down when negative):
   *  draw it where it was and glide it home, folding in whatever a
   *  running glide had left. `holdMs`: stay put that long first. */
  shift(dy: number, opts?: { motion?: FlyMotion; holdMs?: number }): void;
  /** How far (px) the list is drawn from its layout spot right now. */
  offset(): number;
  /** Gliding (past any hold, not finished). */
  moving(): boolean;
  /** Holding still before a glide. */
  holding(): boolean;
  /** Drop the glide: the list snaps to its layout spot. */
  cancel(): void;
}

type Run = {
  anim: Animation;
  el: HTMLElement;
  from: number;
  start: number;
  hold: number;
  motion: FlyMotion;
};

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createListGlider(
  content: () => HTMLElement | null,
  clock: () => number = nowMs
): ListGlider {
  let run: Run | null = null;

  const elapsed = (r: Run) => clock() - r.start;

  function offset(): number {
    const r = run;
    if (!r) return 0;
    const t = elapsed(r);
    if (t <= r.hold) return r.from;
    const p = (t - r.hold) / r.motion.ms;
    if (p >= 1) return 0;
    return r.from * (1 - curveProgress(r.motion, p));
  }

  function stop(clearHint: boolean) {
    const r = run;
    run = null;
    if (!r) return;
    r.anim.onfinish = null;
    r.anim.oncancel = null;
    try {
      r.anim.cancel();
    } catch {
      /* already gone */
    }
    if (clearHint) r.el.style.willChange = "";
  }

  return {
    shift(dy, opts = {}) {
      const el = content();
      if (!el || typeof el.animate !== "function" || !Number.isFinite(dy)) {
        stop(true);
        return;
      }
      const current = offset();
      const total = current + dy;
      // A small change mid-glide (the drawer folding into a reply's glide)
      // rides the running curve to its end, rescaled: no restart from
      // rest, so the motion keeps its speed and lands once.
      const cur = run;
      const t = cur ? elapsed(cur) - cur.hold : 0;
      const left = cur && t > 0 ? 1 - curveProgress(cur.motion, t / cur.motion.ms) : 0;
      const ride =
        cur != null &&
        !opts.holdMs &&
        left >= RIDE_MIN_LEFT &&
        Math.abs(dy) <= Math.abs(current) &&
        Math.sign(total) === Math.sign(current);
      stop(false);
      if (!(Math.abs(total) >= 0.5)) {
        el.style.willChange = "";
        return;
      }
      const motion = ride && cur ? cur.motion : opts.motion ?? incomingMotion();
      const from = ride ? total / left : total;
      const hold = ride ? 0 : Math.max(0, opts.holdMs ?? 0);
      // Riding: start part-way in (a negative delay), on the same clock.
      const delay = ride ? -t : hold;
      el.style.willChange = "transform";
      let anim: Animation;
      try {
        anim = el.animate(
          alongCurve(motion, (p) => ({ transform: `translate3d(0px, ${px(from * (1 - p))}, 0px)` })),
          // `backwards`: the first frame holds through the delay.
          { duration: motion.ms, easing: curveEasing(motion), delay, fill: "backwards" }
        );
      } catch {
        el.style.willChange = "";
        return;
      }
      const r: Run = { anim, el, from, start: ride ? clock() - t : clock(), hold, motion };
      run = r;
      const done = () => {
        if (run !== r) return;
        run = null;
        el.style.willChange = "";
      };
      anim.onfinish = done;
      anim.oncancel = done;
    },
    offset,
    moving() {
      const r = run;
      if (!r) return false;
      const t = elapsed(r);
      return t > r.hold && t < r.hold + r.motion.ms;
    },
    holding() {
      const r = run;
      return !!r && elapsed(r) <= r.hold;
    },
    cancel() {
      stop(true);
    },
  };
}

/** New rows fade in and rise a little, one after another (newest last).
 *  Only the newest `INCOMING_MAX_FADED` animate. Opacity + transform on
 *  each row: compositor work. */
export function fadeInRows(rows: HTMLElement[]): void {
  const shown = rows.slice(-INCOMING_MAX_FADED);
  shown.forEach((el, i) => {
    if (typeof el.animate !== "function") return;
    try {
      el.animate(
        [
          { opacity: 0, transform: `translate3d(0px, ${INCOMING_RISE_PX}px, 0px)` },
          { opacity: 1, transform: "translate3d(0px, 0px, 0px)" },
        ],
        {
          duration: INCOMING_FADE_MS,
          delay: Math.min(i * INCOMING_STAGGER_MS, INCOMING_STAGGER_CAP_MS),
          easing: SOFT_OUT,
          fill: "backwards",
        }
      );
    } catch {
      /* no animation: the row is simply there */
    }
  });
}

/** Rows that arrived since the last commit: new keys after the first row
 *  that was already there (rows prepended above — history — are not
 *  arrivals), and not this phone's own sends. */
export function arrivedRows<T extends { key: string; own: boolean }>(
  rows: readonly T[],
  before: ReadonlySet<string>
): T[] {
  const first = rows.findIndex((r) => before.has(r.key));
  if (first < 0) return [];
  const out: T[] = [];
  for (let i = first + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!before.has(r.key) && !r.own) out.push(r);
  }
  return out;
}
