import { useEffect, useRef, useState } from "react";
import { rowKeyOf, type RowRef } from "./unread";
import { useRowEntry, useUnreadStore } from "./unreadStore";

// Marking a chat read while the person is reading it (K2 0.46.1
// `thread-read-v1`). Rules:
//   - only while the chat is on screen (not covered), the app is in the
//     foreground, and the reader sits at (or near) the newest message: a
//     reader scrolled up into history marks nothing;
//   - up to the newest seq actually on screen, never past it (the daemon
//     clamps anyway);
//   - only when the store says there is something unread above the
//     cursor (no POST for a chat already read; `waiting` cards are never
//     cleared by reading — answering, dismissing or expiry do that);
//   - throttled: at most one POST per `READ_THROTTLE_MS`, a newer seq seen
//     meanwhile goes in one trailing POST, and leaving the chat sends what
//     is still pending.
// The store does the rest (optimistic zero, reply / frame reconcile).

export const READ_THROTTLE_MS = 1_500;

export interface ReadMarker {
  /** The reader has seen up to `seq`. */
  see: (seq: number) => void;
  /** Send what is pending now (leaving the chat). */
  flush: () => void;
  /** Drop pending work and timers. */
  dispose: () => void;
}

/** A leading + trailing throttle over seqs: the first sighting goes out at
 *  once, later ones at most every `throttleMs`, always the newest. */
export function createReadMarker(
  send: (seq: number) => void,
  opts: {
    throttleMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
  } = {}
): ReadMarker {
  const throttleMs = opts.throttleMs ?? READ_THROTTLE_MS;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let lastAt = -Infinity;
  let pending: number | null = null;
  let timer: unknown = null;
  let dead = false;

  const fire = () => {
    timer = null;
    if (dead || pending === null) return;
    const seq = pending;
    pending = null;
    lastAt = now();
    send(seq);
  };

  return {
    see(seq) {
      if (dead || !Number.isFinite(seq)) return;
      if (pending !== null && seq <= pending) return;
      pending = seq;
      const wait = lastAt + throttleMs - now();
      if (wait <= 0) {
        if (timer !== null) clearTimer(timer);
        fire();
      } else if (timer === null) {
        timer = setTimer(fire, wait);
      }
    },
    flush() {
      if (timer !== null) clearTimer(timer);
      fire();
    },
    dispose() {
      dead = true;
      pending = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

function foregroundNow(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** The app is in the foreground (re-renders on visibility changes). */
export function useForeground(): boolean {
  const [fg, setFg] = useState(foregroundNow);
  useEffect(() => {
    const on = () => setFg(foregroundNow());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return fg;
}

/**
 * Mark `ref` on `serverId` read up to `newestSeq` while `viewing` (on
 * screen, at the newest) and the app is in the foreground.
 */
export function useMarkReadWhileViewing(opts: {
  serverId: string | null | undefined;
  rowRef: RowRef | null;
  /** The newest seq on screen (null = none yet). */
  newestSeq: number | null;
  viewing: boolean;
  throttleMs?: number;
}): void {
  const { serverId, rowRef, newestSeq, viewing, throttleMs } = opts;
  const fg = useForeground();
  const entry = useRowEntry(serverId, rowRef);
  const addrs = useUnreadStore((s) => (serverId ? s.addrs[serverId] : undefined));
  const key = rowRef ? rowKeyOf(rowRef, addrs) : null;
  const refRef = useRef(rowRef);
  refRef.current = rowRef;
  const marker = useRef<ReadMarker | null>(null);

  // One marker per conversation; leaving it sends what is pending.
  useEffect(() => {
    if (!serverId || !key) return;
    const m = createReadMarker(
      (seq) => {
        const r = refRef.current;
        if (r) void useUnreadStore.getState().markRead(serverId, r, seq);
      },
      { throttleMs }
    );
    marker.current = m;
    return () => {
      m.flush();
      m.dispose();
      if (marker.current === m) marker.current = null;
    };
  }, [serverId, key, throttleMs]);

  const unread = entry?.unread ?? 0;
  const lastRead = entry?.lastReadSeq ?? null;
  useEffect(() => {
    if (!viewing || !fg || newestSeq === null || lastRead === null || unread <= 0) return;
    if (newestSeq <= lastRead) return;
    marker.current?.see(newestSeq);
  }, [viewing, fg, newestSeq, lastRead, unread, key]);
}
