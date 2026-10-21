import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);

import type { ThreadItem } from "../api/client";
import {
  catchupBody,
  parseThreadEntry,
  postCatchup,
  type CatchupResult,
  type CatchupThreadEntry,
} from "../api/threadCatchup";
import { fakeScope } from "../test/fakeScope";
import { createChatCache, type ChatCache } from "./chatCache";
import { memoryBackend } from "./chatCacheBackend";
import { catchUpServer, resetCatchupMarksForTests, type CatchupMark } from "./chatCatchup";
import {
  FOREGROUND_CATCHUP_GAP_MS,
  catchUpCached,
  createPrefetcher,
  targetOfKey,
  type PrefetchDeps,
  type PrefetchTarget,
} from "./chatPrefetch";
import type { ThreadMessage } from "./threadModel";

const t = (addr: string): PrefetchTarget => ({ serverId: "s1", ref: { kind: "thread", addr } });
const g = (groupId: string): PrefetchTarget => ({ serverId: "s1", ref: { kind: "project", groupId } });

function item(seq: number): ThreadItem {
  return { id: `m${seq}`, seq, doc: { from: "agent", body: `m${seq}`, created_at: seq } } as ThreadItem;
}
function msg(seq: number): ThreadMessage {
  return { id: `m${seq}`, seq, text: `m${seq}`, from: "agent", at: seq, mine: false, kind: "text", choice: null };
}
const ok = (data: Partial<Extract<CatchupResult, { ok: true }>["data"]>): CatchupResult => ({
  ok: true,
  data: { since: null, unchanged: false, hasMore: false, threads: [], groups: [], ...data },
});
const served = (over: Record<string, unknown> = {}): CatchupThreadEntry =>
  ({
    kind: "served",
    addr: "sales",
    movedFrom: null,
    conversationId: "c-1",
    afterSeq: 2,
    items: [],
    changed: [],
    removed: [],
    hasMore: false,
    resync: false,
    ...over,
  }) as CatchupThreadEntry;

let cache: ChatCache;
const scope = fakeScope({ id: "s1", features: ["inbox-catchup-v1", "thread-delta-v1"] });

function seed(addr: string, seqs: number[], conversationId = "c-1") {
  cache.remember({
    key: `s1|t:${addr}`,
    serverId: "s1",
    messages: seqs.map(msg),
    conversationId,
    hasMore: false,
  });
}

beforeEach(() => {
  cache = createChatCache({ backend: () => memoryBackend() });
  resetCatchupMarksForTests();
});

describe("threadCatchup wire", () => {
  it("catchupBody: one ask per addr (first wins), caps, bad afterSeq dropped", () => {
    const b = catchupBody(
      [
        { addr: "a", afterSeq: 3 },
        { addr: "a", newest: true },
        { addr: "b", newest: true },
        { addr: "c", afterSeq: -1 },
      ],
      [{ group: "Launch", afterSeq: 4 }]
    );
    expect(b).toEqual({
      threads: [
        { addr: "a", afterSeq: 3 },
        { addr: "b", newest: true },
      ],
      groups: [{ group: "Launch", afterSeq: 4 }],
      limit: 50,
    });
  });

  it("entries: served, error (status + code), deferred, and missing = deferred", () => {
    const sent = { addr: "sales", afterSeq: 41 };
    expect(parseThreadEntry({ addr: "sales", conversation_id: "c-1", after_seq: 41, items: [item(42)], has_more: false }, sent)).toMatchObject({
      kind: "served",
      conversationId: "c-1",
      afterSeq: 41,
      hasMore: false,
    });
    expect(parseThreadEntry({ addr: "ops/x", status: 403, error: { code: "skin_room", hint: "h" } }, sent)).toEqual({
      kind: "error",
      addr: "sales",
      error: { status: 403, code: "skin_room", hint: "h" },
    });
    expect(parseThreadEntry({ addr: "c-90", deferred: true }, sent)).toEqual({ kind: "deferred", addr: "sales" });
    expect(parseThreadEntry(undefined, sent)).toEqual({ kind: "deferred", addr: "sales" });
  });

  it("postCatchup: POST body, 429 waits retryAfterMs and retries, entries matched by position", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, ok: false, text: JSON.stringify({ error: "rate_limited", retryAfterMs: 1000 }) })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: JSON.stringify({ ok: true, has_more: false, threads: [{ addr: "a", conversation_id: "c", items: [], has_more: false }] }),
      });
    const sleep = vi.fn(async () => {});
    const r = await postCatchup(scope, catchupBody([{ addr: "a", afterSeq: 1 }], []), { fetch: fetch as never, sleep });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1]).toBe("/cli/thread/catchup");
    expect(JSON.parse(fetch.mock.calls[0][2].body)).toEqual({ threads: [{ addr: "a", afterSeq: 1 }], limit: 50 });
    expect(r.ok && r.data.threads[0].kind).toBe("served");
  });
});

