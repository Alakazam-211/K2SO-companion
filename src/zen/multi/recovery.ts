// Automatic server reconnection.
//
// THE BUG THIS FIXES
// When a server went away and came back, nothing re-ran the work a tap in
// the Servers sheet does: the pool loop checked the ACTIVE server boot-only
// and its `onChecked` skipped the active server, Zen's failed list / Thread
// was never re-read, and the pool loop stopped whenever a Thread was open.
// The user had to open Servers and tap the server again.
//
// WHAT IT DOES
// Whenever the app sees a server answer again it runs `reconnectServer`,
// the Servers sheet's reconnect without the switch: revive the login
// (`connectServer`, background: a dead login is marked, never deleted,
// MA22), re-read what is on screen for that server (Zen's list / Thread,
// or that server's rows), tell its sockets to reopen now ("recovered"), and
// clear the down state. Single-flight per server; a reconnect that leaves
// the server still broken waits 5 s / 15 s / 30 s before the next automatic
// one (a user's Retry now / pull to refresh does not wait).
//
// Triggers (multi-server flag on; the checks are the pool loop's cheap
// unauthenticated `/boot-status`, the reconnect only once it says ready):
//   - a check sees a server that was down (or is in trouble) answer;
//   - the app comes back to the foreground / the network comes back (the
//     pool loop re-checks, Zen's own server forced);
//   - Zen's list or Thread read fails: that server is checked at once.
// With the flag off there is no pool: coming back to the foreground or
// online re-runs the reconnect for the active server when its list failed.

import { useEffect } from "react";
import { emitServerSignal } from "../../api/serverSignals";
import { connectServer } from "../../lib/revive";
import { useServersStore } from "../../stores/servers";
import { useZenStore } from "../zenStore";
import { roomServerId, zenServerId } from "../zenScope";
import { pool, type PoolEntry } from "./pool";
import { onPoolChecked, poolLoopRunning, recheckServersNow, retryServerNow } from "./poolLoop";
import { useMultiServerPrefs } from "./prefs";
import { loadServerRows } from "./remoteRows";
import {
  clearDown,
  entryDown,
  healthStore,
  looksUnreachable,
  markDown,
  noteUserRetry,
  serverDown,
  setExpired,
  setReconnecting,
} from "./serverHealth";

/** Pauses before the next AUTOMATIC reconnect after one that left the
 *  server broken: none, then 5 s, 15 s, 30 s (capped). */
export const RECONNECT_GAPS_MS = [0, 5_000, 15_000, 30_000];
/** A check this recent that said "live" is trusted: no re-check first. */
export const FRESH_LIVE_MS = 10_000;

export { looksUnreachable };

export type ReconnectResult = "connected" | "signin-required" | "unreachable" | "busy";

const inflight = new Map<string, Promise<ReconnectResult>>();
const streaks = new Map<string, { count: number; at: number }>();

function flagOn(): boolean {
  return useMultiServerPrefs.getState().multiServer;
}

function hasToken(id: string): boolean {
  const st = useServersStore.getState();
  return st.servers.some((s) => s.id === id) && !!st.tokens[id];
}

function activeId(): string | null {
  return useServersStore.getState().activeServerId;
}

/** Zen is on this server and what it shows failed to load. */
export function zenBroken(id: string): boolean {
  if (!id || zenServerId() !== id) return false;
  const z = useZenStore.getState();
  if (z.screen === "thread") return z.threadSource === "error" && looksUnreachable(z.threadError);
  return z.agentSource === "error";
}

/** Should the pool loop keep checking this server while the list is off
 *  screen? Down, the open room's server, or Zen's server in trouble. */
export function serverNeedsWatch(id: string): boolean {
  if (!id) return false;
  if (serverDown(id, pool.entry(id))) return true;
  if (id === roomServerId()) return true;
  if (useServersStore.getState().recovery[id] === "reconnecting") return true;
  return zenBroken(id);
}

function reconnectAllowed(id: string, now: number): boolean {
  const s = streaks.get(id);
  if (!s || s.count <= 0) return true;
  const gap = RECONNECT_GAPS_MS[Math.min(s.count, RECONNECT_GAPS_MS.length - 1)];
  return now - s.at >= gap;
}

function noteResult(id: string, ok: boolean): void {
  if (ok) {
    streaks.delete(id);
    return;
  }
  const prev = streaks.get(id);
  streaks.set(id, { count: (prev?.count ?? 0) + 1, at: Date.now() });
}

/** Re-read what is on screen for this server after it came back. */
async function refreshServer(id: string): Promise<void> {
  const z = useZenStore.getState();
  if (zenServerId() === id) {
    if (z.screen === "thread") {
      if ((z.threadAddr || "").trim() || (z.threadGroupId || "").trim()) {
        await z.refreshOpenThread();
        if (useZenStore.getState().agentSource === "live") {
          z.refreshServerLists();
          void z.refreshActivity();
        }
      } else if (z.agentId && z.agentSource !== "loading") {
        // The chat opened before its row could be read: read both now.
        await z.hydrateAgents({ resumeId: z.agentId });
      }
      return;
    }
    if (z.agentSource === "live") {
      z.refreshServerLists();
      void z.refreshActivity();
    } else if (z.agentSource === "error") {
      await z.hydrateAgents();
    }
    return;
  }
  if (flagOn()) void loadServerRows(id);
}

/**
 * The Servers sheet's reconnect, for any server, without switching the
 * active one. Single-flight per server. `loginOk`: a check just read this
 * server's whoami as alive (skip the revive probe). `force`: the user asked
 * (no wait after a failed one).
 */
