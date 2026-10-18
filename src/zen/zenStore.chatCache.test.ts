import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Opening a chat paints its cached copy first (stale-while-revalidate),
// then merges the server's read over it.

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

import { getAgentList, getThread, type ThreadItem } from "../api/client";
import { fetchProjectGroupDelta, fetchThreadDelta } from "../api/threadDelta";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { useServersStore } from "../stores/servers";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { chatCache, createChatCache, setChatCacheForTests } from "./chatCache";
import { memoryBackend } from "./chatCacheBackend";
import { chatOpenTimings, resetChatTimings } from "./chatTiming";
import { healthStore } from "./multi/serverHealth";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";

type Page = { ok: boolean; data?: { items: ThreadItem[]; has_more?: boolean; conversation_id?: string }; error?: string };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function item(seq: number, body = `msg ${seq}`, extra: Record<string, unknown> = {}): ThreadItem {
  return { id: `m${seq}`, seq, doc: { from: "appa", body, created_at: seq, ...extra } } as ThreadItem;
}

function cachedMsg(seq: number, text = `msg ${seq}`): ThreadMessage {
  return { id: `m${seq}`, seq, text, from: "appa", at: seq, mine: false, kind: "text", choice: null };
}

const ids = () => useZenStore.getState().thread.map((m) => m.id);
const flushMicro = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "me", token: "tok" }));
  setChatCacheForTests(createChatCache({ backend: () => memoryBackend() }));
  resetChatTimings();
  healthStore.setState({ downSince: {} });
  useZenStore.setState({
    agentSource: "live",
    agentId: "appa",
    screen: "thread",
    thread: [],
    threadCached: false,
    threadSource: "loading",
    threadAddr: null,
    threadGroupId: null,
    threadConversationId: null,
    outbox: [],
  });
  vi.mocked(getThread).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function seed(key: string, messages: ThreadMessage[], conversationId: string | null = "conv-a") {
  chatCache().remember({ key, serverId: "s1", messages, conversationId, hasMore: false });
}

