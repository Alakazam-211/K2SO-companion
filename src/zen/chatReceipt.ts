// iMessage-style message runs and the "Delivered" / "Read" receipt.
//
// Runs: consecutive messages from the same sender (this phone's own, or
// the same agent / member) no more than `RUN_GAP_S` apart are one run. Only
// the last bubble of a run has a tail; the rest sit tighter, without their
// own meta line (theirs: name • time on the first of the run only; mine:
// the status line on the last of the run, or wherever it still says
// something — Sending…, Not sent, the receipt).
//
// Receipt: one label for the whole chat, under the NEWEST outgoing message
// the server has confirmed (where useDeliverBrighten fires). A newer send
// takes it once it is confirmed; until then the older one keeps it (if its
// status line is shown). "Read" when the agent picked that message up: a
// reply after it, or the Thread turn (activity frames, K2 0.45.0+) started
// at or after it and is past `delivering`. Agent Threads only: a project
// chat has many readers and no per-reader signal, so it stays "Delivered".
//
// The label is drawn in the message's fixed-height status line (CSS
// generated content, chatBubbles.css), so it moving from one message to
// the next — or Delivered becoming Read — is a crossfade with no layout
// change at all (iMessage's ~3 px list nudge comes from its label adding
// a line; ours never moves the list, so there is nothing to glide).

import type { ThreadTurn } from "./threadTurn";

/** Two messages this far apart (seconds) start a new run. */
export const RUN_GAP_S = 120;
/** A turn that started this long (ms) before a message's server time still
 *  counts as picking it up (clock rounding between the copies). */
export const READ_SLACK_MS = 2000;

export type RunInput = { mine: boolean; from: string; at: number | null };
export type RunPos = { first: boolean; last: boolean };

/** Seconds, from Unix seconds or ms; null when unknown. */
function secondsOf(at: number | null | undefined): number | null {
  if (at == null || !Number.isFinite(at)) return null;
  return at > 1e12 ? at / 1000 : at;
}

function sameRun(a: RunInput, b: RunInput, gapS: number): boolean {
  if (a.mine !== b.mine) return false;
  if (!a.mine && a.from !== b.from) return false;
  const sa = secondsOf(a.at);
  const sb = secondsOf(b.at);
  if (sa == null || sb == null) return true;
  return Math.abs(sb - sa) <= gapS;
}

/** Where each message sits in its run. */
export function chatRuns(rows: readonly RunInput[], gapS = RUN_GAP_S): RunPos[] {
  return rows.map((r, i) => ({
    first: i === 0 || !sameRun(rows[i - 1], r, gapS),
    last: i === rows.length - 1 || !sameRun(r, rows[i + 1], gapS),
  }));
}

export type Receipt = "delivered" | "read";
export type ReceiptInput = {
  mine: boolean;
  /** The server has it (not sending, queued, failed — nor still flying in). */
  confirmed: boolean;
  /** Server time of the message (Unix s or ms). */
  at: number | null;
};

/** The row that carries the receipt: the newest confirmed outgoing one. */
export function receiptRow(rows: readonly ReceiptInput[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].mine && rows[i].confirmed) return i;
  }
  return -1;
}

/** The agent's turn picked up a message sent at `at` (server time): the
 *  turn started at or after it (within the slack) and got past delivery. */
export function readByTurn(
  at: number | null,
  turn: Pick<ThreadTurn, "startedAt" | "phase" | "end"> | null | undefined,
  slackMs = READ_SLACK_MS
): boolean {
  const s = secondsOf(at);
  if (!turn || s == null || !Number.isFinite(turn.startedAt)) return false;
  if (turn.end?.reason === "delivery_failed") return false;
  if (turn.phase === "delivering" && !turn.end) return false;
  return turn.startedAt >= s * 1000 - slackMs;
}

/** The receipt under row `index` (see `receiptRow`), or null for none.
 *  `readSignals`: an agent Thread (a reply or its turn can say "Read"). */
export function receiptFor(
  rows: readonly ReceiptInput[],
  index: number,
  opts: { readSignals: boolean; turn?: Pick<ThreadTurn, "startedAt" | "phase" | "end"> | null }
): Receipt | null {
  const r = rows[index];
  if (!r || !r.mine || !r.confirmed) return null;
  if (!opts.readSignals) return "delivered";
  for (let i = index + 1; i < rows.length; i++) if (!rows[i].mine) return "read";
  return readByTurn(r.at, opts.turn) ? "read" : "delivered";
}
