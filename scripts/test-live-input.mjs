// Validates T4's live text-commit pipeline (lib/liveInputText.ts): the
// iOS smart-dash reversal, the commit decisions (ASCII now / IME defer
// 150ms / Hangul wait), control-byte flush ordering, backspace-as-
// local-edit on pending text, and the composition-aware pipeline (the
// WKWebView adaptation of Orca's timer-only strategy).
//
// Run:  node scripts/test-live-input.mjs

import {
  normalizeTerminalTextInput,
  getTextChangeDecision,
  getDeferredTextDelayMs,
  getControlByteDecision,
  getLocalEditText,
  isImeTextCandidate,
  isHangulTextCandidate,
  LIVE_TEXT_COMMIT_DELAY_MS,
  LiveTextCommitPipeline,
} from "../src/lib/liveInputText.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A recording sink + fresh pipeline per scenario.
const rig = () => {
  const sent = [];
  let field = null; // last setFieldValue, null = untouched
  const p = new LiveTextCommitPipeline({
    sendBytes: (b) => sent.push(b),
    setFieldValue: (v) => { field = v; },
  });
  return { p, sent, fieldValue: () => field };
};

// ── Smart-dash normalization (ported verbatim) ──
console.log("[normalize] iOS smart-dash reversal");
assert(normalizeTerminalTextInput("a—b") === "a--b", "em dash → --");
assert(normalizeTerminalTextInput("a–b") === "a--b", "en dash → --");
assert(normalizeTerminalTextInput("plain -- text") === "plain -- text", "ASCII hyphens untouched");
assert(normalizeTerminalTextInput("abc—", "abc--") === "abc---", "collapsed hyphen run recovers the full run + the new hyphen");
assert(normalizeTerminalTextInput("abc—", "abc-") === "abc--", "single trailing hyphen is NOT the collapse case (plain replacement)");

// ── Commit decisions ──
console.log("\n[decide] text-change decisions");
assert(getTextChangeDecision("").kind === "ignore", "empty input ignored");
assert(getTextChangeDecision("ls -la").kind === "send-now", "plain ASCII sends immediately");
const ime = getTextChangeDecision("é");
assert(ime.kind === "defer" && ime.delayMs === LIVE_TEXT_COMMIT_DELAY_MS, "non-ASCII defers 150ms");
const hangul = getTextChangeDecision("한");
assert(hangul.kind === "defer" && hangul.delayMs === null, "Hangul waits (no timer)");
assert(isImeTextCandidate("日") && !isImeTextCandidate("abc"), "IME candidate = any codepoint > 0x7f");
assert(isHangulTextCandidate("ㄱ") && !isHangulTextCandidate("日"), "Hangul ranges detected specifically");
assert(getDeferredTextDelayMs("가") === null && getDeferredTextDelayMs("ü") === LIVE_TEXT_COMMIT_DELAY_MS, "deferred delay follows the Hangul rule");

// ── Control-byte decisions ──
console.log("\n[decide] control bytes vs pending text");
assert(getControlByteDecision({ bytes: "\r", pendingText: "" }).kind === "send-now", "no pending → send-now");
const flush = getControlByteDecision({ bytes: "\x03", pendingText: "é" });
assert(flush.kind === "flush-then-send" && flush.pendingText === "é" && flush.bytes === "\x03", "pending text flushes BEFORE the control byte");
assert(getControlByteDecision({ bytes: "\x7f", localEdit: "backspace", pendingText: "é" }).kind === "local-edit", "backspace with pending → local edit, no \\x7f");
assert(getLocalEditText({ localEdit: "backspace", pendingText: "ab" }) === "a", "backspace local edit trims one char");
assert(getLocalEditText({ localEdit: "backspace", pendingText: "a\u{1F44D}" }) === "a", "…by CODE POINT (emoji-safe)");
assert(getLocalEditText({ localEdit: "delete", pendingText: "ab" }) === "ab", "forward delete never eats pending IME text");

// ── Pipeline: plain ASCII path ──
console.log("\n[pipeline] ASCII immediate commit");
{
  const { p, sent, fieldValue } = rig();
  p.fieldInput("h");
  p.fieldInput("i");
  assert(sent.join("|") === "h|i", "each keystroke commits immediately");
  assert(fieldValue() === "", "field cleared after every commit (nothing visible)");
  p.controlBytes("\r");
  assert(sent[2] === "\r" && sent.length === 3, "Enter sends \\r exactly once");
}

// ── Pipeline: composition events (the web-first path) ──
console.log("\n[pipeline] composition buffer → compositionend commit");
{
  const { p, sent } = rig();
  p.compositionStart();
  p.fieldInput("ㄴ");
  p.fieldInput("나");
  assert(sent.length === 0, "nothing sent while the IME composes");
  assert(p.pendingText === "나" && p.isComposing, "composition buffer tracked as pending");
  p.compositionEnd("나");
  assert(sent.join("") === "나", "compositionend emits exactly the composed text");
  assert(!p.isComposing && p.pendingText === "", "pipeline settles after compositionend");
  p.compositionStart();
  p.compositionEnd("");
  assert(sent.length === 1, "canceled composition sends nothing");
}

// ── Pipeline: deferred non-ASCII fallback (no composition events) ──
console.log("\n[pipeline] Orca timer fallback + flush ordering");
{
  const { p, sent } = rig();
  p.fieldInput("é");
  assert(sent.length === 0, "non-ASCII without composition defers");
  p.controlBytes("\r");
  assert(sent.join("|") === "é|\r", "control byte flushes pending FIRST (ordering)");
}
{
  const { p, sent } = rig();
  p.fieldInput("ü");
  await sleep(LIVE_TEXT_COMMIT_DELAY_MS + 60);
  assert(sent.join("") === "ü", "deferred text settles after 150ms");
}
{
  const { p, sent } = rig();
  p.fieldInput("한");
  await sleep(LIVE_TEXT_COMMIT_DELAY_MS + 60);
  assert(sent.length === 0, "Hangul never settles on a timer (waits for more input)");
  p.controlBytes("\r");
  assert(sent.join("|") === "한|\r", "…but still flushes before Enter");
}

// ── Pipeline: backspace semantics ──
console.log("\n[pipeline] backspace local edit vs PTY \\x7f");
{
  const { p, sent, fieldValue } = rig();
  p.fieldInput("é");
  p.controlBytes("\x7f", "backspace");
  assert(sent.length === 0, "backspace on pending text sends NOTHING");
  assert(p.pendingText === "" && fieldValue() === "", "…it edited the pending text locally");
  p.controlBytes("\x7f", "backspace");
  assert(sent.join("") === "\x7f", "backspace with nothing pending sends \\x7f");
}
{
  const { p, sent } = rig();
  p.compositionStart();
  p.fieldInput("ㄴ");
  p.controlBytes("\x7f", "backspace");
  assert(sent.length === 0 && p.isComposing, "backspace DURING composition is the IME's (never intercepted)");
  p.compositionEnd("나");
  assert(sent.join("") === "나", "composition still commits normally after it");
}

// ── Pipeline: pre-composition pending + newline stripping ──
console.log("\n[pipeline] edges");
{
  const { p, sent } = rig();
  p.fieldInput("é");
  p.compositionStart();
  assert(sent.join("") === "é", "text deferred BEFORE an IME opens flushes at compositionstart");
  p.compositionEnd("나");
  assert(sent.join("|") === "é|나", "…so bytes arrive in typed order");
}
{
  const { p, sent } = rig();
  p.fieldInput("hi\n");
  assert(sent.join("") === "hi", "a leaked newline in the field NEVER becomes bytes (Enter is keydown's alone)");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
