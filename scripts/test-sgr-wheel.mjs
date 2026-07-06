// T5a pure tests: touch-drag → SGR wheel translation for fullscreen
// TUIs (lib/sgrWheel.ts) — gate routing, encoding, cell-height
// quantization + fractional carry, direction, flick boost, per-gesture
// cap, and touch-point → SGR cell math.
//
// Run:  node scripts/test-sgr-wheel.mjs   (Node 24 native TS
// type-stripping; everything imported is DOM-free by design).

import {
  wheelRoute,
  encodeSgrWheel,
  accumulateDrag,
  initialDragWheel,
  cellFromPoint,
  GESTURE_EVENT_CAP,
  FLICK_VELOCITY_PX_PER_MS,
  FLICK_MULTIPLIER,
} from "../src/lib/sgrWheel.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 1. wheelRoute (desktop TerminalPane gate parity) ──
console.log("\n[sgrWheel] wheelRoute");
assert(
  wheelRoute({ mouseReport: true, sgrMouse: true }) === "forward",
  "mouseReport && sgrMouse → forward (desktop's exact gate)"
);
assert(
  wheelRoute({ mouseReport: true, sgrMouse: false }) === "local" &&
  wheelRoute({ mouseReport: false, sgrMouse: true }) === "local" &&
  wheelRoute({}) === "local",
  "either bit missing (incl. JSON-path undefined) → local"
);

// ── 2. encodeSgrWheel ──
console.log("\n[sgrWheel] encodeSgrWheel");
assert(
  encodeSgrWheel("up", 5, 10) === "\x1b[<64;5;10M",
  "wheel-up = ESC[<64;x;yM (toward older content)"
);
assert(
  encodeSgrWheel("down", 1, 1) === "\x1b[<65;1;1M",
  "wheel-down = ESC[<65;x;yM"
);
assert(
  encodeSgrWheel("down", 0, -3) === "\x1b[<65;1;1M",
  "coords clamp to 1-based"
);

// ── 3. accumulateDrag: quantization + carry + direction ──
console.log("\n[sgrWheel] accumulateDrag quantization/direction");
const CELL = 14; // px per cell-height

{
  // Half a cell emits nothing but carries; the second half completes it.
  let r = accumulateDrag(initialDragWheel(), 7, CELL, 0.1);
  assert(r.ticks === 0 && near(r.state.accumPx, 7), "sub-cell drag → 0 ticks, px carried");
  r = accumulateDrag(r.state, 7, CELL, 0.1);
  assert(r.ticks === 1 && near(r.state.accumPx, 0), "carry completes a cell → 1 tick, carry drained");
}
{
  // 2.5 cells in one move → 2 ticks, half-cell remainder.
  const r = accumulateDrag(initialDragWheel(), 2.5 * CELL, CELL, 0.1);
  assert(r.ticks === 2 && near(r.state.accumPx, 0.5 * CELL), "2.5 cells → 2 ticks + 0.5-cell remainder");
}
{
  // Direction: finger up (deltaPx > 0) = wheel-down 65; finger down = wheel-up 64.
  const down = accumulateDrag(initialDragWheel(), CELL, CELL, 0.1);
  const up = accumulateDrag(initialDragWheel(), -CELL, CELL, 0.1);
  assert(down.dir === "down" && up.dir === "up", "drag up → wheel-down; drag down → wheel-up (natural)");
}
{
  // Reversal mid-gesture: opposite movement unwinds the carry first.
  let r = accumulateDrag(initialDragWheel(), 7, CELL, 0.1); // +7 carry
  r = accumulateDrag(r.state, -10, CELL, 0.1); // net -3
  assert(r.ticks === 0 && near(r.state.accumPx, -3), "reversal nets against the carry (no phantom tick)");
}

// ── 4. accumulateDrag: flick boost + gesture cap ──
console.log("\n[sgrWheel] accumulateDrag flick/cap");
{
  const r = accumulateDrag(initialDragWheel(), CELL, CELL, FLICK_VELOCITY_PX_PER_MS);
  assert(
    r.ticks === FLICK_MULTIPLIER,
    `flick-speed move boosts distance ×${FLICK_MULTIPLIER} (1 cell → ${FLICK_MULTIPLIER} ticks)`
  );
}
{
  // A giant flick caps at GESTURE_EVENT_CAP; surplus whole ticks are
  // discarded (only sub-cell remainder carries), and the gesture stays
  // capped afterwards.
  let r = accumulateDrag(initialDragWheel(), 100 * CELL, CELL, 5);
  assert(r.ticks === GESTURE_EVENT_CAP, `flood drag capped at ${GESTURE_EVENT_CAP} events/gesture`);
  assert(Math.abs(r.state.accumPx) < CELL, "capped surplus discarded — carry stays sub-cell");
  r = accumulateDrag(r.state, 5 * CELL, CELL, 0.1);
  assert(r.ticks === 0 && r.state.sent === GESTURE_EVENT_CAP, "cap holds for the rest of the gesture");
  // New gesture (touchstart) resets the budget.
  const fresh = accumulateDrag(initialDragWheel(), 5 * CELL, CELL, 0.1);
  assert(fresh.ticks === 5, "fresh gesture → fresh cap budget");
}
{
  const r = accumulateDrag(initialDragWheel(), 50, 0, 0.1);
  assert(r.ticks === 0, "no cell metrics (cellHeight 0) → emits nothing");
}

// ── 5. cellFromPoint ──
console.log("\n[sgrWheel] cellFromPoint");
const base = {
  offsetX: 0, scale: 1,
  cellW: 6, cellH: 14,
  cols: 40, viewportRows: 20, totalRows: 20,
};
{
  // Touch at content (8,4) = grid origin → cell 1;1. One cell right/down → 2;2.
  const origin = cellFromPoint({ ...base, x: 8, y: 4 });
  const next = cellFromPoint({ ...base, x: 8 + 6, y: 4 + 14 });
  assert(
    origin.col === 1 && origin.row === 1 && next.col === 2 && next.row === 2,
    "1-based cells from padded strip origin"
  );
}
{
  // Scale 0.5: on-screen cells are half-size; offsetX shifts columns.
  const c = cellFromPoint({ ...base, scale: 0.5, offsetX: 10, x: 8 + 10 + 3 * 3, y: 4 + 3 * 7 });
  assert(c.col === 4 && c.row === 4, "scale + letterbox offset respected");
}
{
  // Scrollback above the viewport is subtracted from the SGR row.
  const c = cellFromPoint({ ...base, totalRows: 25, y: 4 + 5 * 14 });
  assert(c.row === 1, "scrollback rows above the viewport don't shift SGR rows");
}
{
  const c = cellFromPoint({ ...base, x: 9999, y: 9999 });
  const d = cellFromPoint({ ...base, x: -50, y: -50 });
  assert(
    c.col === 40 && c.row === 20 && d.col === 1 && d.row === 1,
    "out-of-strip touches clamp into the grid"
  );
}

console.log(failures === 0 ? "\nAll sgrWheel tests passed." : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
