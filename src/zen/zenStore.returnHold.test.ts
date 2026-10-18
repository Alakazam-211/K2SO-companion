import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh on return (`returnHold`): a chat whose cached copy is known to be
// behind the server holds its first paint briefly for the delta read, and
// paints the merged copy at once when it lands in time; otherwise the cache
// paints when the hold runs out and the read merges over it.

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);

vi.mock("../api/client", () => ({
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroupResources: vi.fn(async () => ({ ok: true, data: { docs: [] } })),
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));

vi.mock("../api/threadDelta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/threadDelta")>();
  return { ...actual, fetchThreadDelta: vi.fn(), fetchProjectGroupDelta: vi.fn() };
});

import { getThread, type ThreadItem } from "../api/client";
import { fetchProjectGroupDelta, fetchThreadDelta } from "../api/threadDelta";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { chatCache, createChatCache, setChatCacheForTests } from "./chatCache";
import { memoryBackend } from "./chatCacheBackend";
import { resetChatTimings } from "./chatTiming";
import { healthStore } from "./multi/serverHealth";
import { RETURN_HOLD_MS, holdFirstPaint, knownServerNewest } from "./returnHold";
import type { ThreadMessage } from "./threadModel";
import { blankEntry } from "./unread";
import { __resetUnreadStoreForTests, useUnreadStore } from "./unreadStore";
import { useZenStore } from "./zenStore";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function item(seq: number, body = `msg ${seq}`): ThreadItem {
  return { id: `m${seq}`, seq, doc: { from: "appa", body, created_at: seq } } as ThreadItem;
}
function cachedMsg(seq: number): ThreadMessage {
  return { id: `m${seq}`, seq, text: `msg ${seq}`, from: "appa", at: seq, mine: false, kind: "text", choice: null };
}
const delta = (data: Record<string, unknown>) =>
  ({ ok: true, data: { items: [], changed: [], removed: [], hasMore: false, conversationId: "conv-a", bytes: 40, ...data } }) as never;
const ids = () => useZenStore.getState().thread.map((m) => m.id);

/** The server's unread summary says `conv-a` (appa) is at `lastSeq`. */
function unreadAt(lastSeq: number) {
  useUnreadStore.setState({
    servers: {
      s1: {
        byKey: { "thread:conv-a": { ...blankEntry("thread", "conv-a"), lastSeq, unread: 2 } },
        total: 2,
        waitingTotal: 0,
        loaded: true,
      },
    },
    addrs: { s1: { appa: "conv-a" } },
  });
}

/** Every state the Thread passed through (painted or not). */
function recordPaints() {
  const seen: { ids: string[]; cached: boolean; source: string; holding: boolean }[] = [];
  const stop = useZenStore.subscribe((s) =>
    seen.push({ ids: s.thread.map((m) => m.id), cached: s.threadCached, source: s.threadSource, holding: s.threadHolding })
  );
  return { seen, stop };
}

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "me", token: "tok", features: ["thread-delta-v1"] }));
  setChatCacheForTests(createChatCache({ backend: () => memoryBackend() }));
  resetChatTimings();
  __resetUnreadStoreForTests();
  healthStore.setState({ downSince: {} });
  useZenStore.setState({
    agentSource: "live",
    agentId: "appa",
    screen: "thread",
    thread: [],
    threadCached: false,
    threadHolding: false,
    threadSource: "loading",
    threadAddr: null,
    threadGroupId: null,
    threadConversationId: null,
    previewByKey: {},
    outbox: [],
  });
  chatCache().remember({ key: "s1|t:appa", serverId: "s1", messages: [cachedMsg(1), cachedMsg(2)], conversationId: "conv-a", hasMore: false });
  vi.mocked(getThread).mockReset();
  vi.mocked(fetchThreadDelta).mockReset();
  vi.mocked(fetchProjectGroupDelta).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("returnHold (pure)", () => {
  it("holds only with the key, a delta cursor and a newer server seq", () => {
    const cache = { messages: [cachedMsg(1), cachedMsg(2)], conversationId: "c" };
    expect(holdFirstPaint({ delta: true, kind: "thread", cache, serverNewest: 3 })).toBe(true);
    expect(holdFirstPaint({ delta: true, kind: "thread", cache, serverNewest: 2 })).toBe(false);
    expect(holdFirstPaint({ delta: false, kind: "thread", cache, serverNewest: 3 })).toBe(false);
    expect(holdFirstPaint({ delta: true, kind: "thread", cache, serverNewest: null })).toBe(false);
    // No conversation id: no delta cursor, so nothing to wait for.
    expect(holdFirstPaint({ delta: true, kind: "thread", cache: { ...cache, conversationId: null }, serverNewest: 9 })).toBe(false);
    expect(knownServerNewest(undefined, 4, null, 7, 0)).toBe(7);
    expect(knownServerNewest()).toBeNull();
    expect(RETURN_HOLD_MS).toBeLessThanOrEqual(300);
  });
});

