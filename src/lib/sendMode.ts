// T3 — Safe send / Direct type: the per-terminal send-mode model, the
// session-role (viewer/claimer) registry, and the pure mapping from the
// daemon's `/cli/terminal/send-message` response to a user-facing line.
//
// Pure + Node-testable (no React, no Tauri imports) — exercised directly
// by scripts/test-send-mode.mjs (the feedbackPure/gridConvert idiom).
//
// Mode model (Orca's proven shape): the WHOLE state is one immutable Set
// of terminalIds currently in DIRECT. Absence ⇒ Safe — so every terminal
// one-shot-defaults to Safe with zero init step, pruning dead handles can
// never flip a live terminal's mode, and the state is session-local by
// construction (module lifetime; intentionally NOT persisted across app
// launches — V1).

export type SendMode = "safe" | "direct";

// ─── Pure core ───

/** A terminal's current mode: in the Direct set ⇒ direct, else Safe. */
export function modeFor(
  direct: ReadonlySet<string>,
  terminalId: string
): SendMode {
  return direct.has(terminalId) ? "direct" : "safe";
}

/** Return a set with `terminalId`'s mode applied. No-ops return the SAME
 *  set reference (so subscribers can skip re-renders on redundant taps). */
export function withMode(
  direct: ReadonlySet<string>,
  terminalId: string,
  mode: SendMode
): ReadonlySet<string> {
  const has = direct.has(terminalId);
  if ((mode === "direct") === has) return direct;
  const next = new Set(direct);
  if (mode === "direct") next.add(terminalId);
  else next.delete(terminalId);
  return next;
}

/** Garbage-collect handles whose terminals no longer exist (Orca's
 *  prune step). Identity-preserving when nothing is dead. */
