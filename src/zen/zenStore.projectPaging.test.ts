import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// K2 0.46.2 `project-chat-paging-v1`: `loadEarlier` on a project chat pages
// back from its lowest line seq (`before_seq`) when the server lists the
// key; without it the chat grows from memory only (nothing is fetched).

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

vi.mock("../api/projectGroups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/projectGroups")>();
  return {
    ...actual,
    fetchProjectGroupResources: vi.fn(async () => ({ ok: true, data: { docs: [] } })),
    fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
    fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
    fetchProjectGroupOlder: vi.fn(),
    postProjectGroupMessage: vi.fn(),
  };
});

import { getThread } from "../api/client";
import { fetchProjectGroupOlder, type ProjectGroupMessage } from "../api/projectGroups";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { chatCache, createChatCache, setChatCacheForTests } from "./chatCache";
import { memoryBackend } from "./chatCacheBackend";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";

const line = (seq: number): ProjectGroupMessage => ({
  id: `l${seq}`,
  groupId: "g1",
  author: "appa",
  body: `pc${seq}`,
  createdAt: 1_760_000_000 + seq,
  seq,
});
/** Held lines `from..to` as the store keeps them (position seq, line readSeq). */
const held = (from: number, to: number): ThreadMessage[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: `l${from + i}`,
    seq: i,
    readSeq: from + i,
    text: `pc${from + i}`,
    from: "appa",
    at: 1_760_000_000 + from + i,
    mine: false,
    kind: "text",
    choice: null,
  }));
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const readSeqs = () => useZenStore.getState().thread.map((m) => m.readSeq);
const positions = () => useZenStore.getState().thread.map((m) => m.seq);

function openGroup(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    agentId: "group:g1",
    threadSource: "live",
    threadCached: false,
    threadError: null,
    threadAddr: null,
    threadGroupId: "g1",
    threadConversationId: null,
    threadHasMore: true,
    threadLoadingEarlier: false,
    thread: held(71, 120),
    threadOldestSeq: 0,
    outbox: [],
    ...over,
  });
}

function withKey(on: boolean) {
  setZenScope(
    fakeScope({ id: "s1", username: "me", features: on ? ["thread-delta-v1", "project-chat-paging-v1"] : ["thread-delta-v1"] })
  );
}

