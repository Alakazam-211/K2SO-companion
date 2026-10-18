// iMessage runs (tails on the last bubble of a run) and the one
// "Delivered" / "Read" receipt.
import { describe, expect, it } from "vitest";
import { READ_SLACK_MS, RUN_GAP_S, chatRuns, readByTurn, receiptFor, receiptRow } from "./chatReceipt";

const me = (at: number | null) => ({ mine: true, from: "baden", at });
const appa = (at: number | null) => ({ mine: false, from: "appa", at });

describe("chatRuns", () => {
  it("groups consecutive messages from the same sender; the last of each run gets the tail", () => {
    const runs = chatRuns([appa(100), appa(110), me(120), me(130), me(140), appa(150)]);
    expect(runs).toEqual([
      { first: true, last: false },
      { first: false, last: true },
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
      { first: true, last: true },
    ]);
  });

  it("a different member (project chat) or a long gap starts a new run", () => {
    const bo = { mine: false, from: "bo", at: 105 };
    expect(chatRuns([appa(100), bo]).map((r) => r.last)).toEqual([true, true]);
    expect(chatRuns([me(100), me(100 + RUN_GAP_S + 1)]).map((r) => r.first)).toEqual([true, true]);
    expect(chatRuns([me(100), me(100 + RUN_GAP_S)]).map((r) => r.first)).toEqual([true, false]);
  });

  it("mixes seconds and ms; an unknown time stays in the run", () => {
    expect(chatRuns([me(1_700_000_000), me(1_700_000_030_000)])[1].first).toBe(false);
    expect(chatRuns([me(null), me(1_700_000_000)])[1].first).toBe(false);
    expect(chatRuns([])).toEqual([]);
  });
});

describe("the receipt", () => {
  const row = (mine: boolean, confirmed: boolean, at: number | null = 1000) => ({ mine, confirmed, at });

  it("sits on the newest confirmed outgoing message; a pending newer one does not take it", () => {
    expect(receiptRow([row(true, true), row(false, true), row(true, true, 1100)])).toBe(2);
    expect(receiptRow([row(true, true), row(true, false, 1100)])).toBe(0);
    expect(receiptRow([row(false, true)])).toBe(-1);
    expect(receiptRow([])).toBe(-1);
  });

  it("Delivered, or Read once the agent replied after it", () => {
    const rows = [row(true, true), row(true, false, 1100)];
    expect(receiptFor(rows, 0, { readSignals: true })).toBe("delivered");
    const replied = [row(true, true), row(false, true, 1010)];
    expect(receiptFor(replied, 0, { readSignals: true })).toBe("read");
    // A project chat (no one reader): always Delivered.
    expect(receiptFor(replied, 0, { readSignals: false })).toBe("delivered");
    expect(receiptFor(rows, -1, { readSignals: true })).toBeNull();
    expect(receiptFor(rows, 1, { readSignals: true })).toBeNull();
  });

  it("Read when the agent's turn started at or after the message and got past delivery", () => {
    const at = 1_700_000_000;
    const turn = (startedAt: number, phase = "working", end: { reason: string } | null = null) =>
      ({ startedAt, phase, end }) as Parameters<typeof readByTurn>[1];
    expect(readByTurn(at, turn(at * 1000 + 300))).toBe(true);
    // Clock rounding between the copies: a hair before still counts.
    expect(readByTurn(at, turn(at * 1000 - READ_SLACK_MS + 1))).toBe(true);
    // An older turn (the one the send superseded) does not.
    expect(readByTurn(at, turn(at * 1000 - 20_000))).toBe(false);
    // Still delivering, or delivery failed: not read.
    expect(readByTurn(at, turn(at * 1000 + 300, "delivering"))).toBe(false);
    expect(readByTurn(at, turn(at * 1000 + 300, "working", { reason: "delivery_failed" }))).toBe(false);
    // A turn that already ended with a reply or done did read it.
    expect(readByTurn(at, turn(at * 1000 + 300, "delivering", { reason: "reply" }))).toBe(true);
    // No activity feature: stays Delivered.
    expect(readByTurn(at, null)).toBe(false);
    expect(readByTurn(null, turn(at * 1000))).toBe(false);
    const rows = [{ mine: true, confirmed: true, at }];
    expect(receiptFor(rows, 0, { readSignals: true, turn: turn(at * 1000 + 300) })).toBe("read");
    expect(receiptFor(rows, 0, { readSignals: false, turn: turn(at * 1000 + 300) })).toBe("delivered");
  });
});
