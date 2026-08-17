// T2 pure tests: scale-to-fit layout math (src/kessel/scaleLayout.ts,
// the live Watch path), the "Claim session" state machine
// (lib/claimState.ts), and the runCols column math port
// (api/gridConvert.ts).
//
// Run:  node scripts/test-scale-claim.mjs   (Node 24 native TS
// type-stripping; everything imported is DOM-free by design).

import {
  computeScaleLayout,
  PASSIVE_SCALE_FLOOR,
  PINNED_SCALE_FLOOR,
} from "../src/kessel/scaleLayout.ts";
import {
  initialClaimState,
  reduceClaim,
  pinnedByOther,
  canEmitSize,
  showClaimButton,
} from "../src/lib/claimState.ts";
import {
  runColSpan,
  runColOffsets,
  runCells,
  rowNeedsAnchoring,
} from "../src/api/gridConvert.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── 1. computeScaleLayout ──
function testScaleLayout() {
  console.log("\n[scaleLayout] computeScaleLayout decision table");
  // Live Kessel contract: avail = container − 4. Values below pick
  // container so avail matches the old exact-fit 480×336 grid.
  const base = {
    snapCols: 80, snapRows: 24,
    cellWidth: 6, cellHeight: 14,       // grid = 480×336
    containerWidth: 484, containerHeight: 340,
    isActiveViewer: true, pinned: false, pendingResize: null,
  };

  assert(
    computeScaleLayout({ ...base, snapCols: 0 }).scale === 1 &&
    computeScaleLayout({ ...base, cellWidth: 0 }).scale === 1,
    "no grid / no metrics → identity"
  );

  const exact = computeScaleLayout(base);
  assert(exact.scale === 1 && exact.offsetX === 0 && exact.offsetY === 0 && !exact.passive,
    "grid sized to this box → unscaled, no offsets");

  // Sub-cell remainder splits into symmetric whole-px gutters.
  const slack = computeScaleLayout({ ...base, containerWidth: 493 }); // avail 489
  assert(slack.scale === 1 && slack.offsetX === 4 && !slack.passive,
    "scale-1 remainder centers, floored to whole px (9px slack → 4px left)");

  // Passive viewer, grid twice the box → scale 0.5, letterboxed.
  const passive = computeScaleLayout({
    ...base, isActiveViewer: false,
    containerWidth: 244, containerHeight: 172,
  });
  assert(near(passive.scale, 0.5) && passive.passive,
    "passive overflow → scale = fit (0.5), passive pill on");
  assert(near(passive.offsetX, 0) && near(passive.offsetY, 0),
    "exact-ratio letterbox → zero offsets");

  const passiveTall = computeScaleLayout({
    ...base, isActiveViewer: false,
    containerWidth: 484, containerHeight: 172, // height-limited: fit 0.5
  });
  assert(near(passiveTall.scale, 0.5) && near(passiveTall.offsetX, 120),
    "height-limited fit letterboxes horizontally ((480-240)/2 = 120)");

  // Passive floor 0.40: grid 10× the box clamps at the floor.
  const floored = computeScaleLayout({
    ...base, isActiveViewer: false,
    containerWidth: 52, containerHeight: 37.6,
  });
  assert(near(floored.scale, PASSIVE_SCALE_FLOOR) && floored.passive,
    "passive floor clamps at 0.40 (clip beyond)");

  // Pinned: floor drops to 0.25, and the pill never shows.
  const pinnedFloor = computeScaleLayout({
    ...base, pinned: true,
    containerWidth: 52, containerHeight: 37.6,
  });
  assert(near(pinnedFloor.scale, PINNED_SCALE_FLOOR) && !pinnedFloor.passive,
    "pinned floor 0.25, passive=false (pin badge, not pill)");

  const pinnedFits = computeScaleLayout({ ...base, pinned: true });
  assert(pinnedFits.scale === 1 && !pinnedFits.passive,
    "pinned grid that fits renders centered 1:1");

  // Pinned wins over a stale pendingResize hold.
  const pinnedHold = computeScaleLayout({
    ...base, pinned: true, isActiveViewer: true,
    pendingResize: { cols: 40, rows: 12 },
    containerWidth: 244, containerHeight: 172,
  });
  assert(near(pinnedHold.scale, 0.5) && !pinnedHold.passive,
    "pinned branch ignores pendingResize (no stretch of a clamped grid)");

  // Active + resize in flight, box GREW → stretch beyond 1.
  const stretch = computeScaleLayout({
    ...base, pendingResize: { cols: 160, rows: 48 },
    containerWidth: 964, containerHeight: 676,
  });
  assert(near(stretch.scale, 2) && !stretch.passive,
    "hold-and-scale: old grid stretches to the grown box (scale 2)");

  // Active + resize in flight, box SHRANK → old grid scales down.
  const shrinkHold = computeScaleLayout({
    ...base, pendingResize: { cols: 40, rows: 12 },
    containerWidth: 244, containerHeight: 172,
  });
  assert(near(shrinkHold.scale, 0.5) && !shrinkHold.passive,
    "hold-and-scale: old grid shrinks into the smaller box (scale 0.5)");

  // Frames reached the requested dims → hold is over, 1:1.
  const holdDone = computeScaleLayout({
    ...base, pendingResize: { cols: 80, rows: 24 },
  });
  assert(holdDone.scale === 1 && holdDone.offsetX === 0,
    "frames at requested dims render 1:1 even with the hold set");

  // Active, no hold, dims mismatch → still centered 1:1 (transient).
  const activeMismatch = computeScaleLayout({
    ...base, snapCols: 100, containerWidth: 484,
  });
  assert(activeMismatch.scale === 1 && !activeMismatch.passive,
    "active viewer without a hold renders 1:1 (mismatch is transient)");
}

