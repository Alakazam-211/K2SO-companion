// Validates the T1 terminal protocol foundation, pure-logic only:
//   1. k1 DECODE — hand-ENCODED binary fixtures (tiny encoder below,
//      built per the frozen spec in gridWire.ts / grid_wire.rs) fed
//      through decodeGridFrame; asserts exact JSON-path object shapes
//      (key ABSENCE included — wrapped/cols only when set).
//   2. MALFORMED frames — bad magic / version / kind / truncation all
//      throw (protocol violations must fail loudly).
//   3. frameCoalescer — one apply per flush, arrival order, snapshot
//      supersede, starvation cap, clear.
//   4. END-TO-END — decoded k1 frames through GridModel: per-run
//      `cols` spans + wrapped survive into CompactLine.runs.
//
// Run:  node scripts/test-k1-wire.mjs   (Node 24: native TS
// type-stripping for the .ts imports). No daemon needed.

import { decodeGridFrame } from "../src/api/gridWire.ts";
import { createFrameCoalescer, STARVATION_FLUSH_CAP } from "../src/lib/frameCoalescer.ts";
import { GridModel } from "../src/api/gridConvert.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

// ── Tiny k1 ENCODER (tests only — the client never encodes; the
//    daemon's grid_wire.rs is the production encoder) ──

const STYLE = { bold: 1, italic: 2, underline: 4, inverse: 8, dim: 16, strikeout: 32, wrapped: 64 };
const HAS_COLS = 128;

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >>> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16(Math.floor(v / 65536)); }
  u64(v) {
    let b = BigInt(v);
    for (let i = 0; i < 8; i++) { this.u8(Number(b & 0xffn)); b >>= 8n; }
  }
  str(s) {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    for (const x of b) this.bytes.push(x);
  }
  color(c) { this.u32(c === null || c === undefined ? 0xffffffff : c); }
  run(r) {
    this.str(r.text);
    this.color(r.fg);
    this.color(r.bg);
    let bits = 0;
    for (const [k, bit] of Object.entries(STYLE)) if (r[k]) bits |= bit;
    if (r.cols !== undefined) bits |= HAS_COLS;
    this.u8(bits);
    if (r.cols !== undefined) this.u16(r.cols);
  }
  row(runs) { this.u16(runs.length); for (const r of runs) this.run(r); }
  rows(rs) { this.u32(rs.length); for (const r of rs) this.row(r); }
  cursor(c) { this.u16(c.row); this.u16(c.col); this.u8(c.visible ? 1 : 0); }
  header(kind) { this.u8(0x6b); this.u8(1); this.u8(kind); }
  buffer() { return new Uint8Array(this.bytes).buffer; }
}

function encodeSnapshot(p) {
  const w = new Writer();
  w.header(1);
  w.str(p.paneId);
  w.u16(p.cols); w.u16(p.rows);
  w.u64(p.version); w.u32(p.displayOffset);
  w.cursor(p.cursor);
  w.u8((p.mouseReport ? 1 : 0) | (p.sgrMouse ? 2 : 0) | (p.altScreen ? 4 : 0));
  w.rows(p.grid);
  w.rows(p.scrollback);
  return w.buffer();
}

function encodeDelta(p) {
  const w = new Writer();
  w.header(2);
  w.str(p.paneId);
  w.u16(p.cols); w.u16(p.rows);
  w.u64(p.version); w.u32(p.displayOffset);
  w.cursor(p.cursor);
  w.u32(p.damagedRows.length);
  for (const d of p.damagedRows) { w.u16(d.row); w.row(d.runs); }
  w.rows(p.scrollbackAppended);
  return w.buffer();
}

// ── 1. Snapshot decode ──

