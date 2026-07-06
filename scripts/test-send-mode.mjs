// Validates T3's pure logic (lib/sendMode.ts): the per-terminal Safe/
// Direct mode model (Orca's set-of-Direct-handles shape: Safe default,
// no-op identity, dead-handle pruning), the session-role registry, and
// the MsgResponse→user-line mapping for /cli/terminal/send-message.
//
// Run:  node scripts/test-send-mode.mjs   (Node 24 native TS
// type-stripping for the .ts import — the test-grid-convert.mjs idiom).

import {
  modeFor, withMode, pruneHandles,
  getDirectHandles, subscribeSendModes, getSendMode, setSendMode, pruneSendModes,
  getSessionRoles, subscribeSessionRoles, getSessionRole, setSessionRole, pruneSessionRoles,
  __resetSendModeForTests,
  interpretSendResponse, REMOTE_INSTRUCT_DECLINE,
} from "../src/lib/sendMode.ts";

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error("  x " + msg); failures++; } else console.log("  ok " + msg); };

// ── Pure core: modeFor / withMode / pruneHandles ──
const empty = new Set();
assert(modeFor(empty, "t1") === "safe", "Safe is the one-shot default (absent handle)");
const d1 = withMode(empty, "t1", "direct");
assert(modeFor(d1, "t1") === "direct" && modeFor(d1, "t2") === "safe", "withMode(direct) flips only that terminal");
assert(withMode(d1, "t1", "direct") === d1, "redundant set is a no-op (same reference)");
assert(withMode(empty, "t1", "safe") === empty, "setting safe on an absent handle is a no-op");
const d2 = withMode(d1, "t1", "safe");
assert(modeFor(d2, "t1") === "safe" && d2 !== d1, "withMode(safe) returns a NEW pruned set");
const d3 = withMode(withMode(empty, "a", "direct"), "b", "direct");
assert(pruneHandles(d3, ["a", "b", "c"]) === d3, "prune with all handles live is identity");
const d4 = pruneHandles(d3, ["b"]);
assert(modeFor(d4, "a") === "safe" && modeFor(d4, "b") === "direct", "prune drops dead handles, keeps live ones");
assert(pruneHandles(d3, []).size === 0, "prune against nothing live empties the set");

// ── Store: session-local, subscribable, prunable ──
__resetSendModeForTests();
let notified = 0;
const unsub = subscribeSendModes(() => notified++);
assert(getSendMode("x") === "safe", "store defaults to safe");
setSendMode("x", "direct");
assert(getSendMode("x") === "direct" && notified === 1, "setSendMode flips + notifies");
const snap = getDirectHandles();
setSendMode("x", "direct");
assert(notified === 1 && getDirectHandles() === snap, "redundant setSendMode neither notifies nor swaps the snapshot");
setSendMode("y", "direct");
pruneSendModes(["y"]);
assert(getSendMode("x") === "safe" && getSendMode("y") === "direct", "pruneSendModes GCs the dead handle only");
pruneSendModes(["y"]);
assert(notified === 3, "identity prune does not notify");
unsub();
setSendMode("x", "direct");
assert(notified === 3, "unsubscribe stops notifications");

// ── Session-role registry ──
__resetSendModeForTests();
let roleNotified = 0;
subscribeSessionRoles(() => roleNotified++);
assert(getSessionRole("s1") === null, "unknown session has no role (composer stays visible)");
setSessionRole("s1", "viewer");
assert(getSessionRole("s1") === "viewer" && roleNotified === 1, "setSessionRole records + notifies");
setSessionRole("s1", "viewer");
assert(roleNotified === 1, "redundant role set does not notify");
setSessionRole("s1", "claimer");
assert(getSessionRole("s1") === "claimer" && roleNotified === 2, "role can flip back to claimer");
const roleSnap = getSessionRoles();
setSessionRole("s2", "viewer");
assert(getSessionRoles() !== roleSnap, "role snapshot is replaced immutably");
pruneSessionRoles(["s1"]);
assert(getSessionRole("s2") === null && getSessionRole("s1") === "claimer", "pruneSessionRoles GCs dead sessions");

// ── MsgResponse → user line (daemon contract verbatim) ──
const okOut = interpretSendResponse(200, JSON.stringify({ success: true, target_session_id: "u", attempts: 1, reason: null, hint: null }));
assert(okOut.ok === true && okOut.res.target_session_id === "u", "200 success:true → ok with MsgResponse");
const stalled = interpretSendResponse(200, JSON.stringify({ success: false, reason: "pty_stalled", hint: "busy" }));
assert(stalled.ok === false && stalled.message.includes("pty_stalled") && stalled.message.toLowerCase().includes("try again"), "pty_stalled → busy/try-again line");
const died = interpretSendResponse(200, JSON.stringify({ success: false, reason: "pty_died" }));
assert(died.ok === false && died.message.includes("pty_died"), "pty_died line carries the reason");
const gate = interpretSendResponse(200, JSON.stringify({ success: false, reason: "hitl_gate_open" }));
assert(gate.ok === false && gate.message.includes("hitl_gate_open") && gate.message.toLowerCase().includes("prompt"), "hitl_gate_open explains the held prompt");
const revoked = interpretSendResponse(200, JSON.stringify({ success: false, reason: "revoked", hint: "connect-user session was revoked before delivery" }));
assert(revoked.ok === false && revoked.message.includes("revoked"), "revoked line");
const join = interpretSendResponse(200, JSON.stringify({ success: false, reason: "worker_join", hint: "JoinError" }));
assert(join.ok === false && join.message.includes("worker_join"), "worker_join line");
const unknown = interpretSendResponse(200, JSON.stringify({ success: false, reason: "future_reason", hint: "do the thing" }));
assert(unknown.ok === false && unknown.message.includes("future_reason") && unknown.message.includes("do the thing"), "unknown reason surfaces reason + hint verbatim");
const bare = interpretSendResponse(200, JSON.stringify({ success: false }));
assert(bare.ok === false && bare.message.length > 0, "reasonless failure still yields a line");
const decline = interpretSendResponse(403, JSON.stringify({ error: "invalid or missing token" }));
assert(decline.ok === false && decline.message === REMOTE_INSTRUCT_DECLINE, "post-revive 403 → remote-instruct decline line");
const http500 = interpretSendResponse(500, JSON.stringify({ error: "boom" }));
assert(http500.ok === false && http500.message.includes("boom"), "non-2xx surfaces the daemon error body");
const httpOpaque = interpretSendResponse(502, "<html>bad gateway</html>");
assert(httpOpaque.ok === false && httpOpaque.message.includes("502"), "non-JSON error body falls back to the status");
const garbage = interpretSendResponse(200, "not json");
assert(garbage.ok === false && garbage.message.toLowerCase().includes("unexpected"), "unparseable 200 body is a loud failure, not a fake success");

process.exit(failures ? 1 : 0);
