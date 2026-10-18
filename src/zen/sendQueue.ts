// Sends typed while the room's server is down (auto reconnect).
//
// With the multi-server flag on, a Thread whose server is down stays open
// for typing (its banner says "Reconnecting…" / "offline"). A send then is
// QUEUED instead of failing: its bubble shows "Waiting for connection…",
// and once the server is back (the reconnect cleared its down state) the
// open Thread delivers every queued send of that room, oldest first, through
// its normal path (uploads, POST, re-read). A send whose POST fails because
// the server did not answer is queued the same way, and the server is
// checked at once. Queued sends live in the in-memory outbox, like every
// other unconfirmed send: they go out only in the room they were typed in,
// while it is open.

import { useEffect, useRef } from "react";
import { useMultiServerPrefs } from "./multi/prefs";
import { pool, usePoolEntries } from "./multi/pool";
import { retryServerNow } from "./multi/poolLoop";
import { looksUnreachable, markDown, serverDown, useHealth } from "./multi/serverHealth";
import { useZenStore } from "./zenStore";

/** Queue instead of POSTing: the flag is on and the server is down. */
export function shouldQueueSend(serverId: string | null | undefined): boolean {
  if (!serverId || !useMultiServerPrefs.getState().multiServer) return false;
  return serverDown(serverId, pool.entry(serverId));
}

/** Mark a send queued (its server is down). */
export function queueSend(localId: string): void {
  useZenStore.getState().patchOutgoing(localId, { status: "queued", error: null });
}

/** A send that just failed: when the server did not answer (flag on), queue
 *  it instead, mark the server down and check it now. True when queued. */
export function requeueIfUnreachable(serverId: string | null | undefined, localId: string): boolean {
  if (!serverId || !useMultiServerPrefs.getState().multiServer) return false;
  const entry = useZenStore.getState().outbox.find((o) => o.localId === localId);
  if (!entry || entry.status !== "failed" || !looksUnreachable(entry.error)) return false;
  queueSend(localId);
  markDown(serverId);
  retryServerNow(serverId);
  return true;
}

/** While the room is open: once its server is back, deliver its queued
 *  sends one by one, oldest first. */
export function useQueuedSendFlush(
  serverId: string,
  roomKey: string,
  deliver: (localId: string) => Promise<void>
): void {
  const entries = usePoolEntries();
  const downByHealth = useHealth((h) => h.downSince[serverId] !== undefined);
  const reconnecting = useHealth((h) => h.reconnecting[serverId] === true);
  const ready = !!serverId && !reconnecting && !downByHealth && !serverDown(serverId, entries[serverId]);
  const queued = useZenStore(
    (s) =>
      s.outbox.filter((o) => o.roomKey === roomKey && o.status === "queued").map((o) => o.localId).join(",")
  );
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  const running = useRef(false);
  useEffect(() => {
    if (!ready || !queued || running.current) return;
    running.current = true;
    void (async () => {
      try {
        for (const id of queued.split(",")) {
          const o = useZenStore.getState().outbox.find((x) => x.localId === id);
          if (!o || o.status !== "queued" || o.roomKey !== roomKey) continue;
          await deliverRef.current(id);
          // Down again: the rest wait for the next recovery.
          if (shouldQueueSend(serverId)) break;
        }
      } finally {
        running.current = false;
      }
    })();
  }, [ready, queued, roomKey, serverId]);
}
