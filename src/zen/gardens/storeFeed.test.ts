import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VerbError } from "./frameHost";
import {
  createStoreFeed,
  gardenDataSpace,
  STORE_POLL_MS,
  STORE_READ_GAP_MS,
  STORE_RETRY_MS,
  type StoreAnswer,
} from "./storeFeed";

const ok = (value: unknown): StoreAnswer => ({ ok: true, value });
const no = (code: string, extra: { reapedRev?: number; retryAfterSecs?: number } = {}): StoreAnswer => ({
  ok: false,
  error: { code, message: code },
  ...extra,
});
const change = (key: string, rev: number, value: unknown = { t: key }) => ({
  key,
  rev,
  value,
  by: "you via board",
  at: 0,
  deleted: value === null,
});
const page = (head: number, items: unknown[] = [], next: unknown = null) => ok({ head, items, next, partial: false });
const row = (c: ReturnType<typeof change>) => ({ key: c.key, rev: c.rev, value: c.value, by: c.by });

const SPACE = "data:board";
const A1 = change("a/1", 3);

function setup({ visible = true, live = true, arg = "a/" as unknown, first = page(3, [A1]) } = {}) {
  const call = vi.fn(async (_verb: string, _args: unknown[]): Promise<StoreAnswer> => page(3));
  call.mockResolvedValueOnce(first);
  const stopWatching = vi.fn();
  let onData: (space: string, rev: number) => void = () => {};
  let onAll = () => {};
  let socket = live;
  const feed = createStoreFeed({
    call,
    space: SPACE,
    watch: (d, a) => {
      onData = d;
      onAll = a;
      return stopWatching;
    },
    live: () => socket,
    visible,
  });
  const pushed: unknown[] = [];
  const failed: VerbError[] = [];
  const off = feed.subscribe(arg, (v) => void pushed.push(v), (e) => void failed.push(e));
  return {
    feed,
    off: off as () => void,
    call,
    stopWatching,
    pushed,
    failed,
    data: (rev: number, space = SPACE) => onData(space, rev),
    all: () => onAll(),
    setLive: (v: boolean) => void (socket = v),
    changesArgs: () => call.mock.calls.filter((c) => c[0] === "store.changes").map((c) => c[1][0]),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a frame's store.subscribe (store.changes, contract §6)", () => {
  it("names a widget's space as the desktop does", () => {
    expect(gardenDataSpace("board")).toBe("data:board");
    expect(gardenDataSpace("k2:diary@2")).toBe("data:k2:diary");
  });

  it("first read: the subscriber's cursor and prefix through the door, every page, one push", async () => {
    const s = setup({
      arg: { prefix: "a/", since: 2 },
      first: ok({ head: 4, items: [A1], next: { since: 3, after: "a/1" }, partial: true }),
    });
    s.call.mockResolvedValueOnce(page(4, [change("a/2", 4)]));
    await flush();
    expect(s.changesArgs()).toEqual([
      { since: 2, prefix: "a/" },
      { since: 3, after: "a/1", prefix: "a/" },
    ]);
    expect(s.pushed).toEqual([[row(A1), row(change("a/2", 4))]]);
  });

  it("the first delivery comes even when nothing is there", async () => {
    const s = setup({ first: page(0) });
    await flush();
    expect(s.pushed).toEqual([[]]);
  });

  it("an event for its space reads after the cursor and pushes; others are ignored", async () => {
    const s = setup();
    await flush();
    s.data(3);
    s.data(9, "data:other");
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    expect(s.call).toHaveBeenCalledTimes(1);

    const del = change("a/1", 4, null);
    s.call.mockResolvedValueOnce(page(4, [del]));
    s.data(4);
    await flush();
    expect(s.changesArgs()[1]).toEqual({ since: 3, prefix: "a/" });
    expect(s.pushed).toEqual([[row(A1)], [row(del)]]);

    // Nothing new under the prefix: no push.
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    s.call.mockResolvedValueOnce(page(5));
    s.data(5);
    await flush();
    expect(s.changesArgs()[2]).toEqual({ since: 4, prefix: "a/" });
    expect(s.pushed).toHaveLength(2);
  });

  it("coalesces a burst: at most one read per 250 ms, and events during a read become one more", async () => {
    const s = setup();
    await flush();
    for (let rev = 4; rev < 10; rev++) s.data(rev);
    await flush();
    expect(s.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    expect(s.call).toHaveBeenCalledTimes(2);

    let answer: (a: StoreAnswer) => void = () => {};
    s.call.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    s.data(11);
    await flush();
    expect(s.call).toHaveBeenCalledTimes(3);
    s.data(12);
    s.data(13);
    answer(page(3));
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS * 4);
    expect(s.call).toHaveBeenCalledTimes(4);
  });

  it("resync: lists everything by pages, pushes {resync, items}, then reads from reapedRev", async () => {
    const s = setup({ arg: { prefix: "a/", since: 1 }, first: no("resync", { reapedRev: 6 }) });
    const e1 = { key: "a/1", rev: 7, value: 1, by: "you", updatedAt: 0 };
    const e2 = { key: "a/2", rev: 8, value: 2, by: "you", updatedAt: 0 };
    s.call.mockResolvedValueOnce(ok({ items: [e1], next: "a/1" }));
    s.call.mockResolvedValueOnce(ok({ items: [e2], next: null }));
    s.call.mockResolvedValueOnce(page(8));
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    const lists = s.call.mock.calls.filter((c) => c[0] === "store.list").map((c) => c[1][0]);
    expect(lists).toEqual([
      { limit: 500, prefix: "a/" },
      { after: "a/1", limit: 500, prefix: "a/" },
    ]);
    expect(s.pushed).toEqual([{ resync: true, items: [e1, e2] }]);
    expect(s.changesArgs()[1]).toEqual({ since: 6, prefix: "a/" });
    // The replay held nothing new: no second push.
    expect(s.pushed).toHaveLength(1);
  });

  it("a lost cursor (the space went back past it) resyncs from the head", async () => {
    const s = setup({ arg: { since: 40 }, first: page(4) });
    s.call.mockResolvedValueOnce(ok({ items: [], next: null }));
    s.call.mockResolvedValueOnce(page(4));
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    expect(s.pushed).toEqual([{ resync: true, items: [] }]);
    expect(s.changesArgs()[1]).toEqual({ since: 4, prefix: "" });
  });

  it("a door refusal ends it once, through fail, and stops listening", async () => {
    const s = setup({ first: no("cap_not_granted") });
    await flush();
    expect(s.failed.map((e) => e.code)).toEqual(["cap_not_granted"]);
    expect(s.stopWatching).toHaveBeenCalledTimes(1);
    s.data(9);
    await vi.advanceTimersByTimeAsync(STORE_POLL_MS * 2);
    expect(s.call).toHaveBeenCalledTimes(1);
  });

  it("rate_limited retries after K2's wait (1 s at least)", async () => {
    const s = setup({ first: no("rate_limited", { retryAfterSecs: 3 }) });
    await vi.advanceTimersByTimeAsync(STORE_RETRY_MS);
    expect(s.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.call).toHaveBeenCalledTimes(2);
    expect(s.failed).toEqual([]);
    expect(s.pushed).toEqual([[]]);
  });

  it("unreachable stays quiet; the next event (or the poll) reads again", async () => {
    const s = setup({ first: no("unreachable") });
    await flush();
    expect(s.failed).toEqual([]);
    s.data(1);
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    expect(s.call).toHaveBeenCalledTimes(2);
    expect(s.pushed).toEqual([[]]);
  });

  it("without the app socket a 15 s poll reads; with it, no poll", async () => {
    const s = setup({ live: false });
    await flush();
    await vi.advanceTimersByTimeAsync(STORE_POLL_MS);
    expect(s.call).toHaveBeenCalledTimes(2);
    s.setLive(true);
    await vi.advanceTimersByTimeAsync(STORE_POLL_MS * 2);
    expect(s.call).toHaveBeenCalledTimes(2);
  });

  it("a re-pull (socket re-open, foreground) reads every subscription", async () => {
    const s = setup();
    await flush();
    s.all();
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    expect(s.changesArgs()[1]).toEqual({ since: 3, prefix: "a/" });
  });

  it("holds reads while out of sight, and catches up once", async () => {
    const s = setup({ visible: false });
    await flush();
    expect(s.pushed).toEqual([[row(A1)]]);
    s.data(4);
    s.data(5);
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS * 4);
    expect(s.call).toHaveBeenCalledTimes(1);
    s.feed.setVisible(true);
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS * 4);
    expect(s.call).toHaveBeenCalledTimes(2);
  });

  it("from: the neighbour's space and args, as the widget gave them", async () => {
    const s = setup({ arg: { prefix: "n/", from: "k2:diary@2" } });
    await flush();
    expect(s.changesArgs()[0]).toEqual({ since: 0, prefix: "n/", from: "k2:diary@2" });
    s.data(4);
    await flush();
    expect(s.call).toHaveBeenCalledTimes(1);
    s.data(4, "data:k2:diary");
    await vi.advanceTimersByTimeAsync(STORE_READ_GAP_MS);
    expect(s.call).toHaveBeenCalledTimes(2);
  });

  it("refuses bad arguments as the desktop does", () => {
    const feed = createStoreFeed({ call: vi.fn(), space: SPACE, watch: () => () => {}, live: () => true, visible: true });
    const sub = (arg: unknown) => feed.subscribe(arg, () => {}, () => {});
    expect(sub({ since: -1 })).toMatchObject({ code: "failed" });
    expect(sub({ prefix: 3 })).toMatchObject({ code: "failed" });
    expect(sub(7)).toMatchObject({ code: "failed" });
  });

  it("unsubscribing stops listening and the poll, and a read in flight never pushes", async () => {
    const s = setup({ live: false });
    s.off();
    await flush();
    expect(s.pushed).toEqual([]);
    expect(s.stopWatching).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STORE_POLL_MS * 2);
    expect(s.failed).toEqual([]);
  });
});