export function pruneHandles(
  direct: ReadonlySet<string>,
  liveIds: Iterable<string>
): ReadonlySet<string> {
  const live = liveIds instanceof Set ? (liveIds as Set<string>) : new Set(liveIds);
  let dirty = false;
  for (const id of direct) {
    if (!live.has(id)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return direct;
  const next = new Set<string>();
  for (const id of direct) if (live.has(id)) next.add(id);
  return next;
}

// ─── Session-local store (module singleton; NOT persisted) ───

let directHandles: ReadonlySet<string> = new Set();
const modeListeners = new Set<() => void>();

function emitModes(): void {
  for (const fn of modeListeners) fn();
}

/** Immutable snapshot for `useSyncExternalStore`. */
export function getDirectHandles(): ReadonlySet<string> {
  return directHandles;
}

export function subscribeSendModes(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

export function getSendMode(terminalId: string): SendMode {
  return modeFor(directHandles, terminalId);
}

export function setSendMode(terminalId: string, mode: SendMode): void {
  const next = withMode(directHandles, terminalId, mode);
  if (next === directHandles) return;
  directHandles = next;
  emitModes();
}

export function pruneSendModes(liveIds: Iterable<string>): void {
  const next = pruneHandles(directHandles, liveIds);
  if (next === directHandles) return;
  directHandles = next;
  emitModes();
}

// ─── Session-role registry (viewer / claimer) ───
//
// The grid-WS `mode` JSON frame is this connection's daemon-judged role
// (gridSocket.ts ModePayload). The frame lands inside TerminalView's
// socket callback (T2's surface), so THIS registry is the neutral seam:
// whoever sees the frame calls `setSessionRole`. Watch is a size
// policy — ChatSession does not hide Safe send for viewers. Unknown
// (never reported) = null. The daemon's send-message gate is the
// enforcement source of truth.

export type SessionRole = "viewer" | "claimer";

let sessionRoles: ReadonlyMap<string, SessionRole> = new Map();
const roleListeners = new Set<() => void>();

function emitRoles(): void {
  for (const fn of roleListeners) fn();
}

/** Immutable snapshot for `useSyncExternalStore`. */
export function getSessionRoles(): ReadonlyMap<string, SessionRole> {
  return sessionRoles;
}

export function subscribeSessionRoles(listener: () => void): () => void {
  roleListeners.add(listener);
  return () => roleListeners.delete(listener);
}

export function getSessionRole(terminalId: string): SessionRole | null {
  return sessionRoles.get(terminalId) ?? null;
}

export function setSessionRole(terminalId: string, role: SessionRole): void {
  if (sessionRoles.get(terminalId) === role) return;
  const next = new Map(sessionRoles);
  next.set(terminalId, role);
  sessionRoles = next;
  emitRoles();
}

export function pruneSessionRoles(liveIds: Iterable<string>): void {
  const live = liveIds instanceof Set ? (liveIds as Set<string>) : new Set(liveIds);
  let dirty = false;
  for (const id of sessionRoles.keys()) {
    if (!live.has(id)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return;
  const next = new Map<string, SessionRole>();
  for (const [id, role] of sessionRoles) if (live.has(id)) next.set(id, role);
  sessionRoles = next;
  emitRoles();
}

/** Test-only: reset both stores to their fresh-launch state. */
export function __resetSendModeForTests(): void {
  directHandles = new Set();
  sessionRoles = new Map();
}

// ─── MsgResponse → user line ───
//
// Daemon contract (dispatcher.rs `/cli/terminal/send-message`, verified):
//   • 200 + `MsgResponse` JSON for every HANDLED request — including
//     failures: `{success:false, reason, hint}` with reasons pty_died /
//     pty_stalled / hitl_gate_open / revoked / worker_join.
//   • 403 `{"error":"invalid or missing token"}` when the capability gate
//     declines. The companion's stale-token case is already consumed by
//     the revive-and-replay-once layer in sendMessage.ts, so a 403 that
//     REACHES this mapping is the remote-instruct opt-in decline (owner
//     is always allowed; a connect-user needs the workspace's opt-in).

export interface MsgResponse {
  success: boolean;
  target_session_id?: string | null;
  attempts?: number;
  reason?: string | null;
  hint?: string | null;
}

export type SendOutcome =
  | { ok: true; res: MsgResponse }
  | { ok: false; message: string };

export const REMOTE_INSTRUCT_DECLINE =
  "This workspace hasn't enabled remote instruction for your role.";

/** Known injector failure reasons → actionable one-liners. */
const REASON_LINES: Record<string, string> = {
  pty_died: "Agent session is gone (pty_died) — reload the session and try again.",
  pty_stalled: "Agent session is busy (pty_stalled) — try again in a moment.",
  hitl_gate_open:
    "The agent is holding a permission prompt (hitl_gate_open) — answer it in the terminal first.",
  revoked: "Your access to this host was revoked before delivery (revoked).",
  worker_join: "The daemon couldn't schedule the delivery (worker_join) — try again.",
};

/** Map the raw HTTP status + body of a send-message call to the outcome
 *  the composer shows. Pure — the transport (sendMessage.ts) feeds it. */
export function interpretSendResponse(
  status: number,
  bodyText: string
): SendOutcome {
  if (status === 403) return { ok: false, message: REMOTE_INSTRUCT_DECLINE };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* non-JSON body — handled per-branch below */
  }

  if (status < 200 || status >= 300) {
    const err = (parsed as { error?: string } | null)?.error;
    return {
      ok: false,
      message: err ? `Send failed: ${err}` : `Send failed (HTTP ${status}).`,
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, message: "Send failed: unexpected daemon response." };
  }
  const res = parsed as MsgResponse;
  if (res.success) return { ok: true, res };

  const reason = res.reason ?? "";
  const known = REASON_LINES[reason];
  if (known) return { ok: false, message: known };
  if (reason) {
    return {
      ok: false,
      message: `Send failed (${reason})${res.hint ? ` — ${res.hint}` : "."}`,
    };
  }
  return { ok: false, message: res.hint ? `Send failed — ${res.hint}` : "Send failed." };
}
