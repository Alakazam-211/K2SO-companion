import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);

import type { ThreadItem } from "../api/client";
import { fakeScope, type FakeScope } from "../test/fakeScope";
import { createChatCache, type ChatCache } from "./chatCache";
import { memoryBackend } from "./chatCacheBackend";
import {
  PREFETCH_TOP,
  createPrefetcher,
  prefetchTargets,
  type PrefetchDeps,
  type PrefetchTarget,
} from "./chatPrefetch";
import type { ThreadMessage } from "./threadModel";

const t = (serverId: string, addr: string): PrefetchTarget => ({ serverId, ref: { kind: "thread", addr } });
const g = (serverId: string, groupId: string): PrefetchTarget => ({ serverId, ref: { kind: "project", groupId } });

function item(seq: number, body = `m${seq}`): ThreadItem {
  return { id: `m${seq}`, seq, doc: { from: "agent", body, created_at: seq } } as ThreadItem;
}
function msg(seq: number): ThreadMessage {
  return { id: `m${seq}`, seq, text: `m${seq}`, from: "agent", at: seq, mine: false, kind: "text", choice: null };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

let now = 0;
let fg = true;
let down = new Set<string>();
let open: string | null = null;
let cache: ChatCache;
let scopes: Record<string, FakeScope>;
let deps: PrefetchDeps;
let pendingReads: (() => void)[];

function page(items: ThreadItem[], extra: Record<string, unknown> = {}) {
  return { ok: true, data: { conversation_id: "c", items, ...extra } };
}

beforeEach(() => {
  now = 1_000_000;
  fg = true;
  down = new Set();
  open = null;
  pendingReads = [];
  cache = createChatCache({ backend: () => memoryBackend() });
  scopes = {
    s1: fakeScope({ id: "s1" }),
    s2: fakeScope({ id: "s2", features: ["thread-delta-v1"] }),
  };
  deps = {
    now: () => now,
    scopeOf: (id) => scopes[id] ?? null,
    isDown: (id) => down.has(id),
    foreground: () => fg,
    openKey: () => open,
    cache: () => cache,
    getThread: vi.fn(async () => page([item(1), item(2)])) as never,
    fetchThreadDelta: vi.fn(async () => ({ ok: true, data: { items: [item(3)], changed: [], removed: [], hasMore: false, conversationId: "c", bytes: 10 } })) as never,
    fetchProjectGroupMessages: vi.fn(async () => ({
      ok: true,
      data: { messages: [{ id: "g1", groupId: "grp", author: "a", body: "x", createdAt: 1, seq: 7 }], truncated: false },
    })) as never,
    fetchProjectGroupDelta: vi.fn(async () => ({
      ok: true,
      data: { items: [{ id: "g2", groupId: "grp", author: "a", body: "y", createdAt: 2, seq: 8 }], changed: [], removed: [], hasMore: false, conversationId: null, bytes: 1 },
    })) as never,
  };
});

describe("prefetchTargets", () => {
  it("top Home rows, then other rows only when unread, each chat once", () => {
    const home = Array.from({ length: 12 }, (_, i) => t("s1", `h${i}`));
    const others = [t("s1", "h0"), t("s1", "x"), t("s1", "y"), g("s1", "grp")];
    const unread = new Set(["h10", "y", "grp"]);
    const out = prefetchTargets(home, others, (x) =>
      unread.has(x.ref.kind === "project" ? x.ref.groupId : x.ref.addr || "")
    );
    const names = out.map((x) => (x.ref.kind === "project" ? `g:${x.ref.groupId}` : x.ref.addr));
    expect(names.slice(0, PREFETCH_TOP)).toEqual(home.slice(0, PREFETCH_TOP).map((x) => (x.ref.kind === "thread" ? x.ref.addr : "")));
    expect(names.slice(PREFETCH_TOP)).toEqual(["h10", "y", "g:grp"]);
  });
});

describe("prefetcher", () => {
  it("warms the cache on the row's own server", async () => {
    const p = createPrefetcher(deps);
    p.request([t("s1", "a")]);
    await settle();
    expect(vi.mocked(deps.getThread).mock.calls[0][0]).toBe(scopes.s1);
    expect(cache.peek("s1|t:a")?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("runs at most two reads at a time", async () => {
    let active = 0;
    let peak = 0;
    deps.getThread = vi.fn(
      () =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          pendingReads.push(() => {
            active -= 1;
            resolve(page([item(1)]) as never);
          });
        })
    ) as never;
    const p = createPrefetcher(deps);
    p.request([t("s1", "a"), t("s1", "b"), t("s1", "c"), t("s1", "d")]);
    await settle();
    expect(p.inFlight()).toBe(2);
    expect(p.queued()).toBe(2);
    while (pendingReads.length) {
      pendingReads.shift()?.();
      await settle();
    }
    expect(peak).toBe(2);
    expect(deps.getThread).toHaveBeenCalledTimes(4);
  });

  it("at most once per chat per two minutes", async () => {
    const p = createPrefetcher(deps);
    p.request([t("s1", "a")]);
    await settle();
    p.request([t("s1", "a")]);
    await settle();
    expect(deps.getThread).toHaveBeenCalledTimes(1);
    now += 121_000;
    p.request([t("s1", "a")]);
    await settle();
    expect(deps.getThread).toHaveBeenCalledTimes(2);
  });

  it("skips servers that are down, signed out, and the chat that is open", async () => {
    down.add("s1");
    scopes.s2.setToken("");
    scopes.s3 = fakeScope({ id: "s3" });
    open = "s3|t:open";
    const p = createPrefetcher(deps);
    p.request([t("s1", "a"), t("s2", "b"), t("s3", "open"), t("s3", "c")]);
    await settle();
    expect(vi.mocked(deps.getThread).mock.calls.map((c) => c[1])).toEqual(["c"]);
  });

  it("stops when the app goes to the background", async () => {
    deps.getThread = vi.fn(
      () => new Promise((resolve) => pendingReads.push(() => resolve(page([item(1)]) as never)))
    ) as never;
    const p = createPrefetcher(deps);
    p.request([t("s1", "a"), t("s1", "b"), t("s1", "c")]);
    await settle();
    fg = false;
    p.stop();
    expect(p.queued()).toBe(0);
    pendingReads.forEach((f) => f());
    await settle();
    p.request([t("s1", "d")]);
    await settle();
    expect(deps.getThread).toHaveBeenCalledTimes(2);
  });

  it("uses a delta read when the server lists the key and the cache has a cursor", async () => {
    cache.remember({ key: "s2|t:a", serverId: "s2", messages: [msg(1), msg(2)], conversationId: "c", hasMore: false });
    const p = createPrefetcher(deps);
    p.request([t("s2", "a")]);
    await settle();
    expect(deps.fetchThreadDelta).toHaveBeenCalledWith(scopes.s2, "a", 2, expect.any(Number));
    expect(deps.getThread).not.toHaveBeenCalled();
    expect(cache.peek("s2|t:a")?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("without the key: the normal newest-page read", async () => {
    cache.remember({ key: "s1|t:a", serverId: "s1", messages: [msg(1)], conversationId: "c", hasMore: false });
    const p = createPrefetcher(deps);
    p.request([t("s1", "a")]);
    await settle();
    expect(deps.fetchThreadDelta).not.toHaveBeenCalled();
    expect(deps.getThread).toHaveBeenCalledTimes(1);
  });

  it("deltas page forward; past four pages the newest page replaces the cached copy", async () => {
    cache.remember({ key: "s2|t:a", serverId: "s2", messages: [msg(1)], conversationId: "c", hasMore: false });
    deps.fetchThreadDelta = vi.fn(async (_s: unknown, _a: string, after: number) => ({
      ok: true,
      data: { items: [item(after + 1)], changed: [], removed: [], hasMore: true, conversationId: "c", bytes: 1 },
    })) as never;
    deps.getThread = vi.fn(async () => page([item(60), item(61)], { has_more: true })) as never;
    const p = createPrefetcher(deps);
    p.request([t("s2", "a")]);
    await new Promise((r) => setTimeout(r, 5));
    expect(deps.fetchThreadDelta).toHaveBeenCalledTimes(4);
    expect(deps.getThread).toHaveBeenCalledTimes(1);
    const e = cache.peek("s2|t:a");
    expect(e?.messages.map((m) => m.id)).toEqual(["m60", "m61"]);
    expect(e?.hasMore).toBe(true);
  });

  it("a 404 drops the prefetched chat's cache", async () => {
    cache.remember({ key: "s2|t:a", serverId: "s2", messages: [msg(1)], conversationId: "c", hasMore: false });
    deps.fetchThreadDelta = vi.fn(async () => ({ ok: false, status: 404, error: "gone" })) as never;
    const p = createPrefetcher(deps);
    p.request([t("s2", "a")]);
    await settle();
    expect(cache.peek("s2|t:a")).toBeNull();
  });

  it("project chats: full page, then deltas by the line's own seq", async () => {
    const p = createPrefetcher(deps);
    p.request([g("s2", "grp")]);
    await settle();
    expect(cache.peek("s2|g:grp")?.messages.map((m) => m.id)).toEqual(["g1"]);
    now += 200_000;
    p.request([g("s2", "grp")]);
    await settle();
    expect(deps.fetchProjectGroupDelta).toHaveBeenCalledWith(scopes.s2, "grp", 7, expect.any(Number));
    expect(cache.peek("s2|g:grp")?.messages.map((m) => m.id)).toEqual(["g1", "g2"]);
  });

  it("a chat opened while its prefetch ran is left to its own read", async () => {
    deps.getThread = vi.fn(
      () => new Promise((resolve) => pendingReads.push(() => resolve(page([item(1)]) as never)))
    ) as never;
    const p = createPrefetcher(deps);
    p.request([t("s1", "a")]);
    await settle();
    open = "s1|t:a";
    pendingReads.shift()?.();
    await settle();
    expect(cache.peek("s1|t:a")).toBeNull();
  });
});
