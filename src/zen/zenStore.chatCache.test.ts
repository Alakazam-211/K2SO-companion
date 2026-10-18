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

import { getAgentList, getThread, type ThreadItem } from "../api/client";
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
