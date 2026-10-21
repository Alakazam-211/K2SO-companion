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
import { catchUpServer } from "./chatCatchup";
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
  data: { hasMore: false, threads: [], groups: [], ...data },
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
