// K2 0.46.13 tombstones: a deleted Thread message is served as
// `deleted: true` with no body (live frame and every read). The phone keeps
// it (so it replaces the message on screen and in the cache), with nothing
// of the old message riding it.
import { describe, expect, it } from "vitest";
import { DELETED_TEXT, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { mergeDelta, mergeServerPage, sameMessage } from "./threadCacheMerge";
import { chatRuns, receiptRow } from "./chatReceipt";
import { rowLastFromMessage, threadRowLast } from "./lastAtFetch";

const T0 = 1_700_000_000;
const tomb = (id: string, seq: number, from = "baden", extra: Record<string, unknown> = {}) => ({
  id,
  seq,
  doc: { id, seq, from, created_at: T0, deleted: true, deletedAt: T0 + 5, deletedBy: from, ...extra },
});
const live = (id: string, seq: number, text: string, from = "baden"): ThreadMessage => ({
  id,
  seq,
  text,
  from,
  at: T0,
  mine: from === "baden",
  kind: "text",
  choice: null,
});

describe("normaliseThreadItem on a tombstone", () => {
  it("keeps it as a deleted message (not dropped as empty)", () => {
    const m = normaliseThreadItem(tomb("m1", 3), "baden");
    expect(m).toEqual({
      id: "m1",
      seq: 3,
      text: "",
      from: "baden",
      at: T0,
      mine: true,
      kind: "text",
      choice: null,
      deleted: true,
    });
  });

  it("drops anything a stale copy might still carry (body, files, card, offer)", () => {
    const m = normaliseThreadItem(
      tomb("m2", 4, "appa", {
        body: "old words",
        kind: "choice",
        choice: { prompt: "Pick", options: ["a", "b"] },
        attachments: [{ id: "f1", name: "a.txt", path: "/a.txt", size: 1 }],
        stash: { text: "x" },
      }),
      "baden"
    )!;
    expect(m.deleted).toBe(true);
    expect(m.text).toBe("");
    expect(m.choice).toBeNull();
    expect(m.files).toBeUndefined();
    expect(m.stashOffer).toBeUndefined();
    expect(m.mine).toBe(false);
  });

  it("deleted: false is an ordinary message", () => {
    const m = normaliseThreadItem({ id: "m3", seq: 5, doc: { id: "m3", from: "baden", body: "hi", deleted: false } }, "baden")!;
    expect(m.deleted).toBeUndefined();
    expect(m.text).toBe("hi");
  });
});

describe("merges", () => {
  it("a tombstone differs from the live copy, so it replaces it", () => {
    const d = normaliseThreadItem(tomb("m1", 2), "baden")!;
    expect(sameMessage(live("m1", 2, ""), d)).toBe(false);
  });

  it("a delta's tombstone replaces the held message", () => {
    const held = [live("m1", 1, "first"), live("m2", 2, "second")];
    const out = mergeDelta(held, [normaliseThreadItem(tomb("m2", 2), "baden")!]);
    expect(out.map((m) => [m.id, m.text, !!m.deleted])).toEqual([
      ["m1", "first", false],
      ["m2", "", true],
    ]);
  });

  it("a page's tombstone replaces the held message", () => {
    const held = [live("m1", 1, "first"), live("m2", 2, "second")];
    const page = [live("m1", 1, "first"), normaliseThreadItem(tomb("m2", 2), "baden")!];
    const out = mergeServerPage(held, page, { hasMore: false });
    expect(out.find((m) => m.id === "m2")?.deleted).toBe(true);
  });
});

describe("runs and the receipt", () => {
  it("a deleted line is never part of a run", () => {
    const runs = chatRuns([
      { mine: true, from: "baden", at: T0 },
      { mine: true, from: "baden", at: T0 + 1, deleted: true },
      { mine: true, from: "baden", at: T0 + 2 },
    ]);
    expect(runs).toEqual([
      { first: true, last: true },
      { first: true, last: true },
      { first: true, last: true },
    ]);
  });

  it("the receipt skips a deleted send (callers mark it unconfirmed)", () => {
    expect(
      receiptRow([
        { mine: true, confirmed: true, at: T0 },
        { mine: true, confirmed: false, at: T0 + 1 },
      ])
    ).toBe(0);
  });
});

describe("list preview", () => {
  it("says Message deleted", () => {
    const m = normaliseThreadItem(tomb("m1", 2, "appa"), "baden")!;
    expect(rowLastFromMessage(m, "appa", "baden").text).toBe(DELETED_TEXT);
    expect(threadRowLast([tomb("m1", 2, "appa") as never], "appa", "baden")?.text).toBe(DELETED_TEXT);
  });
});