function testSnapshotDecode() {
  console.log("\n[k1] snapshot decode");
  const buf = encodeSnapshot({
    paneId: "pane-1",
    cols: 80, rows: 24,
    version: 5_000_000_001, // > 2^32 — exercises the u64 read
    displayOffset: 3,
    cursor: { row: 5, col: 7, visible: true },
    mouseReport: true, sgrMouse: false, altScreen: true,
    grid: [
      [{ text: "hello" }],
      [
        { text: "ab", fg: 0xff0000, bg: 0x001122, bold: true, underline: true },
        { text: "cd", wrapped: true },
      ],
      [
        { text: "你好", cols: 4 },          // wide CJK: 2 chars, 4 columns
        { text: "é", cols: 1 },               // combining accent: 2 chars, 1 column
      ],
    ],
    scrollback: [[{ text: "old" }]],
  });
  const f = decodeGridFrame(buf);
  assert(f.kind === "snapshot", "kind = snapshot");
  const p = f.payload;
  assert(p.paneId === "pane-1", "paneId roundtrips");
  assert(p.cols === 80 && p.rows === 24, "cols/rows");
  assert(p.version === 5_000_000_001, "u64 version > 2^32 exact");
  assert(p.displayOffset === 3, "displayOffset");
  assert(p.cursor.row === 5 && p.cursor.col === 7 && p.cursor.visible === true, "cursor");
  assert(p.mouseReport === true && p.sgrMouse === false && p.altScreen === true, "mode bits");
  assert(p.grid.length === 3 && p.scrollback.length === 1, "grid + scrollback row counts");

  const plain = p.grid[0][0];
  assert(plain.text === "hello" && plain.fg === null && plain.bg === null, "plain run: text + default colors → null");
  assert(
    JSON.stringify(Object.keys(plain).sort()) ===
      JSON.stringify(["bg", "bold", "dim", "fg", "inverse", "italic", "strikeout", "text", "underline"]),
    "plain run: wrapped/cols keys ABSENT (JSON-path shape parity)",
  );
  assert(!plain.bold && !plain.italic && !plain.underline && !plain.inverse && !plain.dim && !plain.strikeout, "plain run: all style flags false");

  const styled = p.grid[1][0];
  assert(styled.fg === 0xff0000 && styled.bg === 0x001122, "styled run: fg/bg colors");
  assert(styled.bold === true && styled.underline === true && styled.italic === false, "styled run: style bits");

  const wrapped = p.grid[1][1];
  assert(wrapped.wrapped === true && !("cols" in wrapped), "wrapped run: wrapped key present, cols absent");

  const wide = p.grid[2][0];
  assert(wide.text === "你好" && wide.cols === 4, "wide run: multibyte UTF-8 text + cols span");
  const zero = p.grid[2][1];
  assert(zero.text === "é" && zero.cols === 1, "zero-width run: cols < char count");
  assert(p.scrollback[0][0].text === "old", "scrollback row content");
}

// ── 2. Delta decode ──

function testDeltaDecode() {
  console.log("\n[k1] delta decode");
  const buf = encodeDelta({
    paneId: "pane-1",
    cols: 80, rows: 24,
    version: 42,
    displayOffset: 0,
    cursor: { row: 0, col: 1, visible: false },
    damagedRows: [
      { row: 3, runs: [{ text: "patched", fg: 0x00ff00, dim: true }] },
      { row: 10, runs: [] }, // cleared row: zero runs is legal
    ],
    scrollbackAppended: [[{ text: "sb-1" }], [{ text: "sb-2", wrapped: true }]],
  });
  const f = decodeGridFrame(buf);
  assert(f.kind === "delta", "kind = delta");
  const p = f.payload;
  assert(p.paneId === "pane-1" && p.version === 42, "paneId + version");
  assert(p.cursor.visible === false, "cursor visible=false");
  assert(p.damagedRows.length === 2, "damaged row count");
  assert(p.damagedRows[0].row === 3 && p.damagedRows[0].runs[0].text === "patched", "damaged row index + content");
  assert(p.damagedRows[0].runs[0].fg === 0x00ff00 && p.damagedRows[0].runs[0].dim === true, "damaged run style");
  assert(p.damagedRows[1].row === 10 && p.damagedRows[1].runs.length === 0, "empty (cleared) damaged row");
  assert(p.scrollbackAppended.length === 2 && p.scrollbackAppended[1][0].wrapped === true, "scrollbackAppended rows + wrapped");
}

// ── 3. Malformed frames throw ──

function testMalformed() {
  console.log("\n[k1] malformed frames fail loudly");
  const ok = encodeDelta({
    paneId: "p", cols: 1, rows: 1, version: 1, displayOffset: 0,
    cursor: { row: 0, col: 0, visible: true }, damagedRows: [], scrollbackAppended: [],
  });
  const throws = (buf, label) => {
    try { decodeGridFrame(buf); assert(false, label); }
    catch { assert(true, label); }
  };
  const mutate = (i, v) => { const b = new Uint8Array(ok.slice(0)); b[i] = v; return b.buffer; };
  throws(mutate(0, 0x00), "bad magic throws");
  throws(mutate(1, 9), "unsupported wire version throws");
  throws(mutate(2, 7), "unknown frame kind throws");
  throws(ok.slice(0, ok.byteLength - 3), "truncated frame throws");
  const good = decodeGridFrame(ok);
  assert(good.kind === "delta", "untouched fixture still decodes (mutations were the cause)");
}

// ── 4. frameCoalescer policy ──

