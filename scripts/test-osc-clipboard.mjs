// T5b pure tests: OSC 52 clipboard apply policy (lib/oscClipboard.ts)
// — the dedupe guard (desktop oscClipboard.ts parity) and the wire
// payload extraction. `writeClipboard` is DOM-touching and exercised
// only for its no-navigator "unavailable" path here.
//
// Run:  node scripts/test-osc-clipboard.mjs

import {
  shouldApplyOsc52,
  clipboardTextFromPayload,
  writeClipboard,
} from "../src/lib/oscClipboard.ts";

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error("  ✗ " + msg); failures++; }
  else console.log("  ✓ " + msg);
};

// ── 1. shouldApplyOsc52 (desktop parity) ──
console.log("\n[oscClipboard] shouldApplyOsc52");
assert(
  shouldApplyOsc52(null, "") === false && shouldApplyOsc52("x", "") === false,
  "empty payload refused (a TUI clearing its selection must not blank the clipboard)"
);
assert(
  shouldApplyOsc52("same", "same") === false,
  "consecutive identical payloads refused (claude re-emits per repaint)"
);
assert(
  shouldApplyOsc52(null, "first") === true &&
  shouldApplyOsc52("old", "new") === true,
  "first / different payloads apply"
);
assert(
  shouldApplyOsc52("B", "A") === true,
  "A→B→A: a payload seen EARLIER still applies (three real copies)"
);

// ── 2. clipboardTextFromPayload ──
console.log("\n[oscClipboard] clipboardTextFromPayload");
assert(
  clipboardTextFromPayload({ text: "hello-osc52" }) === "hello-osc52",
  "daemon clipboard_frame shape {text} → the text"
);
assert(
  clipboardTextFromPayload(null) === "" &&
  clipboardTextFromPayload({ text: 42 }) === "" &&
  clipboardTextFromPayload("raw") === "",
  "defensive: null / wrong-typed / non-object payloads → '' (then refused)"
);

// ── 3. writeClipboard without a navigator ──
console.log("\n[oscClipboard] writeClipboard headless");
const r = await writeClipboard("anything");
assert(
  r === "unavailable",
  "no navigator.clipboard → 'unavailable' (caller shows the manual-copy fallback)"
);

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall oscClipboard tests passed");
