// Pure gesture decisions for the iOS-style left-edge swipe-back on the
// pushed sub-screens (FeedbackThread / ProjectChat / ProjectHtmlDocs) —
// arm at the left edge, lock to the dominant axis, complete on distance
// or a velocity flick. The DOM/touch plumbing lives in useSwipeBack.ts.
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
 *  completes even short of the distance threshold... */
export const FLICK_VELOCITY_PX_PER_MS = 0.3;

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

/** The release decision: far enough OR a genuine rightward flick. */
export function shouldComplete(dx: number, velocity: number, viewportWidth: number): boolean {
  if (dx >= viewportWidth * COMPLETE_FRACTION) return true;
  return velocity >= FLICK_VELOCITY_PX_PER_MS && dx >= FLICK_MIN_DX_PX;
}
