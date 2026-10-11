// The pool's poll loop (multi-server S2, MS11/MS12 as amended by MA11).
//
// Desktop's `useHomeStatusPoll`: every saved server is checked on its own
// timer — every 30 s while not offline, 5 s / 15 s / 30 s while offline. It
// runs ONLY while the app is foregrounded and the Agents list is on screen
// (`zenScreen === "list"`, MA11: the list stays mounted under an open
// Thread). A hidden tick skips the check and comes back in 30 s; becoming
// visible re-checks every server. Never polls in the background.
//
// The active server is checked boot-only: its login, list and sockets keep
// today's paths (zenStore, revive, ticketEvents). The pool still learns its
// version and `instanceId`.

import { useEffect, useRef } from "react";
import { nextCheckDelayMs, pool as appPool, type Pool, type PoolEntry } from "./pool";

export const HIDDEN_RETRY_MS = 30_000;

export interface PoolLoopOptions {
  pool: Pool;
  serverIds: string[];
  activeId: string | null;
  isVisible: () => boolean;
  /** After each check (for loading rows, resync on restart, …). */
  onChecked?: (serverId: string, entry: PoolEntry | undefined) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PoolLoop {
  /** "Retry now": check this server immediately and restart its timer. */
  retryNow(serverId: string): void;
  /** Becoming visible: check every server now. */
  recheckAll(): void;
  stop(): void;
}

export function startPoolLoop(opts: PoolLoopOptions): PoolLoop {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timers = new Map<string, unknown>();
  let stopped = false;

  const arm = (id: string, ms: number) => {
    const prev = timers.get(id);
    if (prev !== undefined) clearTimer(prev);
    opts.pool.schedule(id, now() + ms);
    timers.set(
      id,
      setTimer(() => void tick(id), ms)
    );
  };

  const tick = async (id: string) => {
    if (stopped) return;
    timers.delete(id);
    if (!opts.isVisible()) {
      arm(id, HIDDEN_RETRY_MS);
      return;
    }
    const entry = await opts.pool.check(id, { bootOnly: id === opts.activeId });
    if (stopped) return;
    opts.onChecked?.(id, entry);
    if (!entry) return; // removed
    arm(id, nextCheckDelayMs(entry));
  };

  const recheckAll = () => {
    for (const id of opts.serverIds) {
      const prev = timers.get(id);
      if (prev !== undefined) clearTimer(prev);
      timers.delete(id);
      void tick(id);
    }
  };

  recheckAll();

  return {
    retryNow(id) {
      if (stopped || !opts.serverIds.includes(id)) return;
      const prev = timers.get(id);
      if (prev !== undefined) clearTimer(prev);
      timers.delete(id);
      void tick(id);
    },
    recheckAll,
    stop() {
      stopped = true;
      for (const h of timers.values()) clearTimer(h);
      timers.clear();
    },
  };
}

let current: PoolLoop | null = null;

/** The Retry action of a failure row: through the running loop when there
 *  is one (so its timer restarts), else a plain check. */
export function retryServerNow(serverId: string): void {
  if (current) current.retryNow(serverId);
  else void appPool.check(serverId);
}

function visibleNow(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Run the loop while `enabled` (flag on, list on screen). Restarts when
 *  the saved servers or the active one change. */
export function usePoolLoop(
  enabled: boolean,
  serverIds: string[],
  activeId: string | null,
  onChecked: (serverId: string, entry: PoolEntry | undefined) => void
): void {
  const onCheckedRef = useRef(onChecked);
  onCheckedRef.current = onChecked;
  const key = serverIds.join(",");
  useEffect(() => {
    if (!enabled || !key) return;
    const loop = startPoolLoop({
      pool: appPool,
      serverIds: key.split(","),
      activeId,
      isVisible: visibleNow,
      onChecked: (id, e) => onCheckedRef.current(id, e),
    });
    current = loop;
    const onVis = () => {
      if (visibleNow()) loop.recheckAll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      loop.stop();
      if (current === loop) current = null;
    };
  }, [enabled, key, activeId]);
}
