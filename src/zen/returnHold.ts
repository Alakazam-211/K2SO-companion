import { groupCursor, threadCursor, type CacheBase } from "./chatRevalidate";

// Fresh on return: opening a chat whose cached copy is known to be behind
// the server (its unread summary's `lastSeq`, or the list's `latest` row,
// is newer than the cache's highest seq) holds the first paint briefly for
// the delta read (`thread-delta-v1`). Landing in time, the merged copy
// paints at once, at the bottom, with no animation; otherwise the cache
// paints when the hold runs out and the arrivals glide in when the read
// lands (ThreadPane / listGlide). Without the key, without a delta cursor
// or without staleness info, the cache paints at once as before. Nothing
// is marked read during the hold (nothing is on screen).

/** How long the first paint waits for the read. */
export const RETURN_HOLD_MS = 300;

/** The newest seq the phone has heard of for a chat, or null. */
export function knownServerNewest(...seqs: (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const s of seqs) {
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) continue;
    if (best === null || s > best) best = s;
  }
  return best;
}

/** Hold the first paint of `cache` for the read? */
export function holdFirstPaint(opts: {
  /** The server lists `thread-delta-v1`. */
  delta: boolean;
  kind: "thread" | "project";
  cache: CacheBase;
  serverNewest: number | null;
}): boolean {
  if (!opts.delta || opts.serverNewest == null || !opts.cache) return false;
  const cursor = opts.kind === "project" ? groupCursor(opts.cache) : threadCursor(opts.cache);
  if (cursor == null) return false;
  return opts.serverNewest > cursor;
}