describe("opening a chat the cache is behind on", () => {
  it("the delta lands in time: nothing paints until the merged copy, at once", async () => {
    unreadAt(4);
    const d = deferred<unknown>();
    vi.mocked(fetchThreadDelta).mockReturnValueOnce(d.promise as never);
    const rec = recordPaints();
    const done = useZenStore.getState().hydrateThread("appa");
    let s = useZenStore.getState();
    expect(s.threadHolding).toBe(true);
    expect(s.threadSource).toBe("loading");
    expect(ids()).toEqual([]);
    d.resolve(delta({ items: [item(3), item(4)] }));
    await done;
    rec.stop();
    s = useZenStore.getState();
    expect(ids()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(s.threadCached).toBe(false);
    expect(s.threadHolding).toBe(false);
    expect(s.threadSource).toBe("live");
    expect(s.threadConversationId).toBe("conv-a");
    expect(fetchThreadDelta).toHaveBeenCalledWith(expect.anything(), "appa", 2, 50);
    // The stale copy was never on screen.
    expect(rec.seen.some((x) => x.ids.length === 2)).toBe(false);
  });

  it("the delta is slow: the cache paints when the hold runs out, then the read merges over it", async () => {
    vi.useFakeTimers();
    unreadAt(4);
    const d = deferred<unknown>();
    vi.mocked(fetchThreadDelta).mockReturnValueOnce(d.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadHolding).toBe(true);
    vi.advanceTimersByTime(RETURN_HOLD_MS - 1);
    expect(ids()).toEqual([]);
    vi.advanceTimersByTime(1);
    let s = useZenStore.getState();
    expect(ids()).toEqual(["m1", "m2"]);
    expect(s.threadCached).toBe(true);
    expect(s.threadHolding).toBe(false);
    expect(s.threadSource).toBe("live");
    d.resolve(delta({ items: [item(3), item(4)] }));
    await done;
    s = useZenStore.getState();
    expect(ids()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(s.threadCached).toBe(false);
  });

  it("the list's `latest` row is newer: holds too", async () => {
    useZenStore.setState({
      previewByKey: { "s1|t:appa": { at: 3, seq: 3, mine: false, kind: "text", text: "x" } },
    });
    const d = deferred<unknown>();
    vi.mocked(fetchThreadDelta).mockReturnValueOnce(d.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadHolding).toBe(true);
    d.resolve(delta({ items: [item(3)] }));
    await done;
    expect(ids()).toEqual(["m1", "m2", "m3"]);
  });

  it("a failed read during the hold paints the cached copy (and reports it)", async () => {
    unreadAt(4);
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce({ ok: false, status: 500, error: "boom" } as never);
    vi.mocked(getThread).mockResolvedValueOnce({ ok: false, status: 500, error: "boom" } as never);
    await useZenStore.getState().hydrateThread("appa");
    const s = useZenStore.getState();
    expect(ids()).toEqual(["m1", "m2"]);
    expect(s.threadHolding).toBe(false);
    expect(s.threadCached).toBe(true);
    expect(s.threadSource).toBe("error");
  });

  it("project chat: held for its delta too", async () => {
    chatCache().remember({
      key: "s1|g:grp1",
      serverId: "s1",
      messages: [{ ...cachedMsg(0), id: "g1", readSeq: 10 }],
      conversationId: null,
      hasMore: false,
    });
    useUnreadStore.setState({
      servers: {
        s1: {
          byKey: { "project:grp1": { ...blankEntry("project", "grp1"), lastSeq: 11, unread: 1 } },
          total: 1,
          waitingTotal: 0,
          loaded: true,
        },
      },
      addrs: {},
    });
    const d = deferred<unknown>();
    vi.mocked(fetchProjectGroupDelta).mockReturnValueOnce(d.promise as never);
    const done = useZenStore.getState().hydrateGroup("grp1");
    expect(useZenStore.getState().threadHolding).toBe(true);
    expect(ids()).toEqual([]);
    d.resolve(delta({ conversationId: null, items: [{ id: "g2", groupId: "grp1", author: "me", body: "hi", createdAt: 2, seq: 11 }] }));
    await done;
    expect(ids()).toEqual(["g1", "g2"]);
    expect(useZenStore.getState().threadHolding).toBe(false);
  });
});

describe("no hold", () => {
  async function opensAtOnce() {
    const d = deferred<unknown>();
    vi.mocked(fetchThreadDelta).mockReturnValueOnce(d.promise as never);
    vi.mocked(getThread).mockReturnValueOnce(d.promise as never);
    void useZenStore.getState().hydrateThread("appa");
    const s = useZenStore.getState();
    expect(s.threadHolding).toBe(false);
    expect(s.threadCached).toBe(true);
    expect(ids()).toEqual(["m1", "m2"]);
  }

  it("the cache is not behind", async () => {
    unreadAt(2);
    await opensAtOnce();
  });

  it("nothing known about the server's newest", async () => {
    await opensAtOnce();
  });

  it("the server has no thread-delta-v1", async () => {
    setZenScope(fakeScope({ id: "s1", username: "me", token: "tok" }));
    unreadAt(9);
    await opensAtOnce();
  });

  it("this chat's copy is already on screen (a resume painted it)", async () => {
    unreadAt(9);
    useZenStore.setState({ threadAddr: "appa", thread: [cachedMsg(1), cachedMsg(2)], threadSource: "live", threadCached: true });
    await opensAtOnce();
  });
});