describe("Thread open: stale-while-revalidate", () => {
  it("paints the memory copy before the read resolves, then merges the server's", async () => {
    seed("s1|t:appa", [cachedMsg(1), cachedMsg(2, "stale")]);
    const read = deferred<Page>();
    vi.mocked(getThread).mockReturnValueOnce(read.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    let s = useZenStore.getState();
    expect(s.threadSource).toBe("live");
    expect(s.threadCached).toBe(true);
    expect(ids()).toEqual(["m1", "m2"]);
    expect(s.threadConversationId).toBe("conv-a"); // the live socket can dial at once
    const first = s.thread[0];

    read.resolve({ ok: true, data: { conversation_id: "conv-a", items: [item(1), item(2, "fresh"), item(3)] } });
    await done;
    s = useZenStore.getState();
    expect(s.threadCached).toBe(false);
    expect(s.threadSource).toBe("live");
    expect(ids()).toEqual(["m1", "m2", "m3"]);
    expect(s.thread[1].text).toBe("fresh");
    expect(s.thread[0]).toBe(first); // unchanged: same object
  });

  it("no memory copy: the device copy paints while the read is still out", async () => {
    const backend = memoryBackend();
    const writer = createChatCache({ backend: () => backend });
    writer.remember({ key: "s1|t:appa", serverId: "s1", messages: [cachedMsg(1)], conversationId: "c", hasMore: true });
    await writer.flush();
    setChatCacheForTests(createChatCache({ backend: () => backend })); // a cold start
    const read = deferred<Page>();
    vi.mocked(getThread).mockReturnValueOnce(read.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadSource).toBe("loading");
    await flushMicro();
    expect(useZenStore.getState().threadCached).toBe(true);
    expect(ids()).toEqual(["m1"]);
    expect(useZenStore.getState().threadHasMore).toBe(true);
    read.resolve({ ok: true, data: { conversation_id: "c", items: [item(1), item(2)] } });
    await done;
    expect(ids()).toEqual(["m1", "m2"]);
    expect(useZenStore.getState().threadCached).toBe(false);
    const t = chatOpenTimings("s1")[0];
    expect(t.cachedFrom).toBe("device");
    expect(t.items).toBe(2);
    expect(t.responseMs).not.toBeNull();
  });

  it("a failed read keeps the cached copy and says so", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    vi.mocked(getThread).mockResolvedValueOnce({ ok: false, error: "HTTP 404" } as never);
    await useZenStore.getState().hydrateThread("appa");
    const s = useZenStore.getState();
    expect(ids()).toEqual(["m1"]);
    expect(s.threadSource).toBe("error");
    expect(s.threadError).toBe("HTTP 404");
    expect(s.threadCached).toBe(true);
  });

  it("a server already known to be down: the cached copy stays, quietly", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    healthStore.setState({ downSince: { s1: Date.now() } });
    vi.mocked(getThread).mockResolvedValueOnce({ ok: false, error: "Could not reach server: x" } as never);
    await useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadSource).toBe("live");
    expect(ids()).toEqual(["m1"]);
  });

  it("a thrown read keeps the cached copy too", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    vi.mocked(getThread).mockRejectedValueOnce(new Error("Could not reach server: offline"));
    await useZenStore.getState().hydrateThread("appa");
    expect(ids()).toEqual(["m1"]);
    expect(useZenStore.getState().threadSource).toBe("error");
  });

  it("pending sends (outbox) are untouched by the refresh", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    const read = deferred<Page>();
    vi.mocked(getThread).mockReturnValueOnce(read.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    const localId = useZenStore.getState().queueOutgoing({ text: "hi" });
    read.resolve({ ok: true, data: { conversation_id: "conv-a", items: [item(1), item(2)] } });
    await done;
    expect(useZenStore.getState().outbox.map((o) => o.localId)).toEqual([localId]);
    expect(ids()).toEqual(["m1", "m2"]);
  });

  it("a live frame landing during the read survives the merge", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    const read = deferred<Page>();
    vi.mocked(getThread).mockReturnValueOnce(read.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    useZenStore.getState().ingestThreadRaw(item(5, "live"));
    read.resolve({ ok: true, data: { conversation_id: "conv-a", items: [item(1), item(2)] } });
    await done;
    expect(ids()).toEqual(["m1", "m2", "m5"]);
  });

  it("cached messages the server no longer has are dropped", async () => {
    seed("s1|t:appa", [cachedMsg(1), cachedMsg(2), cachedMsg(3)]);
    vi.mocked(getThread).mockResolvedValueOnce({ ok: true, data: { conversation_id: "conv-a", items: [item(1), item(3)] } } as never);
    await useZenStore.getState().hydrateThread("appa");
    expect(ids()).toEqual(["m1", "m3"]);
  });

  it("a confirmed read becomes the cached copy (memory now, device after flush)", async () => {
    vi.mocked(getThread).mockResolvedValueOnce({
      ok: true,
      data: {
        conversation_id: "conv-z",
        has_more: true,
        items: [
          item(1),
          item(2, "", { attachments: [{ kind: "file", path: "a.txt", name: "a.txt", size: 3, state: "ok" }] }),
        ],
      },
    } as never);
    await useZenStore.getState().hydrateThread("appa");
    const e = chatCache().peek("s1|t:appa");
    expect(e?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(e?.messages[1].files?.[0].path).toBe("a.txt"); // files are cached too
    expect(e?.conversationId).toBe("conv-z");
    expect(e?.hasMore).toBe(true);
  });

  it("the cached paint itself is not re-saved (only confirmed copies are)", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    const spy = vi.spyOn(chatCache(), "remember");
    const read = deferred<Page>();
    vi.mocked(getThread).mockReturnValueOnce(read.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    expect(spy).not.toHaveBeenCalled();
    read.resolve({ ok: true, data: { conversation_id: "conv-a", items: [item(1)] } });
    await done;
    expect(spy).toHaveBeenCalled();
  });

  it("another server's cache is never used", async () => {
    chatCache().remember({ key: "s2|t:appa", serverId: "s2", messages: [cachedMsg(9)], conversationId: null, hasMore: false });
    const read = deferred<Page>();
    vi.mocked(getThread).mockReturnValueOnce(read.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadSource).toBe("loading");
    expect(ids()).toEqual([]);
    read.resolve({ ok: true, data: { items: [] } });
    await done;
  });
});

