// The words of the Thread working strip. Pure: a turn and a clock in, three
// lines out. The phone only labels what the daemon decided.
//
//   header  a pulse, a state word only where it adds something, the time
//           since your message
//   step    what the agent is doing: the tool line, "Thinking… 8s",
//           "Delivering…", "Stuck on a permission prompt"
//   tally   "Read 3 files · ran 2 commands", subagents, background tasks
//
// "Working" is said at most once. A wait is stated as a fact, never as a
// call to action (K2 never sends anyone to a terminal). An ended turn shows
// nothing, except "Stopped" for a moment after an interrupt.
//
// Port of desktop `SessionView/threadStrip.ts`. No Stop button on the phone
// yet, so `stoppable` is not carried.

import type { ThreadTurn, ThreadTurnTally } from "./threadTurn";

export const STOPPED_LINGER_MS = 3_000;
/** The daemon's `staleAfterSecs` (1800). */
const STALE_AFTER_MS = 30 * 60 * 1000;

export type ThreadStripTone =
  | "working"
  | "monitoring"
  | "needs-you"
  | "unverifiable"
  | "stopped";

export type ThreadStripStep = {
  /** `line`: a tool line with backtick code spans; `thinking` shimmers. */
  kind: "line" | "thinking" | "plain" | "needs";
  text: string;
  /** Time in this step ("12s"), or null when the text carries it. */
  elapsed: string | null;
};

export type ThreadStripView = {
  tone: ThreadStripTone;
  /** State word where it adds something; empty while the step says it. */
  label: string;
  since: string;
  ariaLabel: string;
  step: ThreadStripStep | null;
  /** Muted bits, joined with " · ". */
  tally: string[];
};

/** "8s", "1m 05s", "1h 02m". */
export function stripClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Read 3 files", "searched 1 time", "ran 2 commands", "edited 1 file". */
export function tallyBits(t: ThreadTurnTally): string[] {
  const out: string[] = [];
  if (t.read) out.push(`read ${plural(t.read, "file", "files")}`);
  if (t.search) out.push(`searched ${plural(t.search, "time", "times")}`);
  if (t.cmd) out.push(`ran ${plural(t.cmd, "command", "commands")}`);
  if (t.edit) out.push(`edited ${plural(t.edit, "file", "files")}`);
  if (out.length) out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1);
  return out;
}

/** Counts only, never names. */
function childBits(turn: ThreadTurn): string[] {
  const out: string[] = [];
  if (turn.subagents > 0) {
    const done = turn.subagentsDone > 0 ? `, ${turn.subagentsDone} done` : "";
    out.push(`${plural(turn.subagents, "subagent", "subagents")} running${done}`);
  } else if (turn.subagentsDone > 0) {
    out.push(`${plural(turn.subagentsDone, "subagent", "subagents")} done`);
  }
  if (turn.background > 0) {
    out.push(plural(turn.background, "background task", "background tasks"));
  }
  return out;
}

function stepOf(turn: ThreadTurn, serverNow: number): ThreadStripStep | null {
  const inPhase = stripClock(serverNow - turn.phaseSince);
  switch (turn.phase) {
    case "tool":
      return turn.line ? { kind: "line", text: turn.line, elapsed: inPhase } : null;
    case "thinking":
      return { kind: "thinking", text: `Thinking… ${inPhase}`, elapsed: null };
    case "waiting":
      return {
        kind: "needs",
        text:
          turn.waitingOn === "question"
            ? "Stuck on a question"
            : "Stuck on a permission prompt",
        elapsed: inPhase,
      };
    case "delivering":
      return { kind: "plain", text: "Delivering…", elapsed: null };
    default:
      return null;
  }
}

function spokenStep(step: ThreadStripStep | null): string {
  return step ? `: ${step.text.replace(/`/g, "")}` : "";
}

/** The strip for `turn` at `now` (this clock), or null: nothing to show. */
export function threadStripView(turn: ThreadTurn, now: number): ThreadStripView | null {
  const serverNow = now + turn.skewMs;
  if (turn.end) {
    if (
      turn.end.reason !== "interrupted" ||
      serverNow - turn.end.at >= STOPPED_LINGER_MS
    ) {
      return null;
    }
    const since = `stopped after ${stripClock(turn.end.at - turn.startedAt)}`;
    return {
      tone: "stopped",
      label: "Stopped",
      since,
      ariaLabel: `Stopped, ${since}`,
      step: null,
      tally: [],
    };
  }
  const clock = stripClock(serverNow - turn.startedAt);
  const sinceMessage = `${clock} since your message`;
  const step = stepOf(turn, serverNow);
  if (
    turn.phase === "children" &&
    (turn.state === "working" || turn.state === "monitoring")
  ) {
    const children = childBits(turn);
    const label = children.length ? children.join(" · ") : "Background work";
    return {
      tone: turn.state,
      label,
      since: clock,
      ariaLabel: `Agent replied; ${label.charAt(0).toLowerCase()}${label.slice(1)}, ${sinceMessage}`,
      step: null,
      tally: tallyBits(turn.tally),
    };
  }
  const tally = [...tallyBits(turn.tally), ...childBits(turn)];
  switch (turn.state) {
    case "working":
    case "monitoring": {
      const word = turn.state === "working" ? "Working" : "Monitoring";
      return {
        tone: turn.state,
        label: turn.state === "monitoring" || !step ? word : "",
        since: clock,
        ariaLabel: `Agent ${word.toLowerCase()}, ${sinceMessage}${spokenStep(step)}`,
        step,
        tally,
      };
    }
    case "needs-you":
      return {
        tone: "needs-you",
        label: "Needs you",
        since: clock,
        ariaLabel: `Agent needs you, ${sinceMessage}${spokenStep(step)}`,
        step,
        tally,
      };
    case "unverifiable": {
      // Phase `stale` starts at the row's staleSince = last evidence + 30m.
      const from = turn.phaseSince - STALE_AFTER_MS;
      const minutes = Math.max(0, Math.floor((serverNow - from) / 60_000));
      return {
        tone: "unverifiable",
        label: `No update in ${minutes}m`,
        since: "the session is still open",
        ariaLabel: `No update in ${minutes}m, the session is still open`,
        step: null,
        tally,
      };
    }
    default:
      return null;
  }
}
