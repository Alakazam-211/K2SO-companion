import { getThread } from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import type { ServerScope } from "../api/scope";
import {
  DELTA_LIMIT,
  deltaSupported,
  fetchProjectGroupDelta,
  fetchThreadDelta,
  goneStatus,
} from "../api/threadDelta";
import { looksUnreachable } from "./multi/serverHealth";
import {
  mergeDelta,
  mergeGroupDelta,
  mergeGroupPage,
  mergeServerPage,
  newestSeq,
  removeIds,
} from "./threadCacheMerge";
import { groupMessagesToThread, normaliseThreadItem, type ThreadMessage } from "./threadModel";

// Revalidating a cached chat (open and prefetch share this), per the K2
// 0.46.1 delta contract:
//
//   key `thread-delta-v1` + a cached cursor (Thread: and its conversation id)
//     → `after_seq=<highest cached seq>&limit=50`
//       apply `removed` (delete), then `changed` (upsert by id), then append
//       `items`;
//       `has_more` (newer remain) → reload the newest page and merge it,
//       keeping only cached items <= the cursor (already brought up to date
//       by changed / removed) older than that page;
//       another `conversation_id` (Thread) → the conversation moved: drop
//       the copy, take the newest page;
//   otherwise → the newest page, merged ("the server wins in its window").
//   403 / 404 → the access or the chat is gone: the caller drops its cache.
//
// `fetch*` does the I/O and returns a `ChatRead`; `apply*` turns it into the
// new message list over whatever is on screen at that moment (so live
// frames that landed meanwhile are kept).

export const PAGE_LIMIT = 50;

export type ReadMode = "delta" | "delta+page" | "page" | "reset";

export type ReadCounts = { items: number; changed: number; removed: number };

export type ChatRead =
  | {
      ok: true;
      mode: ReadMode;
      /** Delta parts (empty for a page read). */
      removedIds: string[];
      changed: ThreadMessage[];
      items: ThreadMessage[];
      /** The delta's cursor (delta modes). */
      afterSeq: number | null;
      /** The newest page (page, reset and delta+page modes). */
      page: ThreadMessage[] | null;
      /** Older history exists on the server — null: unchanged (delta). */
      hasMore: boolean | null;
      conversationId: string | null;
      counts: ReadCounts;
      bytes: number | null;
    }
  | { ok: false; error: string; status?: number; gone: boolean };

export type ReadDeps = {
  getThread: typeof getThread;
  fetchThreadDelta: typeof fetchThreadDelta;
  fetchProjectGroupMessages: typeof fetchProjectGroupMessages;
  fetchProjectGroupDelta: typeof fetchProjectGroupDelta;
};

// Looked up at call time (a test may mock the module without them).
export const defaultReadDeps: ReadDeps = {
  getThread: (...a) => getThread(...a),
  fetchThreadDelta: (...a) => fetchThreadDelta(...a),
  fetchProjectGroupMessages: (...a) => fetchProjectGroupMessages(...a),
  fetchProjectGroupDelta: (...a) => fetchProjectGroupDelta(...a),
};

/** What the cache knows: its messages and conversation id. */
export type CacheBase = { messages: ThreadMessage[]; conversationId: string | null } | null;

function approx(data: unknown): number | null {
  try {
    return JSON.stringify(data).length;
  } catch {
    return null;
  }
}

function fail(error: string | undefined, status: number | undefined): ChatRead {
  const e = error || "read failed";
  return { ok: false, error: e, status, gone: goneStatus(status) };
}

/** Thread cursor: the highest cached seq, only with a conversation id. */
export function threadCursor(base: CacheBase): number | null {
  if (!base || !base.conversationId) return null;
  return newestSeq(base.messages);
}

/** Project cursor: the highest cached line seq (every line must carry one). */
export function groupCursor(base: CacheBase): number | null {
  if (!base || !base.messages.length || !base.messages.every((m) => typeof m.readSeq === "number")) return null;
  return newestSeq(base.messages, "readSeq");
}

export async function fetchThreadRead(
  scope: ServerScope,
  addr: string,
  base: CacheBase,
  deps: ReadDeps = defaultReadDeps
): Promise<ChatRead> {
  const username = scope.username();
  const norm = (raw: unknown[]) =>
    raw.map((it) => normaliseThreadItem(it as never, username)).filter((m): m is ThreadMessage => !!m);

  const pageRead = async (mode: "page" | "reset"): Promise<ChatRead> => {
    const r = await deps.getThread(scope, addr); // the newest PAGE_LIMIT (its default)
    if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
      const msg =
        typeof r.error === "string" && r.error ? r.error : r.error ? JSON.stringify(r.error) : "thread failed";
      return fail(msg, r.status);
    }
    const page = norm(r.data.items);
    return {
      ok: true,
      mode,
      removedIds: [],
      changed: [],
      items: [],
      afterSeq: null,
      page,
      hasMore: !!r.data.has_more,
      conversationId: (r.data.conversation_id || "").trim() || null,
      counts: { items: page.length, changed: 0, removed: 0 },
      bytes: approx(r.data),
    };
  };

  const cursor = threadCursor(base);
  if (cursor == null || !deltaSupported(scope)) return pageRead("page");
  const d = await deps.fetchThreadDelta(scope, addr, cursor, DELTA_LIMIT);
  if (!d.ok || !d.data) {
    if (goneStatus(d.status) || looksUnreachable(d.error)) return fail(d.error, d.status);
    return pageRead("page"); // a refused delta (usage) still has the page
  }
  const delta = d.data;
  if (delta.conversationId && base?.conversationId && delta.conversationId !== base.conversationId) {
    return pageRead("reset");
  }
  const changed = norm(delta.changed ?? []);
  const items = norm(delta.items ?? []);
  const removedIds = (delta.removed ?? []).map((r) => r.id);
  const counts = { items: items.length, changed: changed.length, removed: removedIds.length };
  const conversationId = delta.conversationId ?? base?.conversationId ?? null;
  if (!delta.hasMore) {
    return {
      ok: true,
      mode: "delta",
      removedIds,
      changed,
      items,
      afterSeq: cursor,
      page: null,
      hasMore: null,
      conversationId,
      counts,
      bytes: delta.bytes,
    };
  }
  // More new than one delta: the newest page, over the updated older items.
  const p = await pageRead("page");
  if (!p.ok) return p;
  return {
    ...p,
    mode: "delta+page",
    removedIds,
    changed,
    items,
    afterSeq: cursor,
    conversationId: p.conversationId ?? conversationId,
    counts: { items: items.length + p.counts.items, changed: changed.length, removed: removedIds.length },
    bytes: (delta.bytes ?? 0) + (p.bytes ?? 0),
  };
}

