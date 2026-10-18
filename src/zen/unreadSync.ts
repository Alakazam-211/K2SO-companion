import { useEffect } from "react";
import { scopeFor } from "../api/scope";
import { onServerSignal } from "../api/serverSignals";
import { onBadgeTotals } from "../lib/badgeTotals";
import { onServerForget, useServersStore } from "../stores/servers";
import { onPoolChecked } from "./multi/poolLoop";
import { subscribeAppEvents, type TicketEventsHandle } from "./ticketEvents";
import { isReadFrame } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { useZenStore } from "./zenStore";
import { useZenScope } from "./zenScope";

// When the unread summary is (re)read, and where its live frames come from
// (K2 0.46.1 `thread-read-v1`). Mounted once by the Zen page.
//
//   - mount, and Zen's list going live (its hydrate learns the server's
//     features): every signed-in server;
//   - app foreground (`visibilitychange` → visible): every server, at most
//     every 5 s;
//   - a socket re-open / lag / auto reconnect (`serverSignals`), and the
//     events hub's own re-pull after a reopen or daemon restart;
//   - each pool check that finds a server live and signed in, at most
//     every 30 s (the pool loop's cadence: the "otherwise" poll);
//   - a `badgeTotals` event from the push plugin (a silent badge push, or
//     an alert push while open): that server, at most every 1.5 s.
// Frames: `thread_read` / `project_read` on each supporting server's
// shared `/cli/sessions/events` socket, applied at once (no debounce).
// Everything is a no-op for a server without the feature.

export const UNREAD_POOL_GAP_MS = 30_000;
export const UNREAD_FOREGROUND_GAP_MS = 5_000;
export const UNREAD_BADGE_GAP_MS = 1_500;

const frameSubs = new Map<string, TicketEventsHandle>();

function signedInIds(): string[] {
  const s = useServersStore.getState();
  return s.servers.filter((x) => !!s.tokens[x.id]).map((x) => x.id);
}

function refreshAll(minGapMs?: number): void {
  for (const id of signedInIds()) void useUnreadStore.getState().refresh(id, { minGapMs });
}

/** Keep one frame subscription per server that has a loaded slice. */
function syncFrames(): void {
  const servers = useUnreadStore.getState().servers;
  for (const id of Object.keys(servers)) {
    if (frameSubs.has(id)) continue;
    let handle: TicketEventsHandle;
    try {
      handle = subscribeAppEvents(
        scopeFor(id),
        isReadFrame,
        // A re-pull (socket reopened, daemon restarted): frames were lost.
        () => void useUnreadStore.getState().refresh(id),
        (frame) => useUnreadStore.getState().applyFrame(id, frame)
      );
    } catch {
      continue;
    }
    frameSubs.set(id, handle);
  }
  for (const [id, h] of frameSubs) {
    if (servers[id]) continue;
    h.stop();
    frameSubs.delete(id);
  }
}

function stopFrames(): void {
  for (const h of frameSubs.values()) h.stop();
  frameSubs.clear();
}

onServerForget((id) => {
  frameSubs.get(id)?.stop();
  frameSubs.delete(id);
});

export function useUnreadSync(): void {
  const ids = useServersStore((s) =>
    s.servers
      .filter((x) => !!s.tokens[x.id])
      .map((x) => x.id)
      .join(",")
  );
  const zenId = useZenScope().id;
  const agentSource = useZenStore((s) => s.agentSource);

  // Signed-in servers (and a sign-in / sign-out): read each.
  useEffect(() => {
    for (const id of ids ? ids.split(",") : []) void useUnreadStore.getState().refresh(id);
  }, [ids]);

  // Zen's list went live: its hydrate has read that server's features.
  useEffect(() => {
    if (agentSource === "live" && zenId) void useUnreadStore.getState().refresh(zenId, { minGapMs: 2_000 });
  }, [agentSource, zenId]);

  useEffect(() => {
    syncFrames();
    const offStore = useUnreadStore.subscribe((s, prev) => {
      if (s.servers !== prev.servers) syncFrames();
    });
    const onVis = () => {
      if (document.visibilityState === "visible") refreshAll(UNREAD_FOREGROUND_GAP_MS);
    };
    document.addEventListener("visibilitychange", onVis);
    const offSignal = onServerSignal((id, signal) => {
      if (signal === "recovered" || signal === "reopened" || signal === "lagged") {
        void useUnreadStore.getState().refresh(id);
      }
    });
    const offPool = onPoolChecked((id, entry) => {
      if (entry && entry.reach === "live" && entry.auth === "ok") {
        void useUnreadStore.getState().refresh(id, { minGapMs: UNREAD_POOL_GAP_MS });
      }
    });
    let offBadge: (() => void) | null = null;
    let alive = true;
    void onBadgeTotals((e) => {
      if (e.serverId) void useUnreadStore.getState().refresh(e.serverId, { minGapMs: UNREAD_BADGE_GAP_MS });
    }).then((off) => {
      if (alive) offBadge = off;
      else off();
    });
    return () => {
      alive = false;
      offStore();
      document.removeEventListener("visibilitychange", onVis);
      offSignal();
      offPool();
      offBadge?.();
      stopFrames();
    };
  }, []);
}

/** Tests: frame subscriptions held now. */
export function __unreadFrameSubsForTests(): string[] {
  return [...frameSubs.keys()];
}
