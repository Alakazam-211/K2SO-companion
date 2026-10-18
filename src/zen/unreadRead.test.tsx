// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("../api/threadRead", () => ({
  getThreadUnread: vi.fn(),
  postThreadRead: vi.fn(),
  postProjectRead: vi.fn(),
  postThreadMute: vi.fn(),
}));
vi.mock("../lib/badgeTotals", () => ({
  setServerTotals: vi.fn(),
  clearServerTotals: vi.fn(),
  onBadgeTotals: vi.fn(async () => () => {}),
}));

import * as api from "../api/threadRead";
import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { createReadMarker, useMarkReadWhileViewing } from "./unreadRead";
import { __resetUnreadStoreForTests, useUnreadStore } from "./unreadStore";
import type { RowRef } from "./unread";

describe("createReadMarker (throttle)", () => {
  it("leading send, then at most one per window with the newest seq", () => {
    let t = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const sent: number[] = [];
    const m = createReadMarker((s) => sent.push(s), {
      throttleMs: 1500,
      now: () => t,
      setTimer: (fn, ms) => {
        const x = { fn, at: t + ms };
        timers.push(x);
        return x;
      },
      clearTimer: (x) => {
        const i = timers.indexOf(x as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    m.see(5);
    expect(sent).toEqual([5]);
    t = 200;
    m.see(6);
    m.see(8);
    m.see(7); // older than pending: ignored
    expect(sent).toEqual([5]);
    expect(timers).toHaveLength(1);
    t = 1500;
    timers.shift()!.fn();
    expect(sent).toEqual([5, 8]);
    t = 4000;
    m.see(9);
    expect(sent).toEqual([5, 8, 9]);
  });

  it("flush sends what is pending (leaving the chat); dispose drops it", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const m = createReadMarker((s) => sent.push(s), { throttleMs: 1500 });
    m.see(1);
    m.see(2);
    m.flush();
    expect(sent).toEqual([1, 2]);
    m.see(3);
    m.dispose();
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([1, 2]);
    vi.useRealTimers();
  });
});

describe("useMarkReadWhileViewing", () => {
  const ref: RowRef = { kind: "thread", addr: "appa", conversationId: "c1" };

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetScopesForTests();
    __resetUnreadStoreForTests();
    useServersStore.setState({
      hydrated: true,
      servers: [{ id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false }],
      activeServerId: "s1",
      tokens: { s1: "tok" },
    });
    noteBootStatus("s1", { features: ["thread-read-v1"] });
    vi.mocked(api.getThreadUnread).mockResolvedValue({
      ok: true,
      data: {
        total: 4,
        waitingTotal: 0,
        byConversation: [{ kind: "thread", id: "c1", lastReadSeq: 3, lastSeq: 7, unread: 4, waiting: 0, muted: false }],
      },
    });
    vi.mocked(api.postThreadRead).mockResolvedValue({
      ok: true,
      data: { kind: "thread", id: "c1", lastReadSeq: 7, lastSeq: 7, unread: 0, waiting: 0, muted: false, total: 0, waitingTotal: 0 },
    });
    await useUnreadStore.getState().refresh("s1");
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("at the newest and in the foreground: reads up to the newest seq on screen", async () => {
    renderHook(() => useMarkReadWhileViewing({ serverId: "s1", rowRef: ref, newestSeq: 7, viewing: true }));
    await act(async () => {});
    expect(api.postThreadRead).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.postThreadRead).mock.calls[0][1]).toEqual({ conversationId: "c1", addr: "appa" });
    expect(vi.mocked(api.postThreadRead).mock.calls[0][2]).toBe(7);
    expect(useUnreadStore.getState().servers.s1.total).toBe(0);
  });

  it("scrolled up into history: no mark", async () => {
    renderHook(() => useMarkReadWhileViewing({ serverId: "s1", rowRef: ref, newestSeq: 7, viewing: false }));
    await act(async () => {});
    expect(api.postThreadRead).not.toHaveBeenCalled();
  });

  it("in the background: no mark, then one on coming back", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    renderHook(() => useMarkReadWhileViewing({ serverId: "s1", rowRef: ref, newestSeq: 7, viewing: true }));
    await act(async () => {});
    expect(api.postThreadRead).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(api.postThreadRead).toHaveBeenCalledTimes(1);
  });

  it("already read that far: no POST", async () => {
    renderHook(() => useMarkReadWhileViewing({ serverId: "s1", rowRef: ref, newestSeq: 3, viewing: true }));
    await act(async () => {});
    expect(api.postThreadRead).not.toHaveBeenCalled();
  });

  it("throttles newer messages, and leaving the chat sends the pending one", async () => {
    vi.mocked(api.postThreadRead).mockResolvedValueOnce({
      ok: true,
      data: { kind: "thread", id: "c1", lastReadSeq: 5, lastSeq: 7, unread: 2, waiting: 0, muted: false, total: 2, waitingTotal: 0 },
    });
    const { rerender, unmount } = renderHook(
      ({ seq }) => useMarkReadWhileViewing({ serverId: "s1", rowRef: ref, newestSeq: seq, viewing: true, throttleMs: 60_000 }),
      { initialProps: { seq: 5 } }
    );
    await act(async () => {});
    expect(api.postThreadRead).toHaveBeenCalledTimes(1);
    rerender({ seq: 7 });
    await act(async () => {});
    expect(api.postThreadRead).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {});
    expect(api.postThreadRead).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.postThreadRead).mock.calls[1][2]).toBe(7);
  });

  it("a server without the feature: nothing", async () => {
    noteBootStatus("s1", { features: [] });
    renderHook(() => useMarkReadWhileViewing({ serverId: "s1", rowRef: ref, newestSeq: 7, viewing: true }));
    await act(async () => {});
    expect(api.postThreadRead).not.toHaveBeenCalled();
  });
});
