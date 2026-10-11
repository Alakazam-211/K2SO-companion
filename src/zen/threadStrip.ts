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

/** Counts only, never names. "2 subagents running, 1 done", "1 background task". */
export function childBits(turn: ThreadTurn): string[] {
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

// ── The drawer's one line ───────────────────────────────────────────────
// Collapsed, the drawer above the composer is one line: pulse · step ·
// emoji counters · clock. The emoji are decoration for sighted readers;
// the drawer's aria-label stays the full sentence above, and each counter
// carries a visually hidden word equivalent.

export type StripCounterKey = "subagents" | "background" | "read" | "search" | "cmd" | "edit";

/** Display order, left to right. */
export const STRIP_EMOJI: Record<StripCounterKey, string> = {
  subagents: "🤖",
  background: "⚙️",
  read: "📄",
  search: "🔍",
  cmd: "⌨️",
  edit: "✏️",
};
const COUNTER_ORDER: StripCounterKey[] = ["subagents", "background", "read", "search", "cmd", "edit"];

/** Dropped first to last when the line is too narrow (after the ✓done
 *  suffix). Subagents running and background tasks always show. */
export const COUNTER_DROP_ORDER: StripCounterKey[] = ["search", "read", "edit", "cmd"];

export type StripCounter = {
  key: StripCounterKey;
  count: number;
  /** Subagents only: finished ones, shown as "✓1" when it fits. */
  done: number;
};

/** Non-zero counters, in display order. */
export function stripCounters(
  turn: Pick<ThreadTurn, "subagents" | "subagentsDone" | "background" | "tally">
): StripCounter[] {
  const counts: Record<StripCounterKey, number> = {
    subagents: turn.subagents,
    background: turn.background,
    read: turn.tally.read,
    search: turn.tally.search,
    cmd: turn.tally.cmd,
    edit: turn.tally.edit,
  };
  const out: StripCounter[] = [];
  for (const key of COUNTER_ORDER) {
    const count = Math.max(0, counts[key] || 0);
    const done = key === "subagents" ? Math.max(0, turn.subagentsDone || 0) : 0;
    if (count > 0 || done > 0) out.push({ key, count, done });
  }
  return out;
}

/** "🤖2✓1", "📄3". */
export function counterText(c: StripCounter): string {
  const count = c.count > 0 ? String(c.count) : "";
  return `${STRIP_EMOJI[c.key]}${count}${c.done > 0 ? `✓${c.done}` : ""}`;
}

/** The counter in words, for screen readers. */
export function counterSpoken(c: StripCounter): string {
  switch (c.key) {
    case "subagents":
      if (c.count > 0) {
        const done = c.done > 0 ? `, ${c.done} done` : "";
        return `${plural(c.count, "subagent", "subagents")} running${done}`;
      }
      return `${plural(c.done, "subagent", "subagents")} done`;
    case "background":
      return plural(c.count, "background task", "background tasks");
    case "read":
      return `read ${plural(c.count, "file", "files")}`;
    case "search":
      return `searched ${plural(c.count, "time", "times")}`;
    case "cmd":
      return `ran ${plural(c.count, "command", "commands")}`;
    case "edit":
      return `edited ${plural(c.count, "file", "files")}`;
  }
}

/** Gap (px) between counters. */
export const COUNTER_GAP_PX = 6;

/** A conservative width estimate (px) of drawer text at `fontPx`: emoji are
 *  wide, digits tabular. No canvas, so it runs anywhere (and in tests). */
export function estimateStripTextPx(text: string, fontPx = 12): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfe0f || cp === 0x200d) continue;
    if (ch === "✓") w += 0.8 * fontPx;
    else if (/\p{Extended_Pictographic}/u.test(ch)) w += 1.3 * fontPx;
    else if (/[0-9:]/.test(ch)) w += 0.62 * fontPx;
    else w += 0.6 * fontPx;
  }
  return Math.ceil(w);
}

