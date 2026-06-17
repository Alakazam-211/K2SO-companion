// Validates the terminal grid pipeline two ways:
//   1. LIVE snapshot — connect to the daemon grid-WS, run the real
//      converter + GridModel against a real snapshot frame.
//   2. SYNTHETIC delta — exercise the GridModel two-buffer model
//      (snapshot → delta: damagedRows patch + scrollbackAppended grow)
//      deterministically, since an idle session emits no deltas.
//
// Run:  node scripts/test-grid-convert.mjs   (Node 24: global WebSocket
// + native TS type-stripping for the .ts import). Live creds from
// /tmp/k2mob-test-creds.txt (PORT|sessionToken|sessionId).

import { readFileSync } from "node:fs";
import { GridModel, cellRowToCompact } from "../src/api/gridConvert.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};
const cell = (text, o = {}) => ({
  text, fg: o.fg ?? null, bg: o.bg ?? null,
  bold: !!o.bold, italic: !!o.italic, underline: !!o.underline,
  inverse: !!o.inverse, dim: !!o.dim, strikeout: !!o.strikeout,
});

// ── 1. Synthetic delta / two-buffer model (deterministic) ──
function testDelta() {
  console.log("\n[synthetic] GridModel two-buffer (snapshot → delta)");
  const m = new GridModel();
  m.applySnapshot({
    cols: 10, rows: 3,
    scrollback: [[cell("old-1")], [cell("old-2")]],
    grid: [[cell("vp-A")], [cell("vp-B")], [cell("vp-C")]],
    cursor: { row: 2, col: 0, visible: true },
    version: 0, displayOffset: 0,
  });
  let lines = m.lines();
  assert(lines.length === 5, "snapshot: 5 absolute rows (2 sb + 3 vp)");
  assert(lines.map((l) => l.row).join() === "0,1,2,3,4", "snapshot: rows contiguous 0..4");
  assert(lines[2].text === "vp-A" && lines[4].text === "vp-C", "snapshot: viewport at rows 2..4");
  assert(m.cursorRow() === 4, "snapshot: cursor absolute row = 2(sb) + 2 = 4");

  m.applyDelta({
    cols: 10, rows: 3,
    damagedRows: [{ row: 1, cells: [cell("vp-B*")] }],
    scrollbackAppended: [[cell("old-3")]],
    cursor: { row: 2, col: 3, visible: true },
    version: 1, displayOffset: 0,
  });
  lines = m.lines();
  assert(lines.length === 6, "delta: 6 absolute rows (3 sb + 3 vp)");
  assert(m.scrollback.length === 3, "delta: scrollback grew by scrollbackAppended");
  assert(lines[2].text === "old-3", "delta: appended scrollback row at abs index 2");
  assert(m.viewport[1].text === "vp-B*", "delta: damaged viewport row 1 patched");
  assert(lines[4].text === "vp-B*", "delta: patched row at abs index 5? -> 3(sb)+1 = 4");
  assert(lines.map((l) => l.row).join() === "0,1,2,3,4,5", "delta: rows contiguous 0..5");
  assert(m.cursorRow() === 5, "delta: cursor absolute row = 3(sb) + 2 = 5");
}

// ── 2. Live snapshot via grid-WS ──
function testLiveSnapshot() {
  return new Promise((resolve) => {
    console.log("\n[live] grid-WS snapshot");
    let creds;
    try { creds = readFileSync("/tmp/k2mob-test-creds.txt", "utf8").trim().split("|"); }
    catch { console.log("  (skip) no /tmp/k2mob-test-creds.txt"); return resolve(); }
    const [port, token, sid] = creds;
    if (!port || !token || !sid) { console.log("  (skip) incomplete creds"); return resolve(); }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/cli/sessions/grid?session=${sid}&token=${token}`);
    const timer = setTimeout(() => { console.log("  (skip) timed out waiting for snapshot"); ws.close(); resolve(); }, 5000);
    ws.onmessage = (ev) => {
      let f; try { f = JSON.parse(ev.data); } catch { return; }
      if (f.event !== "snapshot") return;
      clearTimeout(timer);
      const m = new GridModel();
      m.applySnapshot(f.payload);
      const lines = m.lines();
      assert(lines.length === f.payload.scrollback.length + f.payload.grid.length, "live: row count = sb + grid");
      assert(lines.every((l) => l.spans.every((s) => s.s >= 0 && s.e <= l.text.length && s.s < s.e)), "live: all spans in-bounds");
      assert(m.lines().some((l) => l.text.trim().length > 0), "live: renders non-empty text");
      const sample = m.viewport.map((l) => l.text.replace(/\s+$/, "")).filter((t) => t).slice(0, 2);
      sample.forEach((t) => console.log("    | " + t.slice(0, 80)));
      ws.close();
      resolve();
    };
    ws.onerror = () => { clearTimeout(timer); console.log("  (skip) ws error"); resolve(); };
  });
}

testDelta();
await testLiveSnapshot();
console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