beforeEach(() => {
  setChatCacheForTests(createChatCache({ backend: () => memoryBackend() }));
  withKey(true);
  vi.mocked(fetchProjectGroupOlder).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("project chat loadEarlier (project-chat-paging-v1)", () => {
  it("without the key: skipped, nothing fetched, the chat unchanged", async () => {
    withKey(false);
    openGroup();
    const before = useZenStore.getState().thread;
    expect(await useZenStore.getState().loadEarlier()).toBe("skipped");
    expect(fetchProjectGroupOlder).not.toHaveBeenCalled();
    expect(getThread).not.toHaveBeenCalled();
    expect(useZenStore.getState().thread).toBe(before);
    expect(useZenStore.getState().threadLoadingEarlier).toBe(false);
  });

  it("with the key: before_seq = the lowest line seq held; the page lands in front, in order", async () => {
    openGroup();
    vi.mocked(fetchProjectGroupOlder).mockResolvedValueOnce({ ok: true, data: { messages: lines(21, 70), hasMore: true } });
    const p = useZenStore.getState().loadEarlier();
    expect(useZenStore.getState().threadLoadingEarlier).toBe(true);
    expect(await p).toBe("loaded");
    expect(fetchProjectGroupOlder).toHaveBeenCalledTimes(1);
    const [scope, groupId, beforeSeq, limit] = vi.mocked(fetchProjectGroupOlder).mock.calls[0];
    expect(scope.id).toBe("s1");
    expect(groupId).toBe("g1");
    expect(beforeSeq).toBe(71);
    expect(limit).toBe(50);
    expect(getThread).not.toHaveBeenCalled();
    const s = useZenStore.getState();
    expect(readSeqs()).toEqual(Array.from({ length: 100 }, (_, i) => 21 + i));
    expect(positions()).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(s.threadHasMore).toBe(true);
    expect(s.threadLoadingEarlier).toBe(false);
  });

  it("the next page goes from the new lowest seq; has_more false stops it", async () => {
    openGroup();
    vi.mocked(fetchProjectGroupOlder)
      .mockResolvedValueOnce({ ok: true, data: { messages: lines(21, 70), hasMore: true } })
      .mockResolvedValueOnce({ ok: true, data: { messages: lines(1, 20), hasMore: false } });
    expect(await useZenStore.getState().loadEarlier()).toBe("loaded");
    expect(await useZenStore.getState().loadEarlier()).toBe("loaded");
    expect(vi.mocked(fetchProjectGroupOlder).mock.calls[1][2]).toBe(21);
    expect(readSeqs()[0]).toBe(1);
    expect(useZenStore.getState().threadHasMore).toBe(false);
    expect(await useZenStore.getState().loadEarlier()).toBe("skipped");
    expect(fetchProjectGroupOlder).toHaveBeenCalledTimes(2);
  });

  it("a page with nothing new stops paging (no loop on a server that repeats itself)", async () => {
    openGroup({ thread: held(71, 120) });
    vi.mocked(fetchProjectGroupOlder).mockResolvedValueOnce({ ok: true, data: { messages: [], hasMore: true } });
    expect(await useZenStore.getState().loadEarlier()).toBe("loaded");
    expect(useZenStore.getState().threadHasMore).toBe(false);
  });

  it("a failure: 'failed', the chat as it was, nothing in flight", async () => {
    openGroup();
    const before = useZenStore.getState().thread;
    vi.mocked(fetchProjectGroupOlder).mockResolvedValueOnce({ ok: false, error: "HTTP 500", status: 500 });
    expect(await useZenStore.getState().loadEarlier()).toBe("failed");
    expect(useZenStore.getState().thread).toBe(before);
    expect(useZenStore.getState().threadHasMore).toBe(true);
    expect(useZenStore.getState().threadLoadingEarlier).toBe(false);
    vi.mocked(fetchProjectGroupOlder).mockRejectedValueOnce(new Error("boom"));
    expect(await useZenStore.getState().loadEarlier()).toBe("failed");
    expect(useZenStore.getState().threadLoadingEarlier).toBe(false);
  });

  it("one in flight at a time; none left; or the first line already held (seq 1): skipped", async () => {
    openGroup({ threadLoadingEarlier: true });
    expect(await useZenStore.getState().loadEarlier()).toBe("skipped");
    openGroup({ threadHasMore: false });
    expect(await useZenStore.getState().loadEarlier()).toBe("skipped");
    openGroup({ thread: held(1, 30) });
    expect(await useZenStore.getState().loadEarlier()).toBe("skipped");
    expect(useZenStore.getState().threadHasMore).toBe(false);
    expect(fetchProjectGroupOlder).not.toHaveBeenCalled();
  });

  it("another chat opened meanwhile: the page is dropped (skipped)", async () => {
    openGroup();
    let settle!: (v: unknown) => void;
    vi.mocked(fetchProjectGroupOlder).mockReturnValueOnce(new Promise((r) => (settle = r)) as never);
    const p = useZenStore.getState().loadEarlier();
    useZenStore.setState({ threadGen: useZenStore.getState().threadGen + 1, threadGroupId: "g2", thread: held(5, 6) });
    settle({ ok: true, data: { messages: lines(21, 70), hasMore: true } });
    expect(await p).toBe("skipped");
    expect(readSeqs()).toEqual([5, 6]);
    expect(useZenStore.getState().threadLoadingEarlier).toBe(false);
  });

  it("merges by id: a line already held is not doubled, and the merged chat is the cached copy", async () => {
    openGroup({ thread: held(71, 80) });
    vi.mocked(fetchProjectGroupOlder).mockResolvedValueOnce({
      ok: true,
      // A server that overlaps the cursor (seq 71 already held).
      data: { messages: lines(61, 71), hasMore: true },
    });
    expect(await useZenStore.getState().loadEarlier()).toBe("loaded");
    expect(readSeqs()).toEqual(Array.from({ length: 20 }, (_, i) => 61 + i));
    expect(new Set(useZenStore.getState().thread.map((m) => m.id)).size).toBe(20);
    const cached = chatCache().peek("s1|g:g1");
    expect(cached?.messages.map((m) => m.readSeq)).toEqual(Array.from({ length: 20 }, (_, i) => 61 + i));
    expect(cached?.hasMore).toBe(true);
  });

  it("a held line without a seq (cannot be placed): skipped, nothing fetched", async () => {
    openGroup({ thread: [...held(71, 72), { ...held(73, 73)[0], readSeq: undefined }] });
    expect(await useZenStore.getState().loadEarlier()).toBe("skipped");
    expect(fetchProjectGroupOlder).not.toHaveBeenCalled();
  });
});