describe("resumed chat (a room on another server, a cold launch)", () => {
  it("paints the cached copy before the server's lists load", async () => {
    seed("s1|t:appa", [cachedMsg(1), cachedMsg(2)]);
    useZenStore.setState({ agents: [] });
    vi.mocked(getAgentList).mockReturnValueOnce(new Promise(() => undefined) as never);
    void useZenStore.getState().hydrateAgents({ resumeId: "appa" });
    const s = useZenStore.getState();
    expect(s.screen).toBe("thread");
    expect(s.threadCached).toBe(true);
    expect(s.threadSource).toBe("live");
    expect(s.threadAddr).toBe("appa");
    expect(ids()).toEqual(["m1", "m2"]);
    expect(chatOpenTimings("s1")[0].cachedFrom).toBe("memory");
  });
});

describe("project chat open", () => {
  it("paints the cached lines, then the server's page replaces them; seen only after the read", async () => {
    chatCache().remember({
      key: "s1|g:grp1",
      serverId: "s1",
      messages: [{ ...cachedMsg(0, "old"), id: "g1", readSeq: 10 }],
      conversationId: null,
      hasMore: false,
    });
    const read = deferred<{ ok: boolean; data: { messages: unknown[]; truncated: boolean } }>();
    vi.mocked(fetchProjectGroupMessages).mockReturnValueOnce(read.promise as never);
    const rev = useZenStore.getState().groupSeenRev;
    const done = useZenStore.getState().hydrateGroup("grp1");
    expect(useZenStore.getState().threadCached).toBe(true);
    expect(useZenStore.getState().threadGroupId).toBe("grp1");
    expect(ids()).toEqual(["g1"]);
    expect(useZenStore.getState().groupSeenRev).toBe(rev);
    read.resolve({
      ok: true,
      data: {
        messages: [
          { id: "g1", groupId: "grp1", author: "a", body: "old", createdAt: 1, seq: 10 },
          { id: "g2", groupId: "grp1", author: "me", body: "new", createdAt: 2, seq: 11 },
        ],
        truncated: false,
      },
    });
    await done;
    expect(ids()).toEqual(["g1", "g2"]);
    expect(useZenStore.getState().threadCached).toBe(false);
    expect(useZenStore.getState().groupSeenRev).toBe(rev + 1);
    expect(chatCache().peek("s1|g:grp1")?.messages.map((m) => m.id)).toEqual(["g1", "g2"]);
  });

  it("a failed project read keeps the cached lines", async () => {
    chatCache().remember({ key: "s1|g:grp1", serverId: "s1", messages: [{ ...cachedMsg(0), id: "g1" }], conversationId: null, hasMore: false });
    vi.mocked(fetchProjectGroupMessages).mockResolvedValueOnce({ ok: false, error: "HTTP 404" } as never);
    await useZenStore.getState().hydrateGroup("grp1");
    expect(ids()).toEqual(["g1"]);
    expect(useZenStore.getState().threadSource).toBe("error");
  });
});

