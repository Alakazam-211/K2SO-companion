import { attachmentsKey, keepKnownAttachmentStates } from "../api/threadAttachmentPure";
import type { ThreadMessage } from "./threadModel";

// Chat cache merges (stale-while-revalidate). Pure: no store, no I/O.
//
// Rules (a server read over what the phone already shows):
//   - the server copy wins for every message it carries (an answered or
//     voided card, a file whose state changed, an edited body);
//   - inside the seq window the server page covers, a cached message the
//     page does not carry is gone and is dropped; older than the page
//     (when it says there is more) the phone's copy stays; newer than its
//     newest only a live frame that arrived while the read ran stays
//     (`arrivedLive`) — anything else the server already had, so it is gone;
//   - the phone's own optimistic rows (`pending` / `failed`) always stay;
//   - another conversation id (the Thread was reset) means the cache is
//     another conversation: the server page replaces it whole;
//   - unchanged messages keep their objects, and an unchanged list keeps
//     its array, so nothing re-renders for nothing.

/** Most messages a cached chat keeps (the newest). */
export const CACHE_MAX_MESSAGES = 100;

function sameChoice(a: ThreadMessage["choice"], b: ThreadMessage["choice"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.prompt === b.prompt &&
    a.answer === b.answer &&
    (a.resultMessage ?? null) === (b.resultMessage ?? null) &&
    JSON.stringify(a.permission ?? null) === JSON.stringify(b.permission ?? null) &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o === b.options[i])
  );
}

/** Same message as far as the screen can tell. */
export function sameMessage(a: ThreadMessage, b: ThreadMessage): boolean {
  return (
    a.id === b.id &&
    a.seq === b.seq &&
    a.text === b.text &&
    a.from === b.from &&
    a.at === b.at &&
    a.mine === b.mine &&
    a.kind === b.kind &&
    !!a.pending === !!b.pending &&
    !!a.failed === !!b.failed &&
    !!a.provisional === !!b.provisional &&
    !!a.partial === !!b.partial &&
    (a.readSeq ?? null) === (b.readSeq ?? null) &&
    sameChoice(a.choice, b.choice) &&
    attachmentsKey(a.files) === attachmentsKey(b.files)
  );
}

/** `next`, reusing `prev`'s objects (and `prev` itself) where nothing changed. */
export function shareUnchanged(prev: ThreadMessage[], next: ThreadMessage[]): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const m of prev) if (m.id) byId.set(m.id, m);
  let changed = prev.length !== next.length;
  const out = next.map((m, i) => {
    const old = m.id ? byId.get(m.id) : undefined;
    const keep = old && sameMessage(old, m) ? old : m;
    if (keep !== prev[i]) changed = true;
    return keep;
  });
  return changed ? out : prev;
}

function bySeq(a: ThreadMessage, b: ThreadMessage): number {
  return (a.seq ?? 0) - (b.seq ?? 0);
}

function local(m: ThreadMessage): boolean {
  return !!m.pending || !!m.failed;
}

/**
 * Merge the server's newest page (`page`, any order) over `current`.
 * `hasMore`: the server has older messages than the page. `sameConversation`
 * false: `current` belongs to another conversation (replace).
 */
export function mergeServerPage(
  current: ThreadMessage[],
  page: ThreadMessage[],
  opts: { hasMore: boolean; sameConversation?: boolean; arrivedLive?: ReadonlySet<string> }
): ThreadMessage[] {
  const pageSorted = [...page].sort(bySeq);
  const keepLocal = current.filter(local);
  if (opts.sameConversation === false || !current.length) {
    return shareUnchanged(current, [...pageSorted, ...keepLocal]);
  }
  const seqs = pageSorted.map((m) => m.seq).filter((s): s is number => s != null);
  const hi = seqs.length ? Math.max(...seqs) : null;
  const lo = seqs.length ? Math.min(...seqs) : null;
  const pageIds = new Set(pageSorted.map((m) => m.id).filter(Boolean));
  const kept: ThreadMessage[] = [];
  for (const m of current) {
    if (local(m)) continue;
    if (m.id && pageIds.has(m.id)) continue; // the server's copy wins
    if (m.seq == null) continue; // cannot be placed: the page decides
    if (hi == null) {
      // An empty page: the Thread is empty now (bar frames that raced it).
      if (opts.arrivedLive?.has(m.id) || opts.hasMore) kept.push(m);
      continue;
    }
    if (m.seq > hi) {
      // Newer than the read: a live frame that raced it stays.
      if (opts.arrivedLive?.has(m.id)) kept.push(m);
    }
    else if (m.seq < (lo as number) && opts.hasMore) kept.push(m); // older than the page
    // else inside the page's window (or proven gone below it): dropped
  }
  const merged = [...kept, ...pageSorted].sort(bySeq);
  return shareUnchanged(current, [...merged, ...keepLocal]);
}

/** A delta's copy of a message over the one held: a chip the delta sent
 *  without a `state` keeps the known one (never silently back to "ok"). */