// ── 2. Claim state machine ──
function testClaimState() {
  console.log("\n[claimState] reduceClaim transitions");
  let s = initialClaimState;
  assert(s.mode === "claimer" && !s.claimedByMe && s.pin === null,
    "initial: claimer (older daemons never send mode), unclaimed, unpinned");
  assert(canEmitSize(s) && showClaimButton(s),
    "initial: may claim/resize, claim button shows");

  // Viewer mode: fully read-only.
  const v = reduceClaim(s, { type: "mode", mode: "viewer", capable: false });
  assert(v.mode === "viewer" && !canEmitSize(v) && !showClaimButton(v),
    "mode=viewer → no size emissions, no claim UI");

  // Pinned by someone else at connect.
  const p = reduceClaim(s, { type: "pin_initial", cols: 120, rows: 40, setBy: "owner" });
  assert(pinnedByOther(p) && !p.claimedByMe && p.pin.cols === 120 && p.pin.setBy === "owner",
    "pin_initial → pinned by other (never ours on a fresh connection)");
  assert(!canEmitSize(p) && !showClaimButton(p),
    "pinned by other → no emissions, no claim button");

  // Tap "Claim session" → optimistic ownership; broadcast ack confirms.
  s = reduceClaim(s, { type: "claim_sent", cols: 62, rows: 30 });
  assert(s.claimedByMe && s.lastClaimSent.cols === 62 && !pinnedByOther(s),
    "claim_sent → claimed optimistically, lastClaimSent recorded");
  assert(!showClaimButton(s), "claimed → claim button yields to the release badge");

  s = reduceClaim(s, { type: "pin_changed", cols: 62, rows: 30, cleared: false });
  assert(s.claimedByMe && s.pin.cols === 62,
    "pin_changed at OUR dims = the broadcast ack → still ours");

  // Keyboard transition while claimed: re-claim at new dims, then ack.
  s = reduceClaim(s, { type: "claim_sent", cols: 62, rows: 18 });
  s = reduceClaim(s, { type: "pin_changed", cols: 62, rows: 18, cleared: false });
  assert(s.claimedByMe && s.pin.rows === 18 && s.lastClaimSent.rows === 18,
    "keyboard re-claim: new dims ack keeps ownership");

  // Another client pins over us (last-write-wins).
  const stolen = reduceClaim(s, { type: "pin_changed", cols: 200, rows: 50, cleared: false });
  assert(!stolen.claimedByMe && pinnedByOther(stolen) && stolen.pin.cols === 200,
    "pin_changed at foreign dims → theirs now (drop to scale-to-fit + badge)");

  // Desktop manually unpins us.
  const unpinned = reduceClaim(s, { type: "pin_changed", cleared: true });
  assert(!unpinned.claimedByMe && unpinned.pin === null && unpinned.lastClaimSent === null,
    "pin_changed cleared (manual unpin from the other end) → fully reset");

  // Our own release tap (optimistic; POST clear confirms via broadcast).
  const released = reduceClaim(s, { type: "release_sent" });
  assert(!released.claimedByMe && released.pin === null && showClaimButton(released),
    "release_sent → unclaimed, claim button back");

  // Reconnect: ephemeral pins die with their socket.
  const reopened = reduceClaim(s, { type: "socket_open" });
  assert(!reopened.claimedByMe && reopened.pin === null,
    "socket_open resets ownership (daemon auto-cleared on disconnect)");

  // Viewer flip while claimed drops everything claim-ish.
  const viewerFlip = reduceClaim(s, { type: "mode", mode: "viewer", capable: false });
  assert(!viewerFlip.claimedByMe && viewerFlip.lastClaimSent === null,
    "claimer→viewer flip abandons the claim state");
}

// ── 3. runCols column math (desktop port subset) ──
function testRunCols() {
  console.log("\n[runCols] column spans / offsets / cells");
  assert(runColSpan({ text: "abc" }) === 3, "unannotated run: one column per char");
  assert(runColSpan({ text: "漢字", cols: 4 }) === 4, "annotated run: wire cols wins");
  assert(runColSpan({ text: "😀", cols: 2 }) === 2, "surrogate-pair emoji: cols=2, not UTF-16 length");

  const row = [{ text: "ab" }, { text: "漢", cols: 2 }, { text: "cd" }];
  assert(runColOffsets(row).join() === "0,2,4",
    "offsets are prefix sums of spans (wide char shifts the next run)");
  assert(rowNeedsAnchoring(row) && !rowNeedsAnchoring([{ text: "plain" }]),
    "rows anchor iff any run carries a cols annotation");

  const cells = runCells({ text: "a漢b", cols: 4 });
  assert(cells.length === 3 && cells[1].col === 1 && cells[1].width === 2 && cells[2].col === 3,
    "runCells: wide char takes 2 columns, follower lands at col 3");

  const zw = runCells({ text: "e\u0301x", cols: 2 }); // e + combining acute + x
  assert(zw.length === 2 && zw[0].text === "e\u0301" && zw[1].col === 1,
    "zero-width combiner folds into its base char's cell");
}

testScaleLayout();
testClaimState();
testRunCols();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
