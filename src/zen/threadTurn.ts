// The Thread turn: what the agent is doing with your message, live.
//
// K2 0.45.0+ sends ephemeral `collection: "activity"` frames on the same
// overlay socket as Thread messages (never stored, `seq: 0`, never replayed
// by `since_seq`). They feed this turn, never the message list. Catch-up is
// `GET /cli/thread/activity?addr=` → `{turn: body | null}` on every socket
// (re)open. App guests never get either.
//
// Port of desktop `SessionView/overlayThread.ts` (coerceThreadTurn and
// friends). Times are server ms; `skewMs` maps them onto this clock.

export type ThreadTurnState =
  | "working"
  | "monitoring"
  | "needs-you"
  | "unverifiable"
  | "stopped"
  | "idle";

export type ThreadTurnPhase =
  | "delivering"
  | "working"
  | "tool"
  | "thinking"
  | "waiting"
  | "stale"
  | "children";

export type ThreadTurnTally = {
  read: number;
  search: number;
  cmd: number;
  edit: number;
};

export type ThreadTurnEnd = {
  /** reply | done | interrupted | failed | session_gone | delivery_failed | superseded | stale */
  reason: string;
  detail: string | null;
  at: number;
};

export type ThreadTurn = {
  turnId: string;
  state: ThreadTurnState;
  phase: ThreadTurnPhase;
  /** Server ms: the daemon received the user's message. */
  startedAt: number;
  /** Server ms: the current phase began. */
  phaseSince: number;
  /** Redacted tool line in phase `tool` ("Running `npm test`"), else null. */
  line: string | null;
  subagents: number;
  subagentsDone: number;
  background: number;
  tally: ThreadTurnTally;
  waitingOn: "permission" | "question" | null;
  end: ThreadTurnEnd | null;
  rev: number;
  /** `serverNow − Date.now()` at receipt. Server time = `Date.now() + skewMs`. */
  skewMs: number;
};

const STATES: readonly ThreadTurnState[] = [
  "working",
  "monitoring",
  "needs-you",
  "unverifiable",
  "stopped",
  "idle",
];
const PHASES: readonly ThreadTurnPhase[] = [
  "delivering",
  "working",
  "tool",
  "thinking",
  "waiting",
  "stale",
  "children",
];

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function count(v: unknown): number {
  const n = finite(v);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

/** One activity body, or null when it isn't one. */
export function coerceThreadTurn(raw: unknown, receivedAt: number): ThreadTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const turnId = typeof a.turnId === "string" ? a.turnId : "";
  const startedAt = finite(a.startedAt);
  const serverNow = finite(a.serverNow);
  if (!turnId || startedAt === null || serverNow === null) return null;
  const state = STATES.find((s) => s === a.state);
  const phase = PHASES.find((p) => p === a.phase);
  if (!state || !phase) return null;
  const t =
    a.tally && typeof a.tally === "object" ? (a.tally as Record<string, unknown>) : {};
  let end: ThreadTurnEnd | null = null;
  if (a.end && typeof a.end === "object") {
    const e = a.end as Record<string, unknown>;
    end = {
      reason: typeof e.reason === "string" ? e.reason : "done",
      detail: typeof e.detail === "string" ? e.detail : null,
      at: finite(e.at) ?? serverNow,
    };
  }
  return {
    turnId,
    state,
    phase,
    startedAt,
    phaseSince: finite(a.phaseSince) ?? startedAt,
    line: typeof a.line === "string" && a.line.trim() ? a.line : null,
    subagents: count(a.subagents),
    subagentsDone: count(a.subagentsDone),
    background: count(a.background),
    tally: {
      read: count(t.read),
      search: count(t.search),
      cmd: count(t.cmd),
      edit: count(t.edit),
    },
    waitingOn:
      a.waitingOn === "permission" || a.waitingOn === "question" ? a.waitingOn : null,
    end,
    rev: finite(a.rev) ?? 0,
    skewMs: serverNow - receivedAt,
  };
}

/** Another turn replaces the current one; the same turn only moves forward by `rev`. */
function nextTurn(current: ThreadTurn | null, incoming: ThreadTurn): ThreadTurn {
  if (current && current.turnId === incoming.turnId && incoming.rev < current.rev) {
    return current;
  }
  return incoming;
}

/** True for an overlay socket frame that belongs to the turn, not the list. */
export function isActivityFrame(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as { collection?: unknown }).collection === "activity"
  );
}

/** True for a frame the Thread list takes: `thread`, or an untagged item
 *  (poll path). `chatter`, host-wide `chatterlog`, `address`, `moved` and
 *  `activity` frames never become messages. */
export function isThreadFrame(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const c = (raw as { collection?: unknown }).collection;
  return c === undefined || c === null || c === "thread";
}

/** Catch-up answers can land out of order. Each `begin()` returns a check
 *  that passes only while it is the newest catch-up issued and no activity
 *  frame has arrived since (the frame is newer than the answer). */
export function createCatchUpGate(): { begin: () => () => boolean; frame: () => void } {
  let issued = 0;
  let frames = 0;
  return {
    begin() {
      const gen = ++issued;
      const mark = frames;
      return () => gen === issued && mark === frames;
    },
    frame() {
      frames += 1;
    },
  };
}

/** Apply one overlay socket frame. Non-activity frames return `turn` itself. */
export function applyActivityFrame(
  turn: ThreadTurn | null,
  raw: unknown,
  receivedAt: number
): ThreadTurn | null {
  if (!isActivityFrame(raw)) return turn;
  const incoming = coerceThreadTurn(
    (raw as { activity?: unknown }).activity,
    receivedAt
  );
  return incoming ? nextTurn(turn, incoming) : turn;
}

/** Apply the `GET /cli/thread/activity` body. `{turn: null}` clears it;
 *  a body without `turn` changes nothing. */
export function applyActivityCatchUp(
  turn: ThreadTurn | null,
  body: unknown,
  receivedAt: number
): ThreadTurn | null {
  if (!body || typeof body !== "object" || !("turn" in body)) return turn;
  const raw = (body as { turn: unknown }).turn;
  if (raw === null) return null;
  const incoming = coerceThreadTurn(raw, receivedAt);
  return incoming ? nextTurn(turn, incoming) : turn;
}