function countersWidth(list: StripCounter[], measure: (text: string) => number): number {
  if (!list.length) return 0;
  return (
    list.reduce((sum, c) => sum + measure(counterText(c)), 0) +
    COUNTER_GAP_PX * (list.length - 1)
  );
}

/**
 * The counters that fit `budgetPx` (the room left after the step's minimum
 * width, the pulse and the clock). Drops, in order: the subagents' ✓done,
 * then search, read, edit, commands. Subagents running and background
 * tasks always stay, even over budget.
 */
export function fitStripCounters(
  counters: StripCounter[],
  budgetPx: number,
  measure: (text: string) => number = (t) => estimateStripTextPx(t)
): StripCounter[] {
  let list = counters.slice();
  const fits = () => countersWidth(list, measure) <= budgetPx;
  if (!Number.isFinite(budgetPx) || fits()) return list;
  list = list
    .map((c) => (c.key === "subagents" && c.done > 0 ? { ...c, done: 0 } : c))
    .filter((c) => c.count > 0);
  if (fits()) return list;
  for (const key of COUNTER_DROP_ORDER) {
    list = list.filter((c) => c.key !== key);
    if (fits()) return list;
  }
  return list;
}

/** The clock at the far right: "0:08", "1:12", "1:02:03". */
export function stripClockShort(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export type ThreadDrawerLine = {
  tone: ThreadStripTone;
  /** Full sentence, from `threadStripView`. */
  ariaLabel: string;
  /** The middle of the collapsed line: the step, or the state word. */
  step: ThreadStripStep;
  counters: StripCounter[];
  /** Far right, "1:12". */
  clock: string;
  /** Expanded, in words. */
  detail: {
    /** "Working · 1m 12s since your message". */
    head: string;
    /** The full step with its time in step, or null. */
    step: ThreadStripStep | null;
    /** "Read 3 files · searched 1 time · ran 2 commands · edited 1 file". */
    tally: string;
    /** "2 subagents running, 1 done · 1 background task". */
    children: string;
  };
};

/** The drawer for `turn` at `now`, or null: nothing to show. */
export function threadDrawerLine(turn: ThreadTurn, now: number): ThreadDrawerLine | null {
  const view = threadStripView(turn, now);
  if (!view) return null;
  const tally = tallyBits(turn.tally).join(" · ");
  const children = childBits(turn).join(" · ");
  if (turn.end) {
    const clock = stripClockShort(turn.end.at - turn.startedAt);
    return {
      tone: view.tone,
      ariaLabel: view.ariaLabel,
      step: { kind: "plain", text: "Stopped", elapsed: null },
      counters: [],
      clock,
      detail: {
        head: `Stopped after ${stripClock(turn.end.at - turn.startedAt)}`,
        step: null,
        tally,
        children,
      },
    };
  }
  const serverNow = now + turn.skewMs;
  const sinceMessage = `${stripClock(serverNow - turn.startedAt)} since your message`;
  const replied =
    turn.phase === "children" && (turn.state === "working" || turn.state === "monitoring");
  let word: string;
  let step: ThreadStripStep;
  if (replied) {
    word = "Replied";
    step = { kind: "plain", text: "Replied", elapsed: null };
  } else if (view.tone === "unverifiable") {
    word = view.label;
    step = { kind: "plain", text: view.label, elapsed: null };
  } else {
    word =
      turn.state === "needs-you"
        ? "Needs you"
        : turn.state === "monitoring"
          ? "Monitoring"
          : "Working";
    step = view.step ?? { kind: "plain", text: view.label || word, elapsed: null };
  }
  return {
    tone: view.tone,
    ariaLabel: view.ariaLabel,
    step,
    counters: stripCounters(turn),
    clock: stripClockShort(serverNow - turn.startedAt),
    detail: {
      head: `${word} · ${sinceMessage}`,
      step: replied || view.tone === "unverifiable" ? null : view.step,
      tally,
      children,
    },
  };
}