describe("catchUpServer", () => {
  const deps = (post: ReturnType<typeof vi.fn>, open: string | null = null) => ({
    cache: () => cache,
    post: post as never,
    openKey: () => open,
    usable: () => true,
  });

  it("cached chats ask afterSeq, uncached ask newest; answers land in the cache in one call", async () => {
    seed("sales", [1, 2]);
    const post = vi.fn(async (_s, body) => {
      expect(body.threads).toEqual([
        { addr: "sales", afterSeq: 2 },
        { addr: "ops", newest: true },
      ]);
      return ok({
        threads: [
          served({ items: [item(3)], removed: [{ id: "m1" }] }),
          served({ addr: "ops", conversationId: "c-9", afterSeq: null, items: [item(7), item(8)], hasMore: true }),
        ],
      });
    });
    const left = await catchUpServer(scope, [t("sales"), t("ops")], deps(post));
    expect(left).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await cache.read("s1|t:sales"))?.entry.messages.map((m) => m.seq)).toEqual([2, 3]);
    const ops = (await cache.read("s1|t:ops"))?.entry;
    expect(ops?.messages.map((m) => m.seq)).toEqual([7, 8]);
    expect(ops?.conversationId).toBe("c-9");
    expect(ops?.hasMore).toBe(true);
  });

  it("deferred asks again; a delta with more pages on from its last seq", async () => {
    seed("a", [1]);
    seed("b", [5]);
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        ok({ hasMore: true, threads: [served({ addr: "a", items: [item(2)], hasMore: true }), { kind: "deferred", addr: "b" }] })
      )
      .mockResolvedValueOnce(ok({ threads: [served({ addr: "a", items: [item(3)] }), served({ addr: "b", items: [item(6)] })] }));
    await catchUpServer(scope, [t("a"), t("b")], deps(post));
    expect(post.mock.calls[1][1].threads).toEqual([
      { addr: "a", afterSeq: 2 },
      { addr: "b", afterSeq: 5 },
    ]);
    expect((await cache.read("s1|t:a"))?.entry.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect((await cache.read("s1|t:b"))?.entry.messages.map((m) => m.seq)).toEqual([5, 6]);
  });

  it("a 403/404 entry forgets that chat; a moved conversation, a rename or resync falls back to the per-chat read", async () => {
    seed("gone", [1]);
    seed("moved", [1]);
    seed("renamed", [1]);
    const post = vi.fn(async () =>
      ok({
        threads: [
          { kind: "error", addr: "gone", error: { status: 404, code: "not_found", hint: "" } },
          served({ addr: "moved", conversationId: "c-OTHER", items: [item(9)] }),
          served({ addr: "renamed-now", movedFrom: "renamed", items: [item(2)] }),
        ],
      })
    );
    const left = await catchUpServer(scope, [t("gone"), t("moved"), t("renamed")], deps(post));
    expect(left.map((x) => (x.ref.kind === "thread" ? x.ref.addr : ""))).toEqual(["moved", "renamed"]);
    expect(await cache.read("s1|t:gone")).toBeNull();
    expect((await cache.read("s1|t:moved"))?.entry.messages.map((m) => m.seq)).toEqual([1]);
  });

  it("an uncached project chat and a failed call go to the per-chat read; the open chat is never asked", async () => {
    seed("open", [1]);
    const post = vi.fn(
      async (_s: unknown, _b: { threads: unknown[] }) => ({ ok: false, error: { status: 500, code: "http_500", hint: "" } }) as CatchupResult
    );
    const left = await catchUpServer(scope, [g("grp"), t("open"), t("x")], deps(post, "s1|t:open"));
    expect(post.mock.calls[0][1].threads).toEqual([{ addr: "x", newest: true }]);
    expect(left).toEqual([g("grp"), t("x")]);
  });
});

