import type { ReadMode } from "./chatRevalidate";
import type { ThreadMessage } from "./threadModel";

// Attachment states after a delta (K2 0.46.1 thread-delta contract): a
// chip's `state` (ok / changed / gone / hidden) is computed per read and
// never stored, so editing, moving or deleting a file does NOT put its
// message in a delta's `changed`. Messages the phone already holds keep
// their old chip states after an `after_seq` read; only a plain read of
// that range (or a tap's `mode=meta`) refreshes them.
//
// So after a delta revalidation of an OPEN Thread whose newest window
// carries files, the phone runs one plain newest-page read in the
// background and merges it ("the server wins in its window"): chip states
// update in place. Throttled per chat; a plain read (page / replace /
// reset) counts as a refresh by itself. Not for project chats (no files)
// and not for prefetch (kept cheap). Pure bookkeeping here; the store
// does the read.

/** The newest messages (by seq) whose files are worth a plain read. */
export const ATTACH_REFRESH_WINDOW = 50;
/** At most one background plain read per chat this often. */
export const ATTACH_REFRESH_MIN_MS = 3 * 60_000;

/** Does a held message among the newest `window` (by seq) carry files? */
export function windowHasFiles(thread: readonly ThreadMessage[], window = ATTACH_REFRESH_WINDOW): boolean {
  const settled = thread.filter((m) => !m.pending && !m.failed && typeof m.seq === "number");
  if (!settled.length) return false;
  const seqs = settled.map((m) => m.seq as number).sort((a, b) => b - a);
  const floor = seqs[Math.min(window, seqs.length) - 1];
  return settled.some((m) => (m.seq as number) >= floor && !!m.files?.length);
}

const lastPlain = new Map<string, number>();

/**
 * A Thread read finished for room `key`. A plain read (page / replace /
 * reset) just refreshed every chip it carried: it starts the throttle and
 * nothing more is needed. A delta: true when a background plain read is
 * due (files in the window, none within `ATTACH_REFRESH_MIN_MS`) — the
 * throttle is taken now, so a second delta meanwhile does not ask again.
 */
export function attachRefreshDue(
  key: string,
  mode: ReadMode,
  thread: readonly ThreadMessage[],
  now = Date.now()
): boolean {
  if (mode !== "delta") {
    lastPlain.set(key, now);
    return false;
  }
  const at = lastPlain.get(key);
  if (at != null && now - at < ATTACH_REFRESH_MIN_MS) return false;
  if (!windowHasFiles(thread)) return false;
  lastPlain.set(key, now);
  return true;
}

export function resetAttachRefreshForTests(): void {
  lastPlain.clear();
}