function overHeld(held: ThreadMessage, d: ThreadMessage): ThreadMessage {
  const files = keepKnownAttachmentStates(held.files, d.files);
  return files === d.files ? d : { ...d, files };
}

/**
 * Merge a delta (`after_seq` read: messages newer than the cache's
 * newest, plus — per K2's delta contract — older messages that CHANGED
 * since, e.g. an answered or voided card). Upsert by id; a new seq is
 * appended in order. Nothing is dropped.
 */
export function mergeDelta(current: ThreadMessage[], delta: ThreadMessage[]): ThreadMessage[] {
  if (!delta.length) return current;
  const byId = new Map<string, ThreadMessage>();
  for (const m of delta) if (m.id) byId.set(m.id, m);
  const seen = new Set<string>();
  const next = current.map((m) => {
    const d = m.id ? byId.get(m.id) : undefined;
    if (!d) return m;
    seen.add(m.id);
    return overHeld(m, d);
  });
  // A changed doc may come without an id match only if its id moved;
  // match by seq then (replace in place).
  const bySeqAt = new Map<number, number>();
  next.forEach((m, i) => {
    if (m.seq != null) bySeqAt.set(m.seq, i);
  });
  for (const d of delta) {
    if (d.id && seen.has(d.id)) continue;
    const at = d.seq != null ? bySeqAt.get(d.seq) : undefined;
    if (at != null && !local(next[at])) {
      next[at] = overHeld(next[at], d);
      continue;
    }
    next.push(d);
  }
  return shareUnchanged(current, next.sort(bySeq));
}

/** The newest `max` server messages (optimistic rows never persist). */
export function cacheSlice(
  thread: ThreadMessage[],
  max = CACHE_MAX_MESSAGES
): { messages: ThreadMessage[]; truncated: boolean } {
  const settled = thread.filter((m) => !local(m));
  if (settled.length <= max) return { messages: settled, truncated: false };
  return { messages: settled.slice(settled.length - max), truncated: true };
}

/** Newest server seq in `thread` (delta cursor), else null. A message
 *  that came in a push isn't confirmed yet: counting it would skip any
 *  message before it that the push didn't carry. */
export function newestSeq(thread: ThreadMessage[], field: "seq" | "readSeq" = "seq"): number | null {
  let best: number | null = null;
  for (const m of thread) {
    if (local(m) || m.provisional) continue;
    const s = field === "readSeq" ? m.readSeq : m.seq;
    if (typeof s !== "number" || !Number.isFinite(s)) continue;
    if (best == null || s > best) best = s;
  }
  return best;
}

/**
 * A project chat delta over its cached lines. Lines carry their own seq in
 * `readSeq` (`seq` is the list position): upsert by id, order by `readSeq`,
 * renumber positions.
 */
export function mergeGroupDelta(current: ThreadMessage[], delta: ThreadMessage[]): ThreadMessage[] {
  if (!delta.length) return current;
  const byId = new Map<string, ThreadMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const d of delta) byId.set(d.id, d);
  const ordered = [...byId.values()].sort(
    (a, b) => (a.readSeq ?? Number.MAX_SAFE_INTEGER) - (b.readSeq ?? Number.MAX_SAFE_INTEGER) || (a.at ?? 0) - (b.at ?? 0)
  );
  return shareUnchanged(
    current,
    ordered.map((m, i) => (m.seq === i ? m : { ...m, seq: i }))
  );
}

/** Delete messages by id (a delta's `removed`). Same array when none. */
export function removeIds(current: ThreadMessage[], ids: readonly string[]): ThreadMessage[] {
  if (!ids.length) return current;
  const gone = new Set(ids);
  const next = current.filter((m) => !m.id || !gone.has(m.id) || local(m));
  return next.length === current.length ? current : next;
}

/** A project chat's newest page over its cached lines: the page, plus —
 *  when the server says older lines exist — cached lines older than the
 *  page; ordered by `readSeq`, positions renumbered. */
export function mergeGroupPage(
  current: ThreadMessage[],
  page: ThreadMessage[],
  opts: { hasMore: boolean }
): ThreadMessage[] {
  const seqs = page.map((m) => m.readSeq).filter((s): s is number => typeof s === "number");
  const lo = seqs.length ? Math.min(...seqs) : null;
  const pageIds = new Set(page.map((m) => m.id));
  const older =
    opts.hasMore && lo != null
      ? current.filter((m) => !pageIds.has(m.id) && typeof m.readSeq === "number" && m.readSeq < lo)
      : [];
  // The page is already in order; only cached lines in front need sorting.
  const ordered = older.length
    ? [...older, ...page].sort(
        (a, b) => (a.readSeq ?? Number.MAX_SAFE_INTEGER) - (b.readSeq ?? Number.MAX_SAFE_INTEGER) || (a.at ?? 0) - (b.at ?? 0)
      )
    : page;
  return shareUnchanged(
    current,
    ordered.map((m, i) => (m.seq === i ? m : { ...m, seq: i }))
  );
}
