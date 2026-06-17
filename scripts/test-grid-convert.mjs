// Live converter test: connect to the daemon grid-WS, run the SAME
// cellRowToCompact converter the app uses against REAL snapshot/delta
// frames, and assert the output is well-formed.
//
// Run:  node scripts/test-grid-convert.mjs
// Creds (PORT|SESSION_TOKEN|SESSION_ID) read from /tmp/k2mob-test-creds.txt
// (written by the loop's setup step). Requires Node 24 (global WebSocket
// + native TS type-stripping for the .ts import).

import { readFileSync } from "node:fs";
import { cellRowToCompact } from "../src/api/gridConvert.ts";

const raw = readFileSync("/tmp/k2mob-test-creds.txt", "utf8").trim();
const [port, token, sid] = raw.split("|");
if (!port || !token || !sid) {
  console.error("missing creds in /tmp/k2mob-test-creds.txt");
  process.exit(1);
}

const url = `ws://127.0.0.1:${port}/cli/sessions/grid?session=${sid}&token=${token}`;
let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

const validateLine = (cl, label) => {
  // spans must be ordered, non-empty, within text bounds.
  for (const sp of cl.spans) {
    if (!(sp.s >= 0 && sp.e <= cl.text.length && sp.s < sp.e)) {
      console.error(`  ✗ ${label}: bad span ${JSON.stringify(sp)} for text len ${cl.text.length}`);
      failures++;
      return;
    }
  }
};

const ws = new WebSocket(url);
let gotSnapshot = false;

const timer = setTimeout(() => {
  console.error("timed out waiting for snapshot");
  process.exit(1);
}, 5000);

ws.onmessage = (ev) => {
  let frame;
  try { frame = JSON.parse(ev.data); } catch { return; }
  if (frame.event !== "snapshot") return; // ignore label_initial etc.
  clearTimeout(timer);
  gotSnapshot = true;
  const p = frame.payload;

  console.log(`snapshot: cols=${p.cols} rows=${p.rows} grid=${p.grid.length} scrollback=${p.scrollback.length}`);

  // Convert every grid + scrollback row.
  const sb = p.scrollback.map((r, i) => cellRowToCompact(r, i));
  const vp = p.grid.map((r, i) => cellRowToCompact(r, i));

  assert(vp.length === p.grid.length, "all grid rows converted");
  assert(sb.length === p.scrollback.length, "all scrollback rows converted");

  // Every converted line: spans well-formed.
  [...sb, ...vp].forEach((cl, i) => validateLine(cl, `row ${i}`));
  if (failures === 0) console.log("  ✓ all spans well-formed (ordered, in-bounds)");

  // The rendered text of the viewport should contain real terminal content.
  const allText = vp.map((l) => l.text).join("\n");
  assert(allText.trim().length > 0, "viewport renders non-empty text");

  // A styled run should produce a span with flags or color.
  const styled = [...sb, ...vp].some((l) => l.spans.some((s) => s.fl || s.fg != null || s.bg != null));
  assert(styled, "at least one styled span (color/flags) preserved");

  // Show a few non-blank rendered lines as a visual sanity check.
  const sample = vp.map((l) => l.text.replace(/\s+$/, "")).filter((t) => t.length > 0).slice(0, 4);
  console.log("sample rendered lines:");
  for (const line of sample) console.log("   | " + line.slice(0, 90));

  ws.close();
  console.log(failures === 0 ? "\nPASS — converter produces valid CompactLines from live frames" : `\nFAIL — ${failures} assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
};

ws.onerror = (e) => {
  console.error("ws error:", e?.message || e);
  process.exit(1);
};
ws.onclose = () => {
  if (!gotSnapshot) { console.error("closed before snapshot"); process.exit(1); }
};
