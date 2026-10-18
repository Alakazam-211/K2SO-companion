// Delta reads (K2 0.46.1 `thread-delta-v1`, provisional): only the
// messages after the newest one this phone holds.
//
//   GET /cli/thread?addr=&after_seq=N&limit=L
//   GET /cli/project-group/messages?group=&after_seq=N&limit=L
//
// Answer: the items with seq > N, OLDEST first, up to `limit`;
// `has_more: true` when more new ones than `limit` exist (the caller then
// falls back to the normal newest-page read); `conversation_id` kept.
// Docs posted before N can still CHANGE (cards answered / voided); how a
// delta carries those is K2's contract to write — the caller merges every
// item by id (upsert), so changed docs land wherever they come from. Until
// that contract lands, opening a chat still revalidates with the full
// newest-page read; deltas only warm the cache (prefetch).
//
// Everything about the wire lives in this file, so a renamed param or key
// is a one-line change.

import { type ApiResponse, type ThreadItem, getThread } from "./client";
import { fetchProjectGroupMessages, type ProjectGroupMessage } from "./projectGroups";
import { scopedFetch, NOT_CONNECTED } from "./scopedFetch";
import type { ServerScope } from "./scope";

/** The `/boot-status` feature key that gates delta reads. */
export const FEATURE_THREAD_DELTA = "thread-delta-v1" as const;
/** The query param naming the cursor. */
export const DELTA_PARAM = "after_seq";
/** Items asked per delta read. */
export const DELTA_LIMIT = 50;

export function deltaSupported(scope: ServerScope): boolean {
  try {
    return scope.supports(FEATURE_THREAD_DELTA);
  } catch {
    return false;
  }
}

export type DeltaPage<T> = {
  items: T[];
  /** More new items than `limit`: read the newest page instead. */
  hasMore: boolean;
  conversationId: string | null;
  bytes: number | null;
};

async function getJson(
  scope: ServerScope,
  path: string,
  query: Record<string, string>
): Promise<ApiResponse<unknown> & { bytes?: number }> {
  try {
    const out = await scopedFetch(scope, path, { method: "GET", query });
    if (!out.ok) return { ok: false, status: out.status, error: `HTTP ${out.status}` };
    try {
      return { ok: true, data: out.text ? JSON.parse(out.text) : null, bytes: out.text.length };
    } catch {
      return { ok: false, error: "bad JSON" };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg === NOT_CONNECTED ? NOT_CONNECTED : `Could not reach server: ${msg}` };
  }
}

/** Thread items after `afterSeq` (oldest first). */
export async function fetchThreadDelta(
  scope: ServerScope,
  addr: string,
  afterSeq: number,
  limit = DELTA_LIMIT
): Promise<ApiResponse<DeltaPage<ThreadItem>>> {
  const r = await getJson(scope, "/cli/thread", {
    addr,
    [DELTA_PARAM]: String(afterSeq),
    limit: String(limit),
  });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  const d = (r.data ?? {}) as { items?: unknown; has_more?: unknown; conversation_id?: unknown };
  if (!Array.isArray(d.items)) return { ok: false, error: "no items" };
  return {
    ok: true,
    data: {
      items: d.items as ThreadItem[],
      hasMore: d.has_more === true,
      conversationId: typeof d.conversation_id === "string" && d.conversation_id.trim() ? d.conversation_id.trim() : null,
      bytes: r.bytes ?? null,
    },
  };
}

/** Project chat lines after `afterSeq` (oldest first). */
export async function fetchProjectGroupDelta(
  scope: ServerScope,
  groupId: string,
  afterSeq: number,
  limit = DELTA_LIMIT
): Promise<ApiResponse<DeltaPage<ProjectGroupMessage>>> {
  const r = await getJson(scope, "/cli/project-group/messages", {
    group: groupId,
    [DELTA_PARAM]: String(afterSeq),
    limit: String(limit),
  });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  const d = (r.data ?? {}) as { messages?: unknown; truncated?: unknown; has_more?: unknown };
  if (!Array.isArray(d.messages)) return { ok: false, error: "no messages" };
  return {
    ok: true,
    data: {
      items: d.messages as ProjectGroupMessage[],
      hasMore: d.has_more === true || d.truncated === true,
      conversationId: null,
      bytes: r.bytes ?? null,
    },
  };
}

/** The normal newest-page reads (re-exported so callers of this module
 *  have both doors in one place). */
export { getThread, fetchProjectGroupMessages };
