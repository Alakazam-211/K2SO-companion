// Validates the left-edge swipe-back pure gesture logic (FeedbackThread
// / ProjectChat / ProjectHtmlDocs): edge arming, dominant-axis lock,
// the distance threshold, the velocity flick, and cancellation.
//
// Run:  node scripts/test-swipe-back.mjs   (Node native TS
// type-stripping for the .ts import — the test-bottom-anchor.mjs idiom).

import {
  EDGE_ARM_PX, AXIS_LOCK_PX, COMPLETE_FRACTION, FLICK_VELOCITY_PX_PER_MS,
  FLICK_MIN_DX_PX, canArm, nextPhase, dragOffset, velocityFromSamples,
  shouldComplete,
} from "../src/lib/swipeBack.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };

// ── canArm: only edge touches (and only while enabled) ─────────────────
assert(canArm(0, true) === true, "touch on the bezel edge -> arms");
assert(canArm(EDGE_ARM_PX, true) === true, "touch exactly at the edge band -> arms");
assert(canArm(EDGE_ARM_PX + 1, true) === false, "touch past the edge band -> ignored");
assert(canArm(0, false) === false, "disabled (TicketSheet open) -> never arms");

// ── nextPhase: dominant-axis lock ───────────────────────────────────────
assert(nextPhase("armed", 5, 3) === "armed", "sub-slop wiggle -> still armed");
assert(nextPhase("armed", AXIS_LOCK_PX + 20, 4) === "tracking", "dominant rightward -> tracking");
assert(nextPhase("armed", 4, AXIS_LOCK_PX + 20) === "rejected", "dominant vertical (scroll) -> rejected");
assert(nextPhase("armed", 4, -(AXIS_LOCK_PX + 20)) === "rejected", "dominant upward scroll -> rejected");
assert(nextPhase("armed", -(AXIS_LOCK_PX + 5), 2) === "rejected", "leftward drag -> rejected");
assert(nextPhase("rejected", 200, 0) === "rejected", "rejected is sticky for the touch");
assert(nextPhase("tracking", 2, 80) === "tracking", "tracking is sticky (late vertical noise)");

// ── dragOffset: the screen never moves left of home ────────────────────
assert(dragOffset(120) === 120, "rightward drag -> screen follows");
assert(dragOffset(-30) === 0, "leftward overshoot -> clamped at home");

// ── velocityFromSamples ─────────────────────────────────────────────────
assert(velocityFromSamples([{ t: 0, x: 10 }]) === 0, "single sample -> zero velocity");
assert(velocityFromSamples([{ t: 0, x: 0 }, { t: 100, x: 50 }]) === 0.5, "50px over 100ms -> 0.5 px/ms");
// A fast start that STOPS before release: only the trailing window counts.
assert(
  velocityFromSamples([{ t: 0, x: 0 }, { t: 50, x: 100 }, { t: 400, x: 110 }, { t: 480, x: 110 }]) === 0,
  "drag that stalls before release -> trailing-window velocity is 0"
);

// ── shouldComplete: distance threshold OR velocity flick ────────────────
const W = 390; // iPhone-ish viewport width
const threshold = W * COMPLETE_FRACTION;
assert(shouldComplete(threshold, 0, W) === true, "at the 35%-width threshold -> back");
assert(shouldComplete(threshold - 1, 0, W) === false, "just short, released slowly -> spring back");
assert(
  shouldComplete(FLICK_MIN_DX_PX, FLICK_VELOCITY_PX_PER_MS, W) === true,
  "short drag but a genuine flick -> back"
);
assert(
  shouldComplete(FLICK_MIN_DX_PX - 1, 10, W) === false,
  "micro-twitch below the flick floor -> spring back even at speed"
);

// ── Headless simulation: full gesture sequences over the phase machine ──
const run = (moves) => {
  let phase = "armed";
  for (const [dx, dy] of moves) phase = nextPhase(phase, dx, dy);
  return phase;
};
// A real back-swipe: slight arc, dominantly rightward.
assert(run([[6, 2], [18, 5], [90, 12]]) === "tracking", "swipe sequence -> ends tracking");
// A scroll that starts on the edge: vertical wins first.
assert(run([[3, 8], [5, 24], [40, 60]]) === "rejected", "edge-started scroll -> ends rejected");

process.exit(failures ? 1 : 0);