describe("catchup-unchanged-v1", () => {
  const scopeU = fakeScope({ id: "s1", features: ["inbox-catchup-v1", "thread-delta-v1", "catchup-unchanged-v1"] });
  let marks: Map<string, CatchupMark>;
  const deps = (post: ReturnType<typeof vi.fn>) => ({
    cache: () => cache,
    post: post as never,
    openKey: () => null,
    usable: () => true,
    marks,
  });
  const at = (rev: number, instanceId = "i-1") => ({ rev, instanceId });
  const unchanged = (rev: number): CatchupResult => ({
    ok: true,
    data: { since: at(rev), unchanged: true, hasMore: false, threads: [], groups: [] },
  });
  beforeEach(() => {
    marks = new Map();
  });

  it("wire: sinceRev + instanceId go together; the unchanged answer and a full answer's position parse", async () => {
    expect(catchupBody([{ addr: "a", afterSeq: 1 }], [], 50, at(7))).toEqual({
      threads: [{ addr: "a", afterSeq: 1 }],
      groups: [],
      limit: 50,
      since: at(7),
    });
    expect(catchupBody([{ addr: "a", afterSeq: 1 }], [], 50, { rev: -1, instanceId: "i" })).not.toHaveProperty("since");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, ok: true, text: JSON.stringify({ ok: true, rev: 7, instanceId: "i-1", unchanged: true }) })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: JSON.stringify({ ok: true, rev: 9, instanceId: "i-1", has_more: false, threads: [{ addr: "a", items: [] }] }),
      });
    const r1 = await postCatchup(scopeU, catchupBody([{ addr: "a", afterSeq: 1 }], [], 50, at(7)), { fetch: fetch as never });
    expect(JSON.parse(fetch.mock.calls[0][2].body)).toEqual({ threads: [{ addr: "a", afterSeq: 1 }], limit: 50, sinceRev: 7, instanceId: "i-1" });
    expect(r1).toEqual(unchanged(7));
    const r2 = await postCatchup(scopeU, catchupBody([{ addr: "a", afterSeq: 1 }], []), { fetch: fetch as never });
    expect(JSON.parse(fetch.mock.calls[1][2].body)).not.toHaveProperty("sinceRev");
    expect(r2.ok && r2.data.since).toEqual(at(9));
    expect(r2.ok && r2.data.unchanged).toBe(false);
  });

  it("a clean full answer marks its Threads; the next run asks sinceRev and `unchanged` settles them with no reads", async () => {
    seed("a", [1]);
    seed("b", [4]);
    const post = vi
      .fn()
      .mockResolvedValueOnce(ok({ since: at(7), threads: [served({ addr: "a", items: [item(2)] }), served({ addr: "b" })] }))
      .mockResolvedValueOnce(unchanged(7));
    expect(await catchUpServer(scopeU, [t("a"), t("b")], deps(post))).toEqual([]);
    expect(post.mock.calls[0][1]).not.toHaveProperty("since");
    expect([...(marks.get("s1")?.keys ?? [])]).toEqual(["s1|t:a", "s1|t:b"]);

    const write = vi.spyOn(cache, "remember");
    expect(await catchUpServer(scopeU, [t("a"), t("b")], deps(post))).toEqual([]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({ threads: [{ addr: "a", afterSeq: 2 }, { addr: "b", afterSeq: 4 }], groups: [], since: at(7) });
    expect(write).not.toHaveBeenCalled();
    expect(marks.get("s1")?.rev).toBe(7);
  });

  it("something changed: the short-cut call's full answer lands and the mark moves", async () => {
    seed("a", [1]);
    marks.set("s1", { ...at(7), keys: new Set(["s1|t:a"]) });
    const post = vi.fn().mockResolvedValueOnce(ok({ since: at(8), threads: [served({ addr: "a", items: [item(2)] })] }));
    await catchUpServer(scopeU, [t("a")], deps(post));
    expect(post).toHaveBeenCalledTimes(1);
    expect((await cache.read("s1|t:a"))?.entry.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(marks.get("s1")).toEqual({ ...at(8), keys: new Set(["s1|t:a"]) });
  });

  it("project chats don't move rev: Threads take the short-cut, the group still gets a normal call", async () => {
    seed("a", [1]);
    cache.remember({ key: "s1|g:grp", serverId: "s1", messages: [{ ...msg(3), readSeq: 3 }], conversationId: null, hasMore: false });
    marks.set("s1", { ...at(7), keys: new Set(["s1|t:a"]) });
    const post = vi
      .fn()
      .mockResolvedValueOnce(unchanged(7))
      .mockResolvedValueOnce(ok({ since: at(7), groups: [{ kind: "served", group: "grp", groupId: "grp", messages: [], changed: [], removed: [], hasMore: false }] }));
    await catchUpServer(scopeU, [t("a"), g("grp")], deps(post));
    expect(post.mock.calls[0][1]).toMatchObject({ threads: [{ addr: "a", afterSeq: 1 }], groups: [], since: at(7) });
    expect(post.mock.calls[1][1]).toEqual({ threads: [], groups: [{ group: "grp", afterSeq: 3 }], limit: 50 });
    expect([...(marks.get("s1")?.keys ?? [])]).toEqual(["s1|t:a"]);
  });

  it("no short-cut for a Thread outside the mark, an uncached one, or without the feature; failed entries leave the mark", async () => {
    seed("a", [1]);
    seed("new", [1]);
    marks.set("s1", { ...at(7), keys: new Set(["s1|t:a", "s1|t:b"]) });
    const post = vi.fn(async (_s: unknown, _b: Record<string, unknown>) =>
      ok({
        since: at(7),
        threads: [served({ addr: "a" }), { kind: "error", addr: "new", error: { status: 500, code: "x", hint: "" } }],
      })
    );
    await catchUpServer(scopeU, [t("a"), t("new")], deps(post));
    expect(post.mock.calls[0][1]).not.toHaveProperty("since");
    // Same position: the old mark's untouched Threads stay; the failed one is out.
    expect(marks.get("s1")?.keys).toEqual(new Set(["s1|t:a", "s1|t:b"]));

    post.mockClear();
    await catchUpServer(scopeU, [t("b")], deps(post)); // marked, but no cached copy
    expect(post.mock.calls[0][1]).not.toHaveProperty("since");

    post.mockClear();
    await catchUpServer(scope, [t("a")], deps(post)); // no catchup-unchanged-v1
    expect(post.mock.calls[0][1]).not.toHaveProperty("since");
  });

  it("an answer without a position (older daemon) or from another daemon process clears the mark", async () => {
    seed("a", [1]);
    marks.set("s1", { ...at(7), keys: new Set(["s1|t:a"]) });
    const post = vi.fn().mockResolvedValueOnce(ok({ since: at(3, "i-2"), threads: [served({ addr: "a" })] }));
    await catchUpServer(scopeU, [t("a")], deps(post));
    expect(marks.get("s1")).toEqual({ ...at(3, "i-2"), keys: new Set(["s1|t:a"]) });
    post.mockResolvedValueOnce(ok({ threads: [served({ addr: "a" })] }));
    await catchUpServer(scopeU, [t("a")], deps(post));
    expect(marks.has("s1")).toBe(false);
  });
});

