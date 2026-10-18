// What the app knows about a server being down or coming back (auto
// reconnect). A leaf store: the recovery module (`recovery.ts`) writes it,
// and the room banner, the list rows and the Thread's send queue read it.
// It never makes a request.
//
//   - `downSince`  — when the app first saw this server down (a check said
//                    offline / starting, or a list / Thread read on it failed
//                    and no recent check said it was live). Cleared when a
//                    reconnect lands or the server answers.
//   - `retryAt`    — the user's last explicit try (opened a chat there, Retry
//                    now, pull to refresh). Restarts the "Reconnecting…" grace.
//   - `reconnecting` — a reconnect (revive + refresh) is running now.
//   - `expired`    — the server answered but the login is dead (a revive said
//                    sign in again). Cleared by a new token.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { onServerForget, useServersStore } from "../../stores/servers";
import type { PoolEntry } from "./pool";

/** How long a down server reads "Reconnecting to {server}…" before it says
 *  "{server} is offline". */
export const RECONNECT_GRACE_MS = 10_000;

export interface HealthState {
  downSince: Record<string, number>;
  retryAt: Record<string, number>;
  reconnecting: Record<string, true>;
  expired: Record<string, true>;
}

const blank = (): HealthState => ({ downSince: {}, retryAt: {}, reconnecting: {}, expired: {} });

export const healthStore = createStore<HealthState>(blank);

function put<K extends keyof HealthState>(key: K, id: string, value: HealthState[K][string] | null): void {
  if (!id) return;
  const cur = healthStore.getState()[key] as Record<string, unknown>;
  if (value === null) {
    if (!(id in cur)) return;
    const next = { ...cur };
    delete next[id];
    healthStore.setState({ [key]: next } as Partial<HealthState>);
    return;
  }
  if (cur[id] === value) return;
  healthStore.setState({ [key]: { ...cur, [id]: value } } as Partial<HealthState>);
}

/** Seen down. Keeps the first time. */
export function markDown(id: string, now = Date.now()): void {
  if (healthStore.getState().downSince[id] !== undefined) return;
  put("downSince", id, now);
}

export function clearDown(id: string): void {
  put("downSince", id, null);
}

/** The user tried this server just now (restarts the grace). */
export function noteUserRetry(id: string, now = Date.now()): void {
  put("retryAt", id, now);
}

export function setReconnecting(id: string, on: boolean): void {
  put("reconnecting", id, on ? true : null);
}

export function setExpired(id: string, on: boolean): void {
  put("expired", id, on ? true : null);
}

/** A request error that means "the server did not answer", not an app
 *  error: the API client's "Could not reach server: …" (any network error
 *  or timeout), "Not connected", or the tunnel's 5xx page. */
export function looksUnreachable(error: string | null | undefined): boolean {
  if (!error) return false;
  return /could not (?:reach|connect)|not connected|timed out|HTTP 5\d\d/i.test(
    error
  );
}

/** A pool entry that says the server does not answer (or is starting). */
export function entryDown(entry: Pick<PoolEntry, "reach"> | undefined | null): boolean {
  return !!entry && (entry.reach === "offline" || entry.reach === "starting");
}

/** Down by either source: the health store, or the pool's last check. */
export function serverDown(
  id: string,
  entry: Pick<PoolEntry, "reach"> | undefined | null,
  state: HealthState = healthStore.getState()
): boolean {
  if (!id) return false;
  return state.downSince[id] !== undefined || entryDown(entry);
}

/** "reconnecting" for the grace after it went down / the user's last try,
 *  and while a reconnect runs; "offline" after that. */
export function reconnectPhase(input: {
  now: number;
  downSince?: number | null;
  retryAt?: number | null;
  checkedAt?: number | null;
  reconnecting?: boolean;
}): "reconnecting" | "offline" {
  if (input.reconnecting) return "reconnecting";
  const since = Math.max(input.downSince ?? 0, input.retryAt ?? 0) || input.checkedAt || 0;
  return input.now - since < RECONNECT_GRACE_MS ? "reconnecting" : "offline";
}

/** React view of the health store. */
export function useHealth<T>(pick: (s: HealthState) => T): T {
  return useStore(healthStore, pick);
}

// A removed or re-keyed server starts over.
onServerForget((id) => {
  clearDown(id);
  put("retryAt", id, null);
  setReconnecting(id, false);
  setExpired(id, false);
});

// A new token (the user signed in again) ends "sign in again".
useServersStore.subscribe((st, prev) => {
  if (st.tokens === prev.tokens) return;
  for (const id of Object.keys(healthStore.getState().expired)) {
    if (st.tokens[id] && st.tokens[id] !== prev.tokens[id]) setExpired(id, false);
  }
});

/** Tests only. */
export function __resetHealthForTests(): void {
  healthStore.setState(blank());
}
