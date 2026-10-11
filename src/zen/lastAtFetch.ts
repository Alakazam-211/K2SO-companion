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
import type { RowLast } from "./rowPreview";
import { isOwnerAuthored, normaliseThreadItem, type ThreadMessage } from "./threadModel";

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
 *  what is on screen). `thread/latest` when the server lists the feature,
 *  one call per 50 addrs; else one `thread?limit=1` per addr (3 at a time). */
export async function fetchThreadLasts(
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
    batched = await serverHasFeature(FEATURE_THREAD_LATEST);
  } catch {
    batched = false;
  }
  if (batched) {
    via = "latest";
    rest = [];
    for (let i = 0; i < uniq.length; i += THREAD_LATEST_MAX_ADDRS) {
      const chunk = uniq.slice(i, i + THREAD_LATEST_MAX_ADDRS);
      const r = await getThreadLatest(chunk).catch(() => null);
      const body = r?.ok ? (r.data as { items?: unknown } | undefined) : undefined;
      const items = Array.isArray(body?.items) ? (body.items as ThreadLatestItem[]) : null;
      if (!items) {
        rest.push(...chunk);
        continue;
      }
      for (const item of items) {
        if (item && typeof item.addr === "string" && chunk.includes(item.addr)) {
          lasts.set(item.addr, rowLastFromLatest(item, username));
        }
      }
    }
  }
  await Promise.all(
    rest.map(async (addr) => {
      await acquire();
      try {
        const r = await getThread(addr, 1);
        if (r.ok) lasts.set(addr, threadRowLast(r.data?.items, addr, username));
      } catch {
        /* keep what is on screen */
      } finally {
        release();
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
  inflight = 0;
  waiters.length = 0;
  started.clear();
}
