// T5b pure tests: tap → SGR mouse click (lib/sgrMouse.ts) — route
// gate, press/release encoding (byte-exact desktop sgrMouse.ts
// parity), the combined tap frame, and the tap/drag/long-press
// gesture disambiguation.
//
// Run:  node scripts/test-sgr-mouse.mjs   (Node native TS
// type-stripping; everything imported is DOM-free by design).

import {
  mouseRoute,
  encodeSgrMouse,
  encodeSgrTap,
  movedBeyond,
  classifyRelease,
  TAP_MAX_MOVE_PX,
  TAP_MAX_MS,
  LONG_PRESS_MS,
} from "../src/lib/sgrMouse.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

// ── 1. mouseRoute (same gate as the wheel branch) ──
console.log("\n[sgrMouse] mouseRoute");
assert(
  mouseRoute({ mouseReport: true, sgrMouse: true }) === "forward",
  "mouseReport && sgrMouse → forward"
);
assert(
  mouseRoute({ mouseReport: true, sgrMouse: false }) === "local" &&
  mouseRoute({ mouseReport: false, sgrMouse: true }) === "local" &&
  mouseRoute({}) === "local",
  "either bit missing (incl. JSON-path undefined) → local"
);

// ── 2. encodeSgrMouse: press M / release m, button 0 ──
console.log("\n[sgrMouse] encodeSgrMouse press/release");
assert(
  encodeSgrMouse("press", 12, 3) === "\x1b[<0;12;3M",
  "press = ESC[<0;c;rM (left button, M final — desktop byte parity)"
);
assert(
  encodeSgrMouse("release", 12, 3) === "\x1b[<0;12;3m",
  "release = ESC[<0;c;rm (m final WITH the real button code — SGR-only)"
);
assert(
  encodeSgrMouse("press", 0, -2) === "\x1b[<0;1;1M",
  "coords clamp to 1-based"
);

// ── 3. encodeSgrTap: one frame, press then release ──
console.log("\n[sgrMouse] encodeSgrTap");
assert(
  encodeSgrTap(5, 7) === "\x1b[<0;5;7M\x1b[<0;5;7m",
  "tap = press immediately followed by release at the same cell"
);

// ── 4. movedBeyond: the shared movement ceiling ──
console.log("\n[sgrMouse] movedBeyond");
const start = { x: 100, y: 200, t: 0 };
assert(
  !movedBeyond(start, 106, 208) && TAP_MAX_MOVE_PX === 10,
  "within 10px straight-line (6,8 → 10.0) → still a tap/long-press candidate"
);
assert(
  movedBeyond(start, 107, 208),
  "past 10px straight-line (7,8 → 10.6) → drag"
);
assert(
  movedBeyond(start, 100, 205, 4),
  "custom threshold respected (5px move vs 4px ceiling)"
);

// ── 5. classifyRelease: the disambiguation matrix ──
console.log("\n[sgrMouse] classifyRelease");
assert(
  classifyRelease({ moved: false, longPressFired: false, durationMs: 150 }) === "tap",
  "still + short → tap"
);
assert(
  classifyRelease({ moved: true, longPressFired: false, durationMs: 150 }) === "drag",
  "moved → drag (T5a wheel owns it), even when short"
);
assert(
  classifyRelease({ moved: false, longPressFired: true, durationMs: 700 }) === "long-press",
  "long-press timer fired → long-press (selection owns it)"
);
assert(
  classifyRelease({ moved: true, longPressFired: true, durationMs: 900 }) === "long-press",
  "long-press wins over a later move (the move was adjusting the selection)"
);
assert(
  classifyRelease({ moved: false, longPressFired: false, durationMs: 400 }) === "none",
  "still release in the 300–500ms dead zone → neither click nor selection"
);
assert(
  TAP_MAX_MS === 300 && LONG_PRESS_MS === 500,
  "thresholds: tap <300ms, long-press ≥500ms"
);

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall sgrMouse tests passed");
