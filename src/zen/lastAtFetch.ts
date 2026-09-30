import { getThread, type ThreadItem } from "../api/client";
import { fetchProjectGroupMessages } from "../api/projectGroups";
import { normaliseThreadItem } from "./threadModel";

/** Visible-row last-message time. Cap keeps a scroll from becoming a 61-GET. */
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

export function lastAtKey(kind: LastAtKind, id: string): string {
  return kind === "group" ? `g:${id}` : `t:${id}`;
}

export function lastAtKeyFor(row: {
  kind?: string | null;
  groupId?: string | null;
  addr?: string | null;
}): string | null {
  if (row.kind === "group" && row.groupId) return lastAtKey("group", row.groupId);
  if (row.addr) return lastAtKey("thread", row.addr);
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

const started = new Set<string>();
let inflight = 0;
const waiters: Array<() => void> = [];

/** First caller wins. Later observes of the same row no-op. */
export function beginLastAt(key: string): boolean {
  if (started.has(key)) return false;
  started.add(key);
  return true;
}

async function acquire(): Promise<void> {
  if (inflight >= LAST_AT_CAP) {
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  inflight += 1;
}

function release(): void {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) next();
}

export async function fetchLastAt(
  kind: LastAtKind,
  id: string
): Promise<number | null> {
  await acquire();
  try {
    if (kind === "group") {
      const r = await fetchProjectGroupMessages(id, { limit: 1 });
      if (!r.ok) return null;
      return groupLastAt(r.data?.messages);
    }
    const r = await getThread(id, 1);
    if (!r.ok) return null;
    return threadLastAt(r.data?.items);
  } finally {
    release();
  }
}

/** Tests only. */
export function resetLastAtQueue(): void {
  inflight = 0;
  waiters.length = 0;
  started.clear();
}
