// Validates the chat bottom-anchoring pure logic (ProjectChat +
// FeedbackThread keyboard re-pin): the near-bottom rule, the
// should-pin-after-resize decision, and a headless simulation of the
// keyboard opening/closing over a scrolled list.
//
// Run:  node scripts/test-bottom-anchor.mjs   (Node native TS
// type-stripping for the .ts import — the test-feedback-pure.mjs idiom).

import {
  NEAR_BOTTOM_SLOP_PX, isNearBottom, shouldPinAfterResize,
} from "../src/lib/bottomAnchor.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };

// ── isNearBottom ────────────────────────────────────────────────────────
// 2000px of messages in a 700px list: bottom is scrollTop 1300.
assert(isNearBottom(1300, 2000, 700) === true, "exactly at the bottom -> near");
assert(isNearBottom(1300 - NEAR_BOTTOM_SLOP_PX, 2000, 700) === true, "within the slop -> near");
assert(isNearBottom(1300 - NEAR_BOTTOM_SLOP_PX - 1, 2000, 700) === false, "past the slop -> not near");
assert(isNearBottom(0, 2000, 700) === false, "scrolled to the top -> not near");
assert(isNearBottom(0, 300, 700) === true, "content shorter than the list -> trivially near");

// ── shouldPinAfterResize ────────────────────────────────────────────────
assert(shouldPinAfterResize(true, 800, 500) === true, "at tail + keyboard opens -> pin");
assert(shouldPinAfterResize(false, 800, 500) === false, "reading history + keyboard opens -> leave alone");
assert(shouldPinAfterResize(true, 500, 800) === true, "at tail + keyboard closes -> pin");
assert(shouldPinAfterResize(true, 800, 800) === false, "no height change -> no pin");

// ── Headless simulation: the useBottomAnchor sequence over a fake list ──
// A resize applies, then the hook decides from the PRE-resize near-bottom
// reading and (only if pinning) sets scrollTop to its max.
const simulate = (el, nextClientHeight) => {
  const wasNear = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  const prev = el.clientHeight;
  el.clientHeight = nextClientHeight;
  if (shouldPinAfterResize(wasNear, prev, nextClientHeight)) {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }
  return el;
};

// Keyboard opens (700 -> 380) with the list at the bottom: the newest
// message stays visible — scrollTop lands at the new max.
let el = simulate({ scrollTop: 1300, scrollHeight: 2000, clientHeight: 700 }, 380);
assert(el.scrollTop === 2000 - 380, "keyboard open at bottom -> scrollTop lands at max");

// Keyboard opens while scrolled up reading history: untouched.
el = simulate({ scrollTop: 200, scrollHeight: 2000, clientHeight: 700 }, 380);
assert(el.scrollTop === 200, "keyboard open scrolled up -> scrollTop unchanged");

// Keyboard closes (380 -> 700) from the pinned state: still pinned.
el = simulate({ scrollTop: 1620, scrollHeight: 2000, clientHeight: 380 }, 700);
assert(el.scrollTop === 2000 - 700, "keyboard close at bottom -> re-pinned to the new max");

process.exit(failures ? 1 : 0);
