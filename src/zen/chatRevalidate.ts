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

// Revalidating a chat (open, foreground re-read and prefetch share this),
// per the K2 0.46.1 delta contract:
//
//   key `thread-delta-v1` + a cursor (Thread: and its conversation id)
//     → `after_seq=<highest seq held>&limit=50`, paged forward from the
//       last item's seq while `has_more` (newer remain), up to
//       `DELTA_MAX_PAGES` pages; each page's `removed` (delete), `changed`
//       (upsert by id), then `items` are applied in order (changed /
//       removed are complete on every page; re-applying is idempotent);
//       still more after that → the newest page REPLACES the copy (the
//       older block is dropped, so there is never an invisible hole: Load
//       earlier pages back from the newest page as usual);
//       another `conversation_id` (Thread) → the conversation moved: drop
//       the copy, take the newest page;
//   otherwise → the newest page, merged ("the server wins in its window").
//   403 / 404 → the access or the chat is gone: the caller drops its cache.
//
// `fetch*` does the I/O and returns a `ChatRead`; `apply*` turns it into the
// new message list over whatever is on screen at that moment (so live
// frames that landed meanwhile are kept).

export const PAGE_LIMIT = 50;
/** Delta pages read forward before giving up on the gap (200 new items). */
export const DELTA_MAX_PAGES = 4;

/** delta: the deltas closed the gap. page: the newest page merged.
 *  replace: more new than `DELTA_MAX_PAGES` deltas — the newest page
 *  replaces the copy. reset: the conversation moved. */
export type ReadMode = "delta" | "replace" | "page" | "reset";

export type ReadCounts = { items: number; changed: number; removed: number; pages: number };

/** One delta page, applied in this order. */
export type DeltaStep = { removedIds: string[]; changed: ThreadMessage[]; items: ThreadMessage[] };

export type ChatRead =
  | {
      ok: true;
      mode: ReadMode;
      /** Delta pages, oldest first ("delta" mode). */
      steps: DeltaStep[];
      /** The newest page (page, replace and reset modes). */
      page: ThreadMessage[] | null;
      /** Older history exists on the server — null: unchanged (delta). */
      hasMore: boolean | null;
      conversationId: string | null;
      counts: ReadCounts;
      bytes: number | null;
    }
  | { ok: false; error: string; status?: number; gone: boolean };

export type OkRead = Extract<ChatRead, { ok: true }>;

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

/** What the phone holds: its messages and conversation id. */
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

/** Thread cursor: the highest seq held, only with a conversation id. */
export function threadCursor(base: CacheBase): number | null {
  if (!base || !base.conversationId) return null;
  return newestSeq(base.messages);
}

/** Project cursor: the highest line seq held (every line must carry one). */
export function groupCursor(base: CacheBase): number | null {
  if (!base || !base.messages.length || !base.messages.every((m) => typeof m.readSeq === "number")) return null;
  return newestSeq(base.messages, "readSeq");
}

type RawDelta<T> = {
  items: T[];
  changed: T[];
  removed: { id: string }[];
  hasMore: boolean;
  conversationId: string | null;
  bytes: number | null;
};

/**
 * Page deltas forward from `cursor`. `null` = fall back to the newest page
 * (a refused delta); a failure that means gone / unreachable is returned.
 */
async function pageDeltas<T>(
  cursor: number,
  fetchPage: (after: number) => Promise<{ ok: boolean; data?: RawDelta<T>; error?: string; status?: number }>,
  toMessages: (raw: T[]) => ThreadMessage[],
  seqOf: (m: ThreadMessage) => number | null | undefined
): Promise<
  | { kind: "steps"; steps: DeltaStep[]; hasMore: boolean; conversationId: string | null; bytes: number }
  | { kind: "fallback" }
  | { kind: "fail"; read: ChatRead }
> {
  const steps: DeltaStep[] = [];
  let after = cursor;
  let bytes = 0;
  let conversationId: string | null = null;
  for (let i = 0; i < DELTA_MAX_PAGES; i++) {
    const d = await fetchPage(after);
    if (!d.ok || !d.data) {
      if (goneStatus(d.status) || looksUnreachable(d.error)) return { kind: "fail", read: fail(d.error, d.status) };
      return { kind: "fallback" };
    }
    const items = toMessages(d.data.items ?? []);
    steps.push({
      removedIds: (d.data.removed ?? []).map((r) => r.id),
      changed: toMessages(d.data.changed ?? []),
      items,
    });
    bytes += d.data.bytes ?? 0;
    conversationId = d.data.conversationId ?? conversationId;
    const last = items.length ? seqOf(items[items.length - 1]) : null;
    if (!d.data.hasMore) return { kind: "steps", steps, hasMore: false, conversationId, bytes };
    if (typeof last !== "number" || last <= after) break; // no progress: stop paging
    after = last;
  }
  return { kind: "steps", steps, hasMore: true, conversationId, bytes };
}

