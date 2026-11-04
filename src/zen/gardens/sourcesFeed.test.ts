import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VerbAnswer, VerbError } from "./frameHost";
import read from "./goldens/call-sources-read.json";
import notBound from "./goldens/call-sources-not-bound.json";
import changes from "./goldens/sources-changes.json";
import { createSourcesFeed, SOURCES_READ_GAP_MS, SOURCES_RETRY_MS } from "./sourcesFeed";

const FLEET = read.body.result;
const ok = (value: unknown): VerbAnswer => ({ ok: true, value });
const no = (code: string, extra: Partial<VerbError> = {}): VerbAnswer => ({ ok: false, error: { code, ...extra } });
const delta = (rev: number, changed: unknown[] = [], removed: string[] = [], full = false) =>
  ok({ rev, full, changed, removed });
const STALE = { phase: "stale", display: "stale", reach: "unreachable" };

function setup(visible = true, firstRead?: VerbAnswer) {
  const readView = vi.fn(async (_address: string): Promise<VerbAnswer> => ok(FLEET));
  if (firstRead) readView.mockResolvedValueOnce(firstRead);
  const readChanges = vi.fn(async (_since: number): Promise<VerbAnswer> => delta(5));
  const stopWatching = vi.fn();
  let fire = () => {};
  const feed = createSourcesFeed({
    readView,
    readChanges,
    watch: (onChange) => {
      fire = onChange;
      return stopWatching;
    },
    visible,
  });
  const pushed: unknown[] = [];
  const failed: VerbError[] = [];
  const off = feed.subscribe("fleet", (v) => void pushed.push(v), (e) => void failed.push(e));
  return { feed, off, readView, readChanges, stopWatching, pushed, failed, event: () => fire() };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a frame's sources.subscribe (contract rev 2 §E, §G)", () => {
  it("reads through the door first, then re-reads changes on an event with its own since", async () => {
    const s = setup();
    await flush();
    expect(s.readView).toHaveBeenCalledWith("fleet");
    expect(s.pushed).toEqual([FLEET]);
    expect(s.readChanges).not.toHaveBeenCalled();

    s.event();
    await flush();
    expect(s.readChanges).toHaveBeenLastCalledWith(0);
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS);
    s.event();
    await flush();
    expect(s.readChanges).toHaveBeenLastCalledWith(5);
    expect(s.pushed).toEqual([FLEET]);
  });

  it("takes K2's full answer and skips an identical push", async () => {
    const s = setup();
    await flush();
    s.readChanges.mockResolvedValueOnce(ok(changes.body));
    s.event();
    await flush();
    expect(s.pushed).toEqual([FLEET]);
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS);
    const moved = { ...FLEET, health: "crit" };
    s.readChanges.mockResolvedValueOnce(delta(6, [moved]));
    s.event();
    await flush();
    expect(s.pushed).toEqual([FLEET, moved]);
  });

  it("reads at most once per 2 s, and a burst becomes one more read", async () => {
    const s = setup();
    await flush();
    s.event();
    s.event();
    await flush();
    s.event();
    s.event();
    await flush();
    expect(s.readChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS);
    expect(s.readChanges).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS * 2);
    expect(s.readChanges).toHaveBeenCalledTimes(2);
  });

  it("holds re-reads while out of sight, and catches up once", async () => {
    const s = setup(false);
    await flush();
    expect(s.pushed).toEqual([FLEET]);
    s.event();
    s.event();
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS * 3);
    expect(s.readChanges).not.toHaveBeenCalled();
    s.feed.setVisible(true);
    await flush();
    expect(s.readChanges).toHaveBeenCalledTimes(1);
    s.feed.setVisible(false);
    s.feed.setVisible(true);
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS * 3);
    expect(s.readChanges).toHaveBeenCalledTimes(1);
  });

  it("greys the last view on a failed read, retries, and restores it when the server's back", async () => {
    const s = setup();
    await flush();
    s.readChanges.mockResolvedValueOnce(no("unreachable"));
    s.event();
    await flush();
    expect(s.pushed[1]).toEqual({ ...FLEET, ...STALE });
    expect(s.failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(SOURCES_RETRY_MS);
    expect(s.readChanges).toHaveBeenCalledTimes(2);
    expect(s.pushed).toEqual([FLEET, { ...FLEET, ...STALE }, FLEET]);
  });

  it("doesn't grey on rate_limited", async () => {
    const s = setup();
    await flush();
    s.readChanges.mockResolvedValueOnce(no("rate_limited"));
    s.event();
    await flush();
    expect(s.pushed).toEqual([FLEET]);
    expect(s.failed).toEqual([]);
  });

  it("an older daemon's 501 ends it once, with no more reads", async () => {
    const s = setup(true, no("verb_unavailable"));
    await flush();
    expect(s.failed.map((e) => e.code)).toEqual(["verb_unavailable"]);
    expect(s.stopWatching).toHaveBeenCalledTimes(1);
    s.event();
    await vi.advanceTimersByTimeAsync(SOURCES_RETRY_MS);
    expect(s.readChanges).not.toHaveBeenCalled();
  });

  it("passes on K2's refusal of an unbound source", async () => {
    const s = setup(true, no(notBound.body.error.code, { room: notBound.body.error.room }));
    await flush();
    expect(s.failed).toEqual([{ code: "not_bound", room: "private" }]);
  });

  it("no server yet: stays quiet, and the next event reads through the door again", async () => {
    const s = setup(true, no("unreachable"));
    await flush();
    expect(s.pushed).toEqual([]);
    expect(s.failed).toEqual([]);
    s.event();
    await flush();
    expect(s.readView).toHaveBeenCalledTimes(2);
    expect(s.pushed).toEqual([FLEET]);
  });

  it("ends a removed source, by name or missing from a full answer", async () => {
    const s = setup();
    await flush();
    s.readChanges.mockResolvedValueOnce(delta(6, [], ["fleet"]));
    s.event();
    await flush();
    expect(s.failed.map((e) => [e.code, e.room])).toEqual([["removed", "fleet"]]);

    const t = setup();
    await flush();
    t.readChanges.mockResolvedValueOnce(delta(1, [], [], true));
    t.event();
    await flush();
    expect(t.failed.map((e) => e.code)).toEqual(["removed"]);
  });

  it("a refusal of the changes route ends every subscription", async () => {
    const s = setup();
    await flush();
    s.readChanges.mockResolvedValueOnce(no("cap_not_granted", { cap: "sources:read" }));
    s.event();
    await flush();
    expect(s.failed.map((e) => e.code)).toEqual(["cap_not_granted"]);
  });

  it("unsubscribing stops listening and any waiting read", async () => {
    const s = setup();
    await flush();
    s.event();
    await flush();
    s.event();
    s.off();
    expect(s.stopWatching).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SOURCES_READ_GAP_MS * 2);
    expect(s.readChanges).toHaveBeenCalledTimes(1);
  });
});
