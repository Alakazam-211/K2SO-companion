// Pure gesture decisions for the iOS-style left-edge swipe-back on the
// pushed sub-screens (FeedbackThread / ProjectChat / ProjectHtmlDocs) —
// arm at the left edge, lock to the dominant axis, complete on distance
// or a velocity flick. The DOM/touch plumbing lives in useSwipeBack.ts.
//
// The release (complete vs cancel, and the animation that carries the
// screen from the finger's position to the end state) is decided here
// too: shouldComplete + releaseAnimation + underlayFrame.
//
// IMPORT-SAFE: no DOM / react / tauri imports, so everything here runs
// under a plain Node test runner (scripts/test-swipe-back.mjs — the
// test-bottom-anchor.mjs idiom).

/** Touches must START within this many px of the left viewport edge to
 *  arm the gesture — everything further in belongs to the screen's own
 *  scrolling/selection (and, on the docs viewer, to the iframe). */
export const EDGE_ARM_PX = 24;

/** Movement past this many px decides the gesture's axis: dominant-Y
 *  rejects (it's a scroll), dominant-X rightward starts tracking. */
export const AXIS_LOCK_PX = 10;

/** Dragging past this fraction of the viewport width completes the
 *  swipe on release regardless of speed. */
export const COMPLETE_FRACTION = 0.35;

/** A release moving rightward at least this fast (px/ms) is a flick —
 *  completes even short of the distance threshold. The same speed
 *  LEFTWARD cancels even past it (the finger is taking the screen back,
 *  UINavigationController's interactive pop does the same). */
export const FLICK_VELOCITY_PX_PER_MS = 0.5;

/** ...but never from a near-zero drag (guards twitchy micro-touches). */
export const FLICK_MIN_DX_PX = 30;

/** Velocity is measured over the trailing window of move samples, so a
 *  drag that STOPS before release doesn't inherit its earlier speed. */
export const VELOCITY_WINDOW_MS = 100;

/** Gesture lifecycle: armed (edge touch, axis undecided) → tracking
 *  (dominant-X rightward; the screen follows the finger) or rejected
 *  (dominant-Y or leftward; the touch belongs to scrolling). Terminal
 *  states are sticky for the rest of the touch. */
export type SwipePhase = "armed" | "tracking" | "rejected";

/** Whether a touch starting at `startX` arms the gesture. `enabled`
 *  lets screens suspend arming (e.g. while a bottom sheet is open). */
export function canArm(startX: number, enabled: boolean, edgePx: number = EDGE_ARM_PX): boolean {
  return enabled && startX <= edgePx;
}

/** Advance the phase for a move that is `dx`/`dy` from the touch start.
 *  Decisions are one-way: once tracking or rejected, the phase holds. */
export function nextPhase(phase: SwipePhase, dx: number, dy: number): SwipePhase {
  if (phase !== "armed") return phase;
  const ay = Math.abs(dy);
  // Dominant vertical early on → it's a scroll; never a swipe-back.
  if (ay > AXIS_LOCK_PX && ay > Math.abs(dx)) return "rejected";
  // Dominant leftward → not a back gesture; release the touch.
  if (dx < -AXIS_LOCK_PX) return "rejected";
  // Dominant rightward → the screen starts following the finger.
  if (dx > AXIS_LOCK_PX && dx > ay) return "tracking";
  return "armed";
}

/** How far the screen translates for a finger `dx` right of the start —
 *  the screen never moves left of its resting place. */
export function dragOffset(dx: number): number {
  return Math.max(0, dx);
}

/** Rightward velocity (px/ms) over the trailing sample window. Samples
 *  are (timeStamp, clientX) pairs in arrival order. */
export function velocityFromSamples(
  samples: ReadonlyArray<{ t: number; x: number }>,
  windowMs: number = VELOCITY_WINDOW_MS
): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const s of samples) {
    if (last.t - s.t <= windowMs) {
      first = s;
      break;
    }
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** The release decision: far enough OR a genuine rightward flick —
 *  unless the finger is flicking back LEFT, which always cancels. */
export function shouldComplete(dx: number, velocity: number, viewportWidth: number): boolean {
  if (velocity <= -FLICK_VELOCITY_PX_PER_MS) return false;
  if (dx >= viewportWidth * COMPLETE_FRACTION) return true;
  return velocity >= FLICK_VELOCITY_PX_PER_MS && dx >= FLICK_MIN_DX_PX;
}

// ── Release animation ───────────────────────────────────────────────────
// After the finger lifts, the screen carries on from where it is to the
// end state (off to the right, or home at 0) at the finger's speed: the
// duration is the remaining distance over the release speed, clamped,
// and the curve's initial slope matches that speed so there is no hitch
// between the drag and the animation. Compositor-only (transform).

/** Release animations never run shorter / longer than this (ms). */
export const RELEASE_MIN_MS = 180;
export const RELEASE_MAX_MS = 350;
/** A release slower than this (px/ms) — or moving away from the target —
 *  animates as if it moved at this speed (a resting finger still glides). */
export const RELEASE_MIN_SPEED_PX_PER_MS = 1;
/** Reduced motion: no further sliding, just a short fade (ms). */
export const REDUCED_MOTION_FADE_MS = 120;

/** Control-point abscissa of the release curve (cubic-bezier x1). */
const CURVE_X1 = 0.25;

/** Duration + CSS easing for animating from `from` to `to` (px) after a
 *  release moving at `velocity` px/ms (signed, rightward positive). */
export function releaseAnimation(
  from: number,
  to: number,
  velocity: number
): { durationMs: number; easing: string } {
  const distance = Math.abs(to - from);
  // Speed in the direction of travel (negative = moving away from it).
  const toward = to >= from ? velocity : -velocity;
  const speed = Math.max(toward, RELEASE_MIN_SPEED_PX_PER_MS);
  const durationMs = Math.round(
    Math.min(RELEASE_MAX_MS, Math.max(RELEASE_MIN_MS, distance / speed))
  );
  // The curve's starting slope (progress per unit time, normalised) is
  // y1/x1; match it to the finger's speed. Floor at 1 (a linear start,
  // then the ease-out tail) so a still finger doesn't ease IN.
  const slope = distance > 0 ? (Math.max(toward, 0) * durationMs) / distance : 0;
  const y1 = Math.min(1, Math.max(CURVE_X1, CURVE_X1 * slope));
  return {
    durationMs,
    easing: `cubic-bezier(${CURVE_X1}, ${Number(y1.toFixed(3))}, 0.25, 1)`,
  };
}

/** The screen underneath (the list a back lands on) trails the drag:
 *  it starts this fraction of the width to the left... */
export const UNDERLAY_PARALLAX = 0.3;
/** ...and dimmed to this opacity over black, and reaches (0, 1) as the
 *  pushed screen leaves. */
export const UNDERLAY_MIN_OPACITY = 0.8;

/** The underlay's translateX (px) and opacity for the pushed screen at
 *  `offset` px of a `width`-px viewport. */
export function underlayFrame(offset: number, width: number): { x: number; opacity: number } {
  const p = width > 0 ? Math.min(1, Math.max(0, offset / width)) : 1;
  const x = -UNDERLAY_PARALLAX * width * (1 - p);
  return {
    x: Math.round(x * 100) / 100 || 0,
    opacity: Math.round((UNDERLAY_MIN_OPACITY + (1 - UNDERLAY_MIN_OPACITY) * p) * 1000) / 1000,
  };
}
