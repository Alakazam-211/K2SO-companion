import {
  FEATURE_THREAD_LATEST,
  THREAD_LATEST_MAX_ADDRS,
  getThread,
  getThreadLatest,
  serverHasFeature,
  type ThreadItem,
  type ThreadLatestItem,
} from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { scopeFor, serverMemory, type ServerScope } from "../api/scope";
import type { RowLast } from "./rowPreview";
import { isOwnerAuthored, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { noteThreadAddr } from "./unreadStore";

// Multi-server (MA6): every key is `<serverId>|t:<addr>` or
// `<serverId>|g:<groupId>`, so the same addr on two servers is two rows,
// and the fetch for a key runs on THAT server's scope. The in-flight cap
// applies per server.

/** Visible-row last-message time, per server. Cap keeps a scroll from
 *  becoming a 61-GET. */
export const LAST_AT_CAP = 3;

export type LastAtKind = "thread" | "group";

export function threadLastAt(items: ThreadItem[] | undefined): number | null {
  if (!items?.length) return null;
  let bestSeq = -Infinity;
  let at: number | null = null;
  for (const it of items) {
    const m = normaliseThreadItem(it, "");
    if (!m || m.at == null) continue;
    const seq = m.seq ?? -Infinity;
    if (seq >= bestSeq) {
      bestSeq = seq;
      at = m.at;
    }
  }
  return at;
}

export function groupLastAt(
  messages: { createdAt: number }[] | undefined
): number | null {
  if (!messages?.length) return null;
  const last = messages[messages.length - 1];
  return Number.isFinite(last.createdAt) ? last.createdAt : null;
}

/** `<serverId>|t:<addr>` / `<serverId>|g:<groupId>`. */
export function lastAtKey(serverId: string, kind: LastAtKind, id: string): string {
  return `${serverId}|${kind === "group" ? `g:${id}` : `t:${id}`}`;
}

/** Split a `lastAtKey` back into its server, kind and id. */
export function parseLastAtKey(
  key: string
): { serverId: string; kind: LastAtKind; id: string } | null {
  const bar = key.indexOf("|");
  if (bar < 0) return null;
  const serverId = key.slice(0, bar);
  const local = key.slice(bar + 1);
  const id = local.slice(2);
  if (!id) return null;
  if (local.startsWith("g:")) return { serverId, kind: "group", id };
  if (local.startsWith("t:")) return { serverId, kind: "thread", id };
  return null;
}

export function lastAtKeyFor(
  serverId: string,
  row: {
    kind?: string | null;
    groupId?: string | null;
    addr?: string | null;
  }
): string | null {
  if (row.kind === "group" && row.groupId) return lastAtKey(serverId, "group", row.groupId);
  if (row.addr) return lastAtKey(serverId, "thread", row.addr);
  return null;
}

/** Newest last-message first. Untimed rows keep their original relative order at the bottom. */
export function sortChatsByRecency<T>(
  rows: T[],
  lastAtByKey: Record<string, number | null>,
  keyOf: (row: T) => string | null
): T[] {
  return rows
    .map((row, index) => {
      const key = keyOf(row);
      const at = key ? lastAtByKey[key] : undefined;
      return { row, index, at: typeof at === "number" ? at : -Infinity };
    })
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((x) => x.row);
}

// Per server: which keys started, and that server's in-flight queue.
// Dropped when the server is removed or re-keyed (MS3).
const perServer = serverMemory(() => ({
  started: new Set<string>(),
  inflight: 0,
  waiters: [] as Array<() => void>,
}));

/** First caller wins. Later observes of the same row no-op. */
export function beginLastAt(key: string): boolean {
  const serverId = parseLastAtKey(key)?.serverId ?? "";
  const mem = perServer.get(serverId);
  if (mem.started.has(key)) return false;
  mem.started.add(key);
  return true;
}

async function acquire(serverId: string): Promise<void> {
  const mem = perServer.get(serverId);
  if (mem.inflight >= LAST_AT_CAP) {
    await new Promise<void>((resolve) => {
      mem.waiters.push(resolve);
    });
  }
  mem.inflight += 1;
}

function release(serverId: string): void {
  const mem = perServer.peek(serverId);
  if (!mem) return;
  mem.inflight = Math.max(0, mem.inflight - 1);
  const next = mem.waiters.shift();
  if (next) next();
}

/** The newest message time for one row, on `scope`'s server. */
export async function fetchLastAt(
  scope: ServerScope,
  kind: LastAtKind,
  id: string
): Promise<number | null> {
  await acquire(scope.id);
  try {
    if (kind === "group") {
      const r = await fetchProjectGroupMessages(scope, id, { limit: 1 });
      if (!r.ok) return null;
      return groupLastAt(r.data?.messages);
    }
    const r = await getThread(scope, id, 1);
    if (!r.ok) return null;
    // Unread rows match by conversation (K2 0.46.1).
    noteThreadAddr(scope.id, id, r.data?.conversation_id);
    return threadLastAt(r.data?.items);
  } finally {
    release(scope.id);
  }
}

/** `fetchLastAt` for a `lastAtKey` (its own server's scope). */
export function fetchLastAtForKey(key: string): Promise<number | null> {
  const parsed = parseLastAtKey(key);
  if (!parsed) return Promise.resolve(null);
  return fetchLastAt(scopeFor(parsed.serverId), parsed.kind, parsed.id);
}

// ─── Row snippets (line two) ───
//
// Pure reads only: `GET /cli/thread/latest` (K2 0.44+, one call for every
// row) or `GET /cli/thread?limit=1` per row. Neither wakes a session,
// activates a project, marks anything seen, or opens the overlay socket
// (whose `viewing` frame would hold back push).

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The row snippet for a Thread message the phone already has. */
export function rowLastFromMessage(
  m: ThreadMessage,
  addr: string,
  username: string
): RowLast {
  const kind = m.kind || "text";
  return {
    at: m.at,
    seq: m.seq,
    mine: isOwnerAuthored(m.from, username, addr),
    kind,
    text: kind === "secret" ? "" : kind === "choice" ? m.choice?.prompt || m.text : m.text,
  };
}

/** One `thread/latest` item. Null = empty Thread (or an addr the server
 *  refused: nothing to show). */
export function rowLastFromLatest(
  item: ThreadLatestItem,
  username: string
): RowLast | null {
  if (item.error) return null;
  const at = finite(item.at);
  const seq = finite(item.seq);
  if (at == null && seq == null && !item.preview) return null;
  const kind = (item.kind || "text").trim() || "text";
  let text = typeof item.preview === "string" ? item.preview : "";
  if (kind === "secret") text = "";
  else if (kind === "choice") text = text.replace(/^Asked:\s*/, "");
  const from = (item.from || "").trim();
  return {
    at,
    seq,
    mine: item.via === "compose" || isOwnerAuthored(from, username, item.addr),
    kind,
    text,
    flat: true,
  };
}

/** Newest non-chatter item of a `GET /cli/thread` page. */
export function threadRowLast(
  items: ThreadItem[] | undefined,
  addr: string,
  username: string
): RowLast | null {
  let best: ThreadMessage | null = null;
  for (const it of items ?? []) {
    const m = normaliseThreadItem(it, username);
    if (!m || m.kind === "chatter") continue;
    if (!best || (m.seq ?? -Infinity) >= (best.seq ?? -Infinity)) best = m;
  }
  return best ? rowLastFromMessage(best, addr, username) : null;
}

/** Snippet + time for each addr. A missing addr = that read failed (keep
 *  what is on screen). On `scope`'s server only (MA6). `thread/latest` when
 *  the server lists the feature,
 *  one call per 50 addrs; else one `thread?limit=1` per addr (3 at a time). */
export async function fetchThreadLasts(
  scope: ServerScope,
  addrs: string[],
  username: string
): Promise<{ via: "latest" | "per-row"; lasts: Map<string, RowLast | null> }> {
  const lasts = new Map<string, RowLast | null>();
  const uniq = [...new Set(addrs.map((a) => a.trim()).filter(Boolean))];
  if (!uniq.length) return { via: "latest", lasts };
  let rest = uniq;
  let via: "latest" | "per-row" = "per-row";
  let batched = false;
  try {
    batched = await serverHasFeature(scope, FEATURE_THREAD_LATEST);
  } catch {
    batched = false;
  }
  if (batched) {
    via = "latest";
    rest = [];
    for (let i = 0; i < uniq.length; i += THREAD_LATEST_MAX_ADDRS) {
      const chunk = uniq.slice(i, i + THREAD_LATEST_MAX_ADDRS);
      const r = await getThreadLatest(scope, chunk).catch(() => null);
      const body = r?.ok ? (r.data as { items?: unknown } | undefined) : undefined;
      const items = Array.isArray(body?.items) ? (body.items as ThreadLatestItem[]) : null;
      if (!items) {
        rest.push(...chunk);
        continue;
      }
      for (const item of items) {
        if (item && typeof item.addr === "string" && chunk.includes(item.addr)) {
          lasts.set(item.addr, rowLastFromLatest(item, username));
          // Unread rows match by conversation (K2 0.46.1).
          if (!item.error) noteThreadAddr(scope.id, item.addr, item.conversationId);
        }
      }
    }
  }
  await Promise.all(
    rest.map(async (addr) => {
      await acquire(scope.id);
      try {
        const r = await getThread(scope, addr, 1);
        if (r.ok) {
          lasts.set(addr, threadRowLast(r.data?.items, addr, username));
          noteThreadAddr(scope.id, addr, r.data?.conversation_id);
        }
      } catch {
        /* keep what is on screen */
      } finally {
        release(scope.id);
      }
    })
  );
  return { via, lasts };
}

/** Same item, nothing to redraw. */
export function sameRowLast(a: RowLast | null | undefined, b: RowLast | null): boolean {
  if (a === undefined) return false;
  if (a === null || b === null) return a === b;
  // seq + at name the item. A full body replacing a flat preview of the
  // same item is not news (and must not flip back on the next poll).
  if (a.seq != null || b.seq != null) return a.seq === b.seq && a.at === b.at;
  return a.at === b.at && a.text === b.text;
}

/** Tests only. */
export function resetLastAtQueue(): void {
  perServer.clear();
}
