import { getThread, type ThreadItem } from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { scopeFor, serverMemory, type ServerScope } from "../api/scope";
import { normaliseThreadItem } from "./threadModel";

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

/** Tests only. */
export function resetLastAtQueue(): void {
  perServer.clear();
}