function countSteps(steps: DeltaStep[]): ReadCounts {
  return {
    items: steps.reduce((n, s) => n + s.items.length, 0),
    changed: steps.reduce((n, s) => n + s.changed.length, 0),
    removed: steps.reduce((n, s) => n + s.removedIds.length, 0),
    pages: steps.length,
  };
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

  const pageRead = async (mode: "page" | "reset" | "replace", pages = 0): Promise<ChatRead> => {
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
      steps: [],
      page,
      hasMore: !!r.data.has_more,
      conversationId: (r.data.conversation_id || "").trim() || null,
      counts: { items: page.length, changed: 0, removed: 0, pages },
      bytes: approx(r.data),
    };
  };

  const cursor = threadCursor(base);
  if (cursor == null || !deltaSupported(scope)) return pageRead("page");
  const got = await pageDeltas(
    cursor,
    (after) => deps.fetchThreadDelta(scope, addr, after, DELTA_LIMIT),
    (raw) => norm(raw),
    (m) => m.seq
  );
  if (got.kind === "fail") return got.read;
  if (got.kind === "fallback") return pageRead("page");
  if (got.conversationId && base?.conversationId && got.conversationId !== base.conversationId) {
    return pageRead("reset", got.steps.length);
  }
  if (got.hasMore) return pageRead("replace", got.steps.length);
  return {
    ok: true,
    mode: "delta",
    steps: got.steps,
    page: null,
    hasMore: null,
    conversationId: got.conversationId ?? base?.conversationId ?? null,
    counts: countSteps(got.steps),
    bytes: got.bytes,
  };
}

/** Optimistic rows and live frames that landed while the read ran: what
 *  a replacing page keeps from the screen. */
function keepFromScreen(current: ThreadMessage[], arrivedLive?: ReadonlySet<string>): ThreadMessage[] {
  return current.filter((m) => m.pending || m.failed || !!arrivedLive?.has(m.id));
}

/** The new Thread over `current` (what is on screen now). */
export function applyThreadRead(
  current: ThreadMessage[],
  read: OkRead,
  opts: { arrivedLive?: ReadonlySet<string>; conversationId?: string | null } = {}
): ThreadMessage[] {
  const { arrivedLive } = opts;
  if (read.mode === "reset") {
    return mergeServerPage(current, read.page ?? [], { hasMore: !!read.hasMore, sameConversation: false });
  }
  if (read.mode === "replace") {
    // Too much new to page through: the newest page alone (no hole).
    return mergeServerPage(keepFromScreen(current, arrivedLive), read.page ?? [], {
      hasMore: !!read.hasMore,
      arrivedLive,
    });
  }
  if (read.mode === "page") {
    return mergeServerPage(current, read.page ?? [], {
      hasMore: !!read.hasMore,
      sameConversation: !opts.conversationId || !read.conversationId || opts.conversationId === read.conversationId,
      arrivedLive,
    });
  }
  let t = current;
  for (const s of read.steps) {
    t = removeIds(t, s.removedIds);
    t = mergeDelta(t, s.changed);
    t = mergeDelta(t, s.items);
  }
  return t;
}

export async function fetchGroupRead(
  scope: ServerScope,
  groupId: string,
  base: CacheBase,
  deps: ReadDeps = defaultReadDeps
): Promise<ChatRead> {
  const username = scope.username();
  const pageRead = async (mode: "page" | "replace", pages = 0): Promise<ChatRead> => {
    const r = await deps.fetchProjectGroupMessages(scope, groupId, { limit: PAGE_LIMIT });
    if (!r.ok) return fail(r.error || "project chat failed", r.status);
    const page = groupMessagesToThread(r.data?.messages ?? [], username);
    return {
      ok: true,
      mode,
      steps: [],
      page,
      hasMore: !!r.data?.truncated,
      conversationId: null,
      counts: { items: page.length, changed: 0, removed: 0, pages },
      bytes: approx(r.data),
    };
  };
  const cursor = groupCursor(base);
  if (cursor == null || !deltaSupported(scope)) return pageRead("page");
  const got = await pageDeltas(
    cursor,
    (after) => deps.fetchProjectGroupDelta(scope, groupId, after, DELTA_LIMIT),
    (raw) => groupMessagesToThread(raw, username),
    (m) => m.readSeq
  );
  if (got.kind === "fail") return got.read;
  if (got.kind === "fallback") return pageRead("page");
  if (got.hasMore) return pageRead("replace", got.steps.length);
  return {
    ok: true,
    mode: "delta",
    steps: got.steps,
    page: null,
    hasMore: null,
    conversationId: null,
    counts: countSteps(got.steps),
    bytes: got.bytes,
  };
}

/** The new project chat over `current`. */
export function applyGroupRead(current: ThreadMessage[], read: OkRead): ThreadMessage[] {
  if (read.mode !== "delta") {
    // The newest page replaces the copy (as the non-delta path always did).
    return mergeGroupPage(current, read.page ?? [], { hasMore: false });
  }
  let t = current;
  for (const s of read.steps) {
    t = removeIds(t, s.removedIds);
    t = mergeGroupDelta(t, s.changed);
    t = mergeGroupDelta(t, s.items);
  }
  return t;
}
