// Keyboard-drag quality: the trace format and its score. Pure (no DOM, no
// timers): the on-device recorder (kbDragRecorder.ts) and the replay
// tests (src/test/kbReplay.ts) both score with it.
//
// A trace covers one interactive-dismiss drag, attach → release → the
// keyboard settled, capped at TRACE_CAP_MS. All times are page-clock ms
// relative to the trace start; positions are viewport px (CSS px = pt).
//
//   samples: [t, keyboardTop, listScrollY]   native, every display frame
//   page:    [t, composerBottom, scrollTop]  page, every rAF
//   events:  attach / correct / release / will / touch / lift / end
//
// The composer's bottom should sit on the keyboard's top: gap =
// composerBottom − keyboardTop at the same instant (keyboard interpolated
// between native samples). Positive = the composer is below the keyboard
// line (overlapping it), negative = a gap shows above the keyboard.

export const TRACE_VERSION = 1;
/** A trace stops after this long (ms). */
export const TRACE_CAP_MS = 5000;
/** |gap| at or under this (px) counts as on the keyboard. */
export const ON_KEYBOARD_PX = 1;
/** The steady phase runs from the end of the correction(s) (or this long
 *  after the attach when none ran) to the lift. */
export const STEADY_AFTER_ATTACH_MS = 250;
/** A page frame longer than this × the frame budget counts as dropped. */
export const DROPPED_FRAME_FACTOR = 1.5;

export type KbEvent =
  | { t: number; k: "attach"; via: "touch" | "sample" }
  | { t: number; k: "correct"; d: number; ms: number }
  | { t: number; k: "release"; fromTop: number | null; copyBottom: number | null }
  | { t: number; k: "will"; show: boolean; ms: number }
  | { t: number; k: "touch"; y: number }
  | { t: number; k: "lift" }
  | { t: number; k: "end" };

export type KbTrace = {
  v: typeof TRACE_VERSION;
  /** Set for model-generated traces (src/test/kbTraces/*). */
  synthetic?: boolean;
  name?: string;
  device: string;
  ios: string;
  dpr: number;
  refreshHz: number;
  /** Keyboard top before the drag (px). */
  restTop: number;
  /** Viewport height with no keyboard (px). */
  viewH?: number;
  /** keyboardDismissPadding in effect (px; 0 = none). */
  padding: number;
  /** Estimated native↔page clock alignment error (± ms). */
  clockErrMs: number;
  samples: [number, number, number | null][];
  page: [number, number, number][];
  events: KbEvent[];
};