/** The new Thread over `current` (what is on screen now). */
export function applyThreadRead(
  current: ThreadMessage[],
  read: Extract<ChatRead, { ok: true }>,
  opts: { arrivedLive?: ReadonlySet<string>; conversationId?: string | null } = {}
): ThreadMessage[] {
  const { arrivedLive } = opts;
  if (read.mode === "reset") {
    return mergeServerPage(current, read.page ?? [], { hasMore: !!read.hasMore, sameConversation: false });
  }
  if (read.mode === "page") {
    return mergeServerPage(current, read.page ?? [], {
      hasMore: !!read.hasMore,
      sameConversation: !opts.conversationId || !read.conversationId || opts.conversationId === read.conversationId,
      arrivedLive,
    });
  }
  // removed, then changed, then the new items.
  let t = removeIds(current, read.removedIds);
  t = mergeDelta(t, read.changed);
  t = mergeDelta(t, read.items);
  if (read.mode === "delta") return t;
  // delta+page: drop the gap — keep cached items <= the cursor (updated
  // above), live frames, and the newest page.
  const cut = read.afterSeq ?? -Infinity;
  const base = t.filter(
    (m) => m.pending || m.failed || m.seq == null || m.seq <= cut || !!arrivedLive?.has(m.id)
  );
  return mergeServerPage(base, read.page ?? [], { hasMore: !!read.hasMore, arrivedLive });
}

export async function fetchGroupRead(
  scope: ServerScope,
  groupId: string,
  base: CacheBase,
  deps: ReadDeps = defaultReadDeps
): Promise<ChatRead> {
  const username = scope.username();
  const pageRead = async (): Promise<ChatRead> => {
    const r = await deps.fetchProjectGroupMessages(scope, groupId, { limit: PAGE_LIMIT });
    if (!r.ok) return fail(r.error || "project chat failed", r.status);
    const page = groupMessagesToThread(r.data?.messages ?? [], username);
    return {
      ok: true,
      mode: "page",
      removedIds: [],
      changed: [],
      items: [],
      afterSeq: null,
      page,
      hasMore: !!r.data?.truncated,
      conversationId: null,
      counts: { items: page.length, changed: 0, removed: 0 },
      bytes: approx(r.data),
    };
  };
  const cursor = groupCursor(base);
  if (cursor == null || !deltaSupported(scope)) return pageRead();
  const d = await deps.fetchProjectGroupDelta(scope, groupId, cursor, DELTA_LIMIT);
  if (!d.ok || !d.data) {
    if (goneStatus(d.status) || looksUnreachable(d.error)) return fail(d.error, d.status);
    return pageRead();
  }
  const items = groupMessagesToThread(d.data.items ?? [], username);
  const changed = groupMessagesToThread(d.data.changed ?? [], username);
  const removedIds = (d.data.removed ?? []).map((r) => r.id);
  const counts = { items: items.length, changed: changed.length, removed: removedIds.length };
  if (!d.data.hasMore) {
    return {
      ok: true,
      mode: "delta",
      removedIds,
      changed,
      items,
      afterSeq: cursor,
      page: null,
      hasMore: null,
      conversationId: null,
      counts,
      bytes: d.data.bytes,
    };
  }
  const p = await pageRead();
  if (!p.ok) return p;
  return {
    ...p,
    mode: "delta+page",
    removedIds,
    changed,
    items,
    afterSeq: cursor,
    counts: { items: items.length + p.counts.items, changed: changed.length, removed: removedIds.length },
    bytes: (d.data.bytes ?? 0) + (p.bytes ?? 0),
  };
}

/** The new project chat over `current`. */
export function applyGroupRead(current: ThreadMessage[], read: Extract<ChatRead, { ok: true }>): ThreadMessage[] {
  if (read.mode === "page" || read.mode === "reset") {
    // The non-delta path: the newest page replaces the copy (as before).
    return mergeGroupPage(current, read.page ?? [], { hasMore: false });
  }
  let t = removeIds(current, read.removedIds);
  t = mergeGroupDelta(t, read.changed);
  t = mergeGroupDelta(t, read.items);
  if (read.mode === "delta") return t;
  const cut = read.afterSeq ?? -Infinity;
  const base = t.filter((m) => typeof m.readSeq === "number" && m.readSeq <= cut);
  return mergeGroupPage(base, read.page ?? [], { hasMore: !!read.hasMore });
}