describe("prefetcher batching", () => {
  it("a catch-up server's targets go out as one batch; the rest per chat", async () => {
    const run = vi.fn(async (_id: string, targets: PrefetchTarget[]) => targets.filter((x) => x.ref.kind === "project"));
    const getThread = vi.fn(async () => ({ ok: true, data: { conversation_id: "c", items: [item(1)] } }));
    const p = createPrefetcher({
      now: () => 1,
      scopeOf: () => scope,
      isDown: () => false,
      foreground: () => true,
      openKey: () => null,
      cache: () => cache,
      getThread: getThread as never,
      fetchThreadDelta: vi.fn() as never,
      fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })) as never,
      fetchProjectGroupDelta: vi.fn() as never,
      catchup: { supported: () => true, run },
    } satisfies PrefetchDeps);
    p.request([t("a"), t("b"), g("grp")]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toHaveLength(3);
    expect(getThread).not.toHaveBeenCalled();
  });
});

describe("foreground catch-up", () => {
  it("targetOfKey parses cache keys", () => {
    expect(targetOfKey("s1|t:sales/x")).toEqual({ serverId: "s1", ref: { kind: "thread", addr: "sales/x" } });
    expect(targetOfKey("s1|g:grp")).toEqual({ serverId: "s1", ref: { kind: "project", groupId: "grp" } });
    expect(targetOfKey("junk")).toBeNull();
  });

  it("every cached chat of a catch-up server, forced, at most once per gap", async () => {
    seed("a", [1]);
    seed("b", [1]);
    const request = vi.fn();
    let now = 0;
    const last = new Map<string, number>();
    const d = {
      prefetcher: () => ({ request, stop: vi.fn(), inFlight: () => 0, queued: () => 0 }),
      cache: () => cache,
      servers: () => ["s1", "s2"],
      supported: (id: string) => id === "s1",
      now: () => now,
    };
    await catchUpCached(["s1", "s2"], last, d);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ force: true });
    expect((request.mock.calls[0][0] as PrefetchTarget[]).map((x) => (x.ref.kind === "thread" ? x.ref.addr : "")).sort()).toEqual(["a", "b"]);
    now = FOREGROUND_CATCHUP_GAP_MS - 1;
    await catchUpCached(["s1"], last, d);
    expect(request).toHaveBeenCalledTimes(1);
    now = FOREGROUND_CATCHUP_GAP_MS;
    await catchUpCached(["s1"], last, d);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