export type KbScore = {
  /** Page frames scored (inside the native timeline). */
  frames: number;
  maxGap: number;
  p95Gap: number;
  /** % of frames with |gap| ≤ ON_KEYBOARD_PX. */
  within1Pct: number;
  /** First correction: ms after the attach, and its duration. */
  correctionStartMs: number | null;
  correctionMs: number | null;
  /** Steady phase = after the correction(s) until the release. */
  steadyFrames: number;
  steadyOffFrames: number;
  steadyMaxGap: number;
  /** Page frames whose rAF delta exceeded 1.5 × the frame budget. */
  droppedFrames: number;
  /** |gap| at the lift (the last frame before the finger left): the copy
   *  on the keyboard when it was let go. */
  releaseJump: number | null;
  /** Max |gap| between the lift and the hand-off (the copy coasts with
   *  the list's momentum until the page hears the Will*: ~1 IPC frame). */
  handoffMaxGap: number | null;
  /** |gap| in the first frame after the release (the real composer). */
  releaseLandingErr: number | null;
  /** The release tail (after the release until the trace ends): frames,
   *  max |gap|, and page frames dropped in it. */
  tailFrames: number;
  tailMaxGap: number;
  tailDropped: number;
  /** Attached this long (ms) before the keyboard started to move (0 =
   *  not early). */
  earlyAttachMs: number;
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Keyboard top at page time t, linear between native samples; null
 *  outside the sampled range. */
export function keyboardTopAt(samples: KbTrace["samples"], t: number): number | null {
  if (!samples.length || t < samples[0][0] || t > samples[samples.length - 1][0]) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, y0] = samples[lo];
  const [t1, y1] = samples[hi];
  if (t1 === t0) return y0;
  return y0 + ((y1 - y0) * (t - t0)) / (t1 - t0);
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

export function scoreTrace(trace: KbTrace): KbScore {
  const attach = trace.events.find((e) => e.k === "attach");
  const release = trace.events.find((e) => e.k === "release") as
    | Extract<KbEvent, { k: "release" }>
    | undefined;
  const corrections = trace.events.filter((e) => e.k === "correct") as Extract<KbEvent, { k: "correct" }>[];
  const from = attach?.t ?? (trace.page[0]?.[0] ?? 0);
  const gaps: { t: number; g: number }[] = [];
  for (const [t, bottom] of trace.page) {
    if (t < from) continue;
    const kb = keyboardTopAt(trace.samples, t);
    if (kb == null) continue;
    gaps.push({ t, g: bottom - kb });
  }
  const abs = gaps.map((x) => Math.abs(x.g));
  const lastCorr = corrections[corrections.length - 1];
  const steadyStart = lastCorr ? lastCorr.t + lastCorr.ms : from + STEADY_AFTER_ATTACH_MS;
  const lift = trace.events.find((e) => e.k === "lift" || e.k === "will");
  const liftT = lift ? lift.t : release ? release.t : Number.POSITIVE_INFINITY;
  const steadyEnd = Math.min(liftT, release ? release.t : Number.POSITIVE_INFINITY);
  const steady = gaps.filter((x) => x.t >= steadyStart && x.t < steadyEnd).map((x) => Math.abs(x.g));

  const budget = 1000 / (trace.refreshHz > 0 ? trace.refreshHz : 60);
  let dropped = 0;
  for (let i = 1; i < trace.page.length; i++) {
    if (trace.page[i][0] - trace.page[i - 1][0] > DROPPED_FRAME_FACTOR * budget) dropped++;
  }

  const tail = release ? gaps.filter((x) => x.t > release.t).map((x) => Math.abs(x.g)) : [];
  let tailDropped = 0;
  if (release) {
    for (let i = 1; i < trace.page.length; i++) {
      if (trace.page[i][0] <= release.t) continue;
      if (trace.page[i][0] - trace.page[i - 1][0] > DROPPED_FRAME_FACTOR * budget) tailDropped++;
    }
  }

  let landing: number | null = null;
  if (release) {
    const after = gaps.find((x) => x.t > release.t);
    landing = after ? Math.abs(after.g) : null;
  }
  const atLift = [...gaps].reverse().find((x) => x.t <= liftT + 1e-6);
  const releaseJump = release && atLift ? Math.abs(atLift.g) : null;
  const handoff = release ? gaps.filter((x) => x.t > liftT + 1e-6 && x.t <= release.t + 1e-6) : [];
  const handoffMaxGap = release ? (handoff.length ? Math.max(...handoff.map((x) => Math.abs(x.g))) : 0) : null;

  let earlyAttachMs = 0;
  if (attach) {
    const firstMove = trace.samples.find(([, top]) => top - trace.restTop >= 0.5);
    if (firstMove && firstMove[0] > attach.t) earlyAttachMs = firstMove[0] - attach.t;
  }

  return {
    frames: gaps.length,
    maxGap: r1(abs.length ? Math.max(...abs) : 0),
    p95Gap: r1(percentile(abs, 95)),
    within1Pct: abs.length ? Math.round((abs.filter((g) => g <= ON_KEYBOARD_PX).length / abs.length) * 1000) / 10 : 100,
    correctionStartMs: corrections[0] && attach ? r1(corrections[0].t - attach.t) : null,
    correctionMs: corrections[0] ? corrections[0].ms : null,
    steadyFrames: steady.length,
    steadyOffFrames: steady.filter((g) => g > ON_KEYBOARD_PX).length,
    steadyMaxGap: r1(steady.length ? Math.max(...steady) : 0),
    droppedFrames: dropped,
    releaseJump: releaseJump == null ? null : r1(releaseJump),
    handoffMaxGap: handoffMaxGap == null ? null : r1(handoffMaxGap),
    releaseLandingErr: landing == null ? null : r1(landing),
    tailFrames: tail.length,
    tailMaxGap: r1(tail.length ? Math.max(...tail) : 0),
    tailDropped,
    earlyAttachMs: r1(earlyAttachMs),
  };
}

/** Gap over time (for a sparkline): [t, gap] per scored frame. */
export function gapSeries(trace: KbTrace): [number, number][] {
  const out: [number, number][] = [];
  for (const [t, bottom] of trace.page) {
    const kb = keyboardTopAt(trace.samples, t);
    if (kb != null) out.push([t, r1(bottom - kb)]);
  }
  return out;
}

/** Validate a parsed JSON trace (drop-ins from devices). */
export function isTrace(x: unknown): x is KbTrace {
  const t = x as KbTrace;
  return (
    !!t &&
    t.v === TRACE_VERSION &&
    Array.isArray(t.samples) &&
    Array.isArray(t.page) &&
    Array.isArray(t.events) &&
    typeof t.restTop === "number"
  );
}