export function reconnectServer(
  id: string,
  opts: { loginOk?: boolean; force?: boolean } = {}
): Promise<ReconnectResult> {
  const running = inflight.get(id);
  if (running) return running;
  if (!hasToken(id)) return Promise.resolve("signin-required");
  if (!opts.force && !reconnectAllowed(id, Date.now())) return Promise.resolve("busy");
  setReconnecting(id, true);
  const p = runReconnect(id, opts.loginOk === true).finally(() => {
    inflight.delete(id);
    setReconnecting(id, false);
  });
  inflight.set(id, p);
  return p;
}

async function runReconnect(id: string, loginOk: boolean): Promise<ReconnectResult> {
  let outcome: unknown = "still-valid";
  if (!loginOk) {
    try {
      outcome = await connectServer(id, { background: true });
    } catch {
      outcome = "unreachable";
    }
  }
  if (outcome === "revived" || outcome === "still-valid") {
    clearDown(id);
    setExpired(id, false);
    try {
      await refreshServer(id);
    } catch {
      /* what is on screen stays; the next check tries again */
    }
    emitServerSignal(id, "recovered");
    noteResult(id, !zenBroken(id));
    return "connected";
  }
  if (outcome === "signin-required") {
    // It answers, but the login is dead: "Sign in again", not "offline".
    clearDown(id);
    if (hasToken(id)) setExpired(id, true);
    pool.noteSigninRequired(id);
    noteResult(id, false);
    return "signin-required";
  }
  markDown(id);
  noteResult(id, false);
  return "unreachable";
}

/** After every pool check: down → remember; answering again after being
 *  down (or with Zen's view of it broken) → reconnect. */
export function afterServerChecked(
  id: string,
  entry: PoolEntry | undefined,
  before: PoolEntry | undefined
): void {
  if (!entry || !flagOn()) return;
  if (entryDown(entry)) {
    markDown(id);
    return;
  }
  if (entry.reach !== "live" || !hasToken(id)) return;
  const isActive = id === activeId();
  // Another server's check read its login too: a dead one shows "Sign in".
  if (!isActive && entry.auth !== "ok") {
    clearDown(id);
    return;
  }
  const wasDown =
    healthStore.getState().downSince[id] !== undefined ||
    entryDown(before) ||
    useServersStore.getState().recovery[id] === "reconnecting";
  if (!wasDown && !zenBroken(id)) return;
  void reconnectServer(id, { loginOk: !isActive && entry.auth === "ok" });
}

/** Something Zen read on this server failed. `unreachable`: the error says
 *  the server did not answer (the banner shows at once). Checks it now. */
export function noteServerTrouble(id: string, unreachable: boolean): void {
  if (!id || !flagOn() || !hasToken(id) || inflight.has(id)) return;
  const e = pool.entry(id);
  const freshLive =
    !!e && e.reach === "live" && e.checkedAt != null && Date.now() - e.checkedAt < FRESH_LIVE_MS;
  if (freshLive && !unreachable) {
    void reconnectServer(id);
    return;
  }
  if (unreachable) markDown(id);
  retryServerNow(id);
}

/** The user asked (opened a chat there, Retry now): check now, and show
 *  "Reconnecting…" for the grace again. */
export function retryServerFromUser(id: string): void {
  if (!id) return;
  noteUserRetry(id);
  streaks.delete(id);
  retryServerNow(id);
}

/** Pull to refresh: every saved server at once; Zen's own lists re-read. */
export function refreshAllServers(): void {
  const st = useServersStore.getState();
  const ids = st.servers.map((s) => s.id);
  for (const id of ids) {
    streaks.delete(id);
    if (serverDown(id, pool.entry(id))) noteUserRetry(id);
  }
  const zid = zenServerId();
  if (!flagOn()) {
    if (zid) void reconnectServer(zid, { force: true });
    return;
  }
  if (poolLoopRunning()) recheckServersNow(ids);
  else for (const id of ids) retryServerNow(id);
  if (zid && !serverDown(zid, pool.entry(zid)) && hasToken(zid)) {
    void refreshServer(zid);
  }
}

// ─── Wiring ───

onPoolChecked(afterServerChecked);

// Zen's list or Thread on a server failed: check that server now. Leaving a
// Thread for a list that failed while it was open re-reads it too.
useZenStore.subscribe((s, p) => {
  if (!flagOn()) return;
  const id = zenServerId();
  if (!id) return;
  if (s.agentSource === "error" && p.agentSource !== "error") {
    noteServerTrouble(id, looksUnreachable(s.agentError));
  } else if (
    s.screen === "thread" &&
    s.threadSource === "error" &&
    p.threadSource !== "error" &&
    looksUnreachable(s.threadError)
  ) {
    noteServerTrouble(id, true);
  } else if (s.screen === "list" && p.screen !== "list" && s.agentSource === "error") {
    noteServerTrouble(id, looksUnreachable(s.agentError));
  }
});

/** Flag off (no pool): foreground / online re-runs the active server's
 *  reconnect when its list failed. Flag on, the pool loop does this. */
export function useFlagOffRecovery(on: boolean): void {
  useEffect(() => {
    if (on) return;
    const kick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const id = activeId();
      if (!id || zenServerId() !== id) return;
      if (useZenStore.getState().agentSource !== "error") return;
      void reconnectServer(id);
    };
    const onVis = () => {
      if (document.visibilityState !== "hidden") kick();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", kick);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", kick);
    };
  }, [on]);
}

/** Tests only. */
export function __resetRecoveryForTests(): void {
  inflight.clear();
  streaks.clear();
}