describe("wipes", () => {
  it("signing out of a server, or removing it, wipes its chats", async () => {
    useServersStore.setState({
      hydrated: true,
      servers: [
        { id: "s1", nickname: "", url: "https://s1.k2.dev", username: "u", rememberPassword: false },
        { id: "s2", nickname: "", url: "https://s2.k2.dev", username: "u", rememberPassword: false },
      ],
      tokens: { s1: "a", s2: "b" },
    });
    seed("s1|t:appa", [cachedMsg(1)]);
    chatCache().remember({ key: "s2|t:x", serverId: "s2", messages: [cachedMsg(1)], conversationId: null, hasMore: false });
    useServersStore.setState({ tokens: { s2: "b" } }); // s1 signed out
    await flushMicro();
    expect(chatCache().peek("s1|t:appa")).toBeNull();
    expect(chatCache().peek("s2|t:x")).not.toBeNull();
    useServersStore.getState().removeServer("s2");
    await flushMicro();
    expect(chatCache().peek("s2|t:x")).toBeNull();
  });
});

describe("open with thread-delta-v1", () => {
  beforeEach(() => {
    setZenScope(fakeScope({ id: "s1", username: "me", token: "tok", features: ["thread-delta-v1"] }));
    vi.mocked(fetchThreadDelta).mockReset();
    vi.mocked(fetchProjectGroupDelta).mockReset();
  });

  const delta = (data: Record<string, unknown>) =>
    ({ ok: true, data: { items: [], changed: [], removed: [], hasMore: false, conversationId: "conv-a", bytes: 40, ...data } }) as never;

  it("reads only what changed since the cached copy, and that confirms it", async () => {
    seed("s1|t:appa", [cachedMsg(1), cachedMsg(2)]);
    const d = deferred<unknown>();
    vi.mocked(fetchThreadDelta).mockReturnValueOnce(d.promise as never);
    const done = useZenStore.getState().hydrateThread("appa");
    expect(useZenStore.getState().threadCached).toBe(true);
    d.resolve(delta({ items: [item(3)], changed: [item(2, "edited")], removed: [{ id: "m1", seq: 1 }] }));
    await done;
    expect(fetchThreadDelta).toHaveBeenCalledWith(expect.anything(), "appa", 2, 50);
    expect(getThread).not.toHaveBeenCalled();
    const s = useZenStore.getState();
    expect(ids()).toEqual(["m2", "m3"]);
    expect(s.thread[0].text).toBe("edited");
    expect(s.threadCached).toBe(false); // read marking / answering unblocked
    expect(s.threadSource).toBe("live");
    const t = chatOpenTimings("s1")[0];
    expect(t.mode).toBe("delta");
    expect([t.items, t.changed, t.removed]).toEqual([1, 1, 1]);
    expect(chatCache().peek("s1|t:appa")?.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("the device copy's cursor is used on a cold start", async () => {
    const backend = memoryBackend();
    const writer = createChatCache({ backend: () => backend });
    writer.remember({ key: "s1|t:appa", serverId: "s1", messages: [cachedMsg(4)], conversationId: "conv-a", hasMore: false });
    await writer.flush();
    setChatCacheForTests(createChatCache({ backend: () => backend }));
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce(delta({ items: [item(5)] }));
    await useZenStore.getState().hydrateThread("appa");
    expect(fetchThreadDelta).toHaveBeenCalledWith(expect.anything(), "appa", 4, 50);
    expect(ids()).toEqual(["m4", "m5"]);
  });

  it("no cached copy: the newest page, never after_seq", async () => {
    vi.mocked(getThread).mockResolvedValueOnce({ ok: true, data: { conversation_id: "c", items: [item(1)] } } as never);
    await useZenStore.getState().hydrateThread("appa");
    expect(fetchThreadDelta).not.toHaveBeenCalled();
    expect(chatOpenTimings("s1")[0].mode).toBe("page");
  });

  it("has_more: pages forward until caught up", async () => {
    seed("s1|t:appa", [cachedMsg(1), cachedMsg(2)]);
    vi.mocked(fetchThreadDelta)
      .mockResolvedValueOnce(delta({ items: [item(3)], changed: [item(1, "fixed")], hasMore: true }))
      .mockResolvedValueOnce(delta({ items: [item(4)], changed: [item(1, "fixed")] }));
    await useZenStore.getState().hydrateThread("appa");
    expect(vi.mocked(fetchThreadDelta).mock.calls.map((c) => c[2])).toEqual([2, 3]);
    expect(getThread).not.toHaveBeenCalled();
    expect(ids()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(useZenStore.getState().thread[0].text).toBe("fixed");
    expect(chatOpenTimings("s1")[0].mode).toBe("delta");
  });

  it("more than four pages new: the newest page replaces the copy; Load earlier pages back from it", async () => {
    seed("s1|t:appa", [cachedMsg(1), cachedMsg(2)]);
    vi.mocked(fetchThreadDelta).mockImplementation(async (_s, _a, after) => delta({ items: [item(after + 1)], hasMore: true }));
    vi.mocked(getThread).mockResolvedValueOnce({ ok: true, data: { conversation_id: "conv-a", has_more: true, items: [item(80), item(81)] } } as never);
    await useZenStore.getState().hydrateThread("appa");
    expect(fetchThreadDelta).toHaveBeenCalledTimes(4);
    expect(ids()).toEqual(["m80", "m81"]);
    expect(useZenStore.getState().threadHasMore).toBe(true);
    expect(useZenStore.getState().threadOldestSeq).toBe(80);
    expect(chatOpenTimings("s1")[0].mode).toBe("replace");
  });

  it("the conversation moved: the copy is dropped for the newest page", async () => {
    seed("s1|t:appa", [cachedMsg(30), cachedMsg(31)]);
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce(delta({ conversationId: "conv-b" }));
    vi.mocked(getThread).mockResolvedValueOnce({ ok: true, data: { conversation_id: "conv-b", items: [item(1), item(2)] } } as never);
    await useZenStore.getState().hydrateThread("appa");
    expect(ids()).toEqual(["m1", "m2"]);
    expect(useZenStore.getState().threadConversationId).toBe("conv-b");
    expect(chatCache().peek("s1|t:appa")?.conversationId).toBe("conv-b");
  });

  it("403 / 404: the chat's cache is dropped and the error shows as before", async () => {
    seed("s1|t:appa", [cachedMsg(1)]);
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce({ ok: false, status: 403, error: "skin_room" } as never);
    await useZenStore.getState().hydrateThread("appa");
    const s = useZenStore.getState();
    expect(s.threadSource).toBe("error");
    expect(s.threadError).toBe("skin_room");
    expect(ids()).toEqual([]);
    expect(chatCache().peek("s1|t:appa")).toBeNull();
  });

  it("project chat: delta on open; 404 drops the project's cache", async () => {
    chatCache().remember({
      key: "s1|g:grp1",
      serverId: "s1",
      messages: [{ ...cachedMsg(0), id: "g1", readSeq: 10 }],
      conversationId: null,
      hasMore: false,
    });
    vi.mocked(fetchProjectGroupDelta).mockResolvedValueOnce(
      delta({ conversationId: null, items: [{ id: "g2", groupId: "grp1", author: "me", body: "hi", createdAt: 2, seq: 11 }] })
    );
    await useZenStore.getState().hydrateGroup("grp1");
    expect(fetchProjectGroupDelta).toHaveBeenCalledWith(expect.anything(), "grp1", 10, 50);
    expect(ids()).toEqual(["g1", "g2"]);
    expect(useZenStore.getState().threadCached).toBe(false);

    vi.mocked(fetchProjectGroupDelta).mockResolvedValueOnce({ ok: false, status: 404, error: "not found" } as never);
    await useZenStore.getState().hydrateGroup("grp1");
    expect(useZenStore.getState().threadSource).toBe("error");
    expect(ids()).toEqual([]);
    expect(chatCache().peek("s1|g:grp1")).toBeNull();
  });
});

describe("foreground re-read (refreshOpenThread)", () => {
  beforeEach(() => {
    vi.mocked(fetchThreadDelta).mockReset();
  });

  it("with the key: a delta from the newest seq on screen — a card answered while away lands", async () => {
    setZenScope(fakeScope({ id: "s1", username: "me", token: "tok", features: ["thread-delta-v1"] }));
    const pendingCard: ThreadMessage = { ...cachedMsg(2, ""), kind: "choice", choice: { prompt: "Ship?", options: ["Ship", "Hold"], answer: null } };
    useZenStore.setState({ threadAddr: "appa", threadConversationId: "conv-a", threadSource: "live", thread: [cachedMsg(1), pendingCard] });
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce({
      ok: true,
      data: {
        items: [item(3)],
        changed: [item(2, "", { kind: "choice", choice: { prompt: "Ship?", options: ["Ship", "Hold"], answer: "Ship" } })],
        removed: [],
        hasMore: false,
        conversationId: "conv-a",
        bytes: 1,
      },
    } as never);
    await useZenStore.getState().refreshOpenThread();
    expect(fetchThreadDelta).toHaveBeenCalledWith(expect.anything(), "appa", 2, 50);
    expect(getThread).not.toHaveBeenCalled();
    expect(ids()).toEqual(["m1", "m2", "m3"]);
    expect(useZenStore.getState().thread[1].choice?.answer).toBe("Ship");
  });

  it("without the key: the full newest page, as before", async () => {
    useZenStore.setState({ threadAddr: "appa", threadConversationId: "conv-a", threadSource: "live", thread: [cachedMsg(1)] });
    vi.mocked(getThread).mockResolvedValueOnce({ ok: true, data: { conversation_id: "conv-a", items: [item(1), item(2)] } } as never);
    await useZenStore.getState().refreshOpenThread();
    expect(fetchThreadDelta).not.toHaveBeenCalled();
    expect(ids()).toEqual(["m1", "m2"]);
  });

  it("a failure keeps the screen; 403 / 404 clears the chat and its cache", async () => {
    setZenScope(fakeScope({ id: "s1", username: "me", token: "tok", features: ["thread-delta-v1"] }));
    seed("s1|t:appa", [cachedMsg(1)]);
    useZenStore.setState({ threadAddr: "appa", threadConversationId: "conv-a", threadSource: "live", thread: [cachedMsg(1)] });
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce({ ok: false, error: "Could not reach server: x" } as never);
    await useZenStore.getState().refreshOpenThread();
    expect(ids()).toEqual(["m1"]);
    vi.mocked(fetchThreadDelta).mockResolvedValueOnce({ ok: false, status: 404, error: "gone" } as never);
    await useZenStore.getState().refreshOpenThread();
    expect(ids()).toEqual([]);
    expect(useZenStore.getState().threadSource).toBe("error");
    expect(chatCache().peek("s1|t:appa")).toBeNull();
  });
});

describe("live frames", () => {
  it("a frame for a message already shown replaces it (the card's new state), keeping its file states", () => {
    const file = { n: 0, kind: "file", path: "a.txt", name: "a.txt", size: 1, mime: "text/plain", modifiedAt: null, sha256: null, line: null, lineEnd: null, state: "gone" as const };
    const pendingCard: ThreadMessage = { ...cachedMsg(2, "Ship?"), kind: "choice", choice: { prompt: "Ship?", options: ["Ship"], answer: null }, files: [file] };
    useZenStore.setState({ threadAddr: "appa", threadSource: "live", thread: [cachedMsg(1), pendingCard] });
    useZenStore.getState().ingestThreadRaw(
      item(2, "Ship?", { kind: "choice", choice: { prompt: "Ship?", options: ["Ship"], answer: "Ship" } })
    );
    const t = useZenStore.getState().thread;
    expect(t.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(t[1].choice?.answer).toBe("Ship");
    expect(t[1].files?.[0].state).toBe("gone");
    const before = useZenStore.getState().thread;
    useZenStore.getState().ingestThreadRaw(
      item(2, "Ship?", { kind: "choice", choice: { prompt: "Ship?", options: ["Ship"], answer: "Ship" } })
    );
    expect(useZenStore.getState().thread).toBe(before); // nothing new: no re-render
  });
});