function testCoalescer() {
  console.log("\n[coalescer] rAF policy");
  const mk = () => {
    const s = { flush: null, scheduleCalls: 0, cancelCalls: 0, applied: [] };
    s.c = createFrameCoalescer({
      schedule: (fl) => { s.flush = fl; s.scheduleCalls++; return s.scheduleCalls; },
      cancel: () => { s.cancelCalls++; },
      apply: (batch) => { s.applied.push(batch); },
    });
    return s;
  };
  const d = (v) => ({ kind: "delta", v });
  const snap = (v) => ({ kind: "snapshot", v });

  // One apply per flush, arrival order preserved.
  let s = mk();
  s.c.enqueue(d(1)); s.c.enqueue(d(2)); s.c.enqueue(d(3));
  assert(s.scheduleCalls === 1, "N enqueues → 1 scheduled flush");
  assert(s.applied.length === 0, "nothing applies before the flush runs");
  s.flush();
  assert(s.applied.length === 1, "one apply per flush");
  assert(s.applied[0].map((f) => f.v).join() === "1,2,3", "batch preserves arrival order");
  assert(s.c.pendingCount() === 0, "queue drained");
  s.c.flush();
  assert(s.applied.length === 1, "empty flush is a no-op");

  // Snapshot supersedes everything queued before it.
  s = mk();
  s.c.enqueue(d(1)); s.c.enqueue(d(2)); s.c.enqueue(snap(3)); s.c.enqueue(d(4));
  s.flush();
  assert(s.applied[0].map((f) => f.v).join() === "3,4", "queued snapshot supersedes earlier frames");

  // Starvation cap: synchronous flush at the cap, scheduled rAF cancelled.
  s = mk();
  for (let i = 1; i <= STARVATION_FLUSH_CAP; i++) s.c.enqueue(d(i));
  assert(s.applied.length === 1, `cap ${STARVATION_FLUSH_CAP}: flushes synchronously without rAF`);
  assert(s.applied[0].length === STARVATION_FLUSH_CAP, "cap flush carries the whole backlog");
  assert(s.cancelCalls === 1, "cap flush cancels the starved scheduled callback");
  s.c.enqueue(d(99));
  assert(s.scheduleCalls === 2, "post-cap enqueue schedules a fresh flush");

  // clear(): cancels + drops without applying.
  s = mk();
  s.c.enqueue(d(1)); s.c.enqueue(d(2));
  s.c.clear();
  assert(s.cancelCalls === 1 && s.c.pendingCount() === 0, "clear cancels the scheduled flush and empties the queue");
  s.flush();
  assert(s.applied.length === 0, "cleared frames never apply");
}

// ── 5. End-to-end: k1 decode → GridModel keeps cols spans ──

function testEndToEnd() {
  console.log("\n[e2e] k1 → GridModel faithful data model");
  const snapBuf = encodeSnapshot({
    paneId: "p", cols: 10, rows: 2, version: 1, displayOffset: 0,
    cursor: { row: 1, col: 0, visible: true },
    mouseReport: false, sgrMouse: false, altScreen: false,
    grid: [
      [{ text: "你好", cols: 4 }, { text: "!" }],
      [{ text: "wrap", wrapped: true }],
    ],
    scrollback: [],
  });
  const m = new GridModel();
  const sf = decodeGridFrame(snapBuf);
  m.applySnapshot(sf.payload);
  const lines = m.lines();
  assert(lines[0].runs.length === 2, "line keeps per-run boundaries");
  assert(lines[0].runs[0].cols === 4 && lines[0].runs[0].text === "你好", "wide run's cols span survives into the model");
  assert(!("cols" in lines[0].runs[1]), "one-col-per-char run stays unannotated");
  assert(lines[1].wrapped === true, "run wrapped flag surfaces on the line");
  assert(lines[0].text === "你好!", "joined text unchanged for existing consumers");

  const deltaBuf = encodeDelta({
    paneId: "p", cols: 10, rows: 2, version: 2, displayOffset: 0,
    cursor: { row: 1, col: 2, visible: true },
    damagedRows: [{ row: 0, runs: [{ text: "\u{1f680}", cols: 2 }] }],
    scrollbackAppended: [],
  });
  const df = decodeGridFrame(deltaBuf);
  m.applyDelta(df.payload);
  assert(m.viewport[0].runs[0].cols === 2, "delta-patched row carries cols span (emoji = 2 columns)");
  assert(m.viewport[0].text === "\u{1f680}", "delta-patched text");
}

testSnapshotDecode();
testDeltaDecode();
testMalformed();
testCoalescer();
testEndToEnd();
console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
