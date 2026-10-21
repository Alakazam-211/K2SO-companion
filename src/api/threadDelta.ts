// Delta reads (K2 0.46.1 `thread-delta-v1`, contract
// thread-delta-contract-0461): only what changed since the newest message
// this phone holds.
//
//   GET /cli/thread?addr=&after_seq=N&limit=L
//   GET /cli/project-group/messages?group=&after_seq=N&limit=L
//
// Answer:
//   items / messages  seq > N, OLDEST first, at most `limit`, current state
//   has_more          MORE NEWER items remain past this page (the opposite
//                     of the newest-page read's has_more, which means older
//                     items exist). Project: `truncated` says the same.
//   changed           items with seq <= N rewritten since (cards answered,
//                     voided, expired…), current state: upsert by id
//   removed           [{id, seq}] no longer in this Thread: delete
//   conversation_id   Thread only; a different one = the conversation moved
//                     (seqs renumbered): drop the cache, read the newest page
// `changed` / `removed` are complete on every answer (also with has_more).
// Project messages never change (both always []), parsed anyway. 403 /
// 404 = the access or the chat is gone (project 404 = project deleted).
//
// Without the feature key `after_seq` is never sent (an older daemon would
// answer with the newest page, which is not a delta). Everything about the
// wire lives in this file.

import type { ApiResponse, ThreadItem } from "./client";
import type { ProjectGroupMessage } from "./projectGroups";
import { scopedFetch, NOT_CONNECTED } from "./scopedFetch";
import { permissionCardsOn, type ServerScope } from "./scope";

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

export type RemovedRef = { id: string; seq: number | null };

export type DeltaPage<T> = {
  /** seq > cursor, oldest first. */
  items: T[];
  /** seq <= cursor, rewritten since: upsert by id. */
  changed: T[];
  /** No longer in the chat: delete by id. */
  removed: RemovedRef[];
  /** More NEWER items remain past `items`. */
  hasMore: boolean;
  conversationId: string | null;
  bytes: number | null;
};

/** The access or the chat is gone: drop its cache. */
export function goneStatus(status: number | undefined): boolean {
  return status === 403 || status === 404;
}

function parseRemoved(raw: unknown): RemovedRef[] {
  if (!Array.isArray(raw)) return [];
  const out: RemovedRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const id = (r as { id?: unknown }).id;
    const seq = (r as { seq?: unknown }).seq;
    if (typeof id !== "string" || !id) continue;
    out.push({ id, seq: typeof seq === "number" && Number.isFinite(seq) ? seq : null });
  }
  return out;
}

function errorText(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string | { code?: string; hint?: string } };
    const e = j?.error;
    if (typeof e === "string" && e) return e;
    if (e && typeof e === "object") return e.hint || e.code || `HTTP ${status}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}`;
}

async function getJson(
  scope: ServerScope,
  path: string,
  query: Record<string, string>
): Promise<ApiResponse<unknown> & { bytes?: number }> {
  try {
    const out = await scopedFetch(scope, path, { method: "GET", query });
    if (!out.ok) return { ok: false, status: out.status, error: errorText(out.status, out.text) };
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

/** Thread delta after `afterSeq`. */
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
    ...(permissionCardsOn(scope) ? { cards: "2" } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  const d = (r.data ?? {}) as {
    items?: unknown;
    changed?: unknown;
    removed?: unknown;
    has_more?: unknown;
    conversation_id?: unknown;
  };
  if (!Array.isArray(d.items)) return { ok: false, error: "no items" };
  return {
    ok: true,
    data: {
      items: d.items as ThreadItem[],
      changed: Array.isArray(d.changed) ? (d.changed as ThreadItem[]) : [],
      removed: parseRemoved(d.removed),
      hasMore: d.has_more === true,
      conversationId:
        typeof d.conversation_id === "string" && d.conversation_id.trim() ? d.conversation_id.trim() : null,
      bytes: r.bytes ?? null,
    },
  };
}

/** Project chat delta after `afterSeq` (lines' own seq). */
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
  const d = (r.data ?? {}) as {
    messages?: unknown;
    changed?: unknown;
    removed?: unknown;
    truncated?: unknown;
    has_more?: unknown;
  };
  if (!Array.isArray(d.messages)) return { ok: false, error: "no messages" };
  return {
    ok: true,
    data: {
      items: d.messages as ProjectGroupMessage[],
      changed: Array.isArray(d.changed) ? (d.changed as ProjectGroupMessage[]) : [],
      removed: parseRemoved(d.removed),
      hasMore: d.has_more === true || d.truncated === true,
      conversationId: null,
      bytes: r.bytes ?? null,
    },
  };
}
