// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("../api/threadRead", () => ({
  getThreadUnread: vi.fn(),
  postThreadRead: vi.fn(),
  postProjectRead: vi.fn(),
  postThreadMute: vi.fn(),
}));

const badgeCbs: ((e: { serverId: string | null; subdomain: string; unread: number; waiting: number | null; sum: number }) => void)[] = [];
vi.mock("../lib/badgeTotals", () => ({
  setServerTotals: vi.fn(),
  clearServerTotals: vi.fn(),
  onBadgeTotals: vi.fn(async (cb) => {
    badgeCbs.push(cb);
    return () => {};
  }),
}));

type Sub = { id: string; onChange: () => void; onFrame?: (f: unknown) => void; match: (f: unknown) => boolean; stopped: boolean };
const subs: Sub[] = [];
vi.mock("./ticketEvents", () => ({
  subscribeAppEvents: vi.fn((scope, match, onChange, onFrame) => {
    const sub: Sub = { id: scope.id, match, onChange, onFrame, stopped: false };
    subs.push(sub);
    return { stop: () => void (sub.stopped = true) };
  }),
}));

const poolCbs: ((id: string, entry: unknown) => void)[] = [];
vi.mock("./multi/poolLoop", () => ({
  onPoolChecked: vi.fn((cb) => {
    poolCbs.push(cb);
    return () => {};
  }),
}));

vi.mock("./zenStore", () => ({
  useZenStore: (sel: (s: { agentSource: string }) => unknown) => sel({ agentSource: "live" }),
}));

import * as api from "../api/threadRead";
import * as badge from "../lib/badgeTotals";
import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { __resetUnreadStoreForTests, useUnreadStore } from "./unreadStore";
import { useUnreadSync } from "./unreadSync";

const summary = (total: number) => ({
  ok: true,
  data: {
    total,
    waitingTotal: 0,
    byConversation: [{ kind: "thread", id: "c1", lastReadSeq: 0, lastSeq: total, unread: total, waiting: 0, muted: false }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  subs.length = 0;
  poolCbs.length = 0;
  badgeCbs.length = 0;
  __resetScopesForTests();
  __resetUnreadStoreForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false },
      { id: "s2", nickname: "", url: "https://old.k2.dev", username: "baden", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok", s2: "tok" },
  });
  noteBootStatus("s1", { features: ["thread-read-v1"] });
  noteBootStatus("s2", { features: [] });
  vi.mocked(api.getThreadUnread).mockResolvedValue(summary(2));
});

afterEach(cleanup);

describe("useUnreadSync", () => {
  it("reads every supporting server on mount and opens its frame feed only", async () => {
    renderHook(() => useUnreadSync());
    await act(async () => {});
    expect(api.getThreadUnread).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.getThreadUnread).mock.calls[0][0].id).toBe("s1");
    expect(subs.map((s) => s.id)).toEqual(["s1"]);
    expect(badge.setServerTotals).toHaveBeenCalledWith("s1", { unread: 2, waiting: 0 });
  });

  it("applies read frames at once and feeds the badge", async () => {
    renderHook(() => useUnreadSync());
    await act(async () => {});
    const sub = subs[0];
    expect(sub.match({ kind: "thread_read" })).toBe(true);
    expect(sub.match({ kind: "projects_changed" })).toBe(false);
    act(() => {
      sub.onFrame?.({ kind: "thread_read", id: "c1", lastReadSeq: 2, lastSeq: 2, unread: 0, waiting: 0, muted: false, total: 0, waitingTotal: 0 });
    });
    expect(useUnreadStore.getState().servers.s1.total).toBe(0);
    expect(badge.setServerTotals).toHaveBeenLastCalledWith("s1", { unread: 0, waiting: 0 });
  });

  it("re-reads on a socket re-pull, a healthy pool check (throttled), a badge push and foreground", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    renderHook(() => useUnreadSync());
    await act(async () => {});
    expect(api.getThreadUnread).toHaveBeenCalledTimes(1);

    await act(async () => subs[0].onChange());
    expect(api.getThreadUnread).toHaveBeenCalledTimes(2);

    // A pool check right after: inside the 30 s gap, skipped.
    await act(async () => poolCbs[0]("s1", { reach: "live", auth: "ok" }));
    expect(api.getThreadUnread).toHaveBeenCalledTimes(2);
    vi.setSystemTime(1_000_000 + 31_000);
    await act(async () => poolCbs[0]("s1", { reach: "live", auth: "ok" }));
    expect(api.getThreadUnread).toHaveBeenCalledTimes(3);
    // Offline: no read.
    vi.setSystemTime(1_000_000 + 90_000);
    await act(async () => poolCbs[0]("s1", { reach: "offline", auth: "ok" }));
    expect(api.getThreadUnread).toHaveBeenCalledTimes(3);

    await act(async () => badgeCbs[0]({ serverId: "s1", subdomain: "dtl", unread: 9, waiting: 0, sum: 9 }));
    expect(api.getThreadUnread).toHaveBeenCalledTimes(4);

    vi.setSystemTime(1_000_000 + 200_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(api.getThreadUnread).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it("a server without the feature is never asked, and gets no feed", async () => {
    renderHook(() => useUnreadSync());
    await act(async () => {});
    await act(async () => poolCbs[0]("s2", { reach: "live", auth: "ok" }));
    expect(vi.mocked(api.getThreadUnread).mock.calls.every((c) => c[0].id === "s1")).toBe(true);
    expect(subs.some((s) => s.id === "s2")).toBe(false);
  });

  it("unmount stops the feeds", async () => {
    const { unmount } = renderHook(() => useUnreadSync());
    await act(async () => {});
    unmount();
    expect(subs[0].stopped).toBe(true);
  });
});
