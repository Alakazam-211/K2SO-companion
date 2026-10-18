// The pool's poll loop (multi-server S2, MS11/MS12 as amended by MA11, plus
// auto reconnect).
//
// Desktop's `useHomeStatusPoll`: every saved server is checked on its own
// timer — every 30 s while not offline, 5 s / 15 s / 30 s while offline. It
// runs ONLY while the app is foregrounded. A hidden tick skips the check and
// comes back in 30 s; becoming visible (or the network coming back) re-checks.
// Never polls in the background.
//
// Which servers a tick checks (`shouldCheck`):
//   - with the Agents list on screen (`zenScreen === "list"`, MA11: the list
//     stays mounted under an open Thread): every server, as before;
//   - otherwise (a Thread is open): only servers that need watching — one
//     that is down, the open room's server, the server Zen is on when its
//     list or Thread failed. Healthy servers wait for the list.
//
// The active server is checked boot-only (cheap, unauthenticated). When a
// check sees a server answer again after it was down, the recovery module
// (`recovery.ts`, via `onPoolChecked`) runs the full reconnect — the same
// one a tap in the Servers sheet runs — for the active server too.

import { useEffect, useRef } from "react";
import { nextCheckDelayMs, pool as appPool, type Pool, type PoolEntry } from "./pool";

export const HIDDEN_RETRY_MS = 30_000;
/** A tick that skipped a healthy server (list off screen) comes back in. */
export const IDLE_RETRY_MS = 30_000;

export type PoolCheckedListener = (
  serverId: string,
  entry: PoolEntry | undefined,
  before: PoolEntry | undefined
) => void;

const checkedListeners = new Set<PoolCheckedListener>();

/** Every check the loop (or `retryServerNow`) ran, with the entry before. */
export function onPoolChecked(fn: PoolCheckedListener): () => void {
  checkedListeners.add(fn);
  return () => {
    checkedListeners.delete(fn);
  };
}

function emitChecked(id: string, entry: PoolEntry | undefined, before: PoolEntry | undefined): void {
  for (const fn of [...checkedListeners]) {
    try {
      fn(id, entry, before);
    } catch {
      /* a listener never stops the loop */
    }
  }
}

export interface PoolLoopOptions {
  pool: Pool;
  serverIds: string[];
  activeId: string | null;
  isVisible: () => boolean;
  /** May a timer tick check this server now? Absent: always. Forced checks
   *  (Retry now, foreground for `force` ids) skip it. */
  shouldCheck?: (serverId: string) => boolean;
  /** After each check (for loading rows, resync on restart, …). */
  onChecked?: (serverId: string, entry: PoolEntry | undefined, before?: PoolEntry | undefined) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PoolLoop {
  /** "Retry now": check this server immediately and restart its timer. */
  retryNow(serverId: string): void;
  /** Becoming visible / back online: check every server that may be
   *  checked now, plus `force` ones whatever `shouldCheck` says. */
  recheckAll(force?: string[]): void;
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
      setTimer(() => void tick(id, false), ms)
    );
  };

  const tick = async (id: string, force: boolean) => {
    if (stopped) return;
    timers.delete(id);
    if (!opts.isVisible()) {
      arm(id, HIDDEN_RETRY_MS);
      return;
    }
    if (!force && opts.shouldCheck && !opts.shouldCheck(id)) {
      arm(id, IDLE_RETRY_MS);
      return;
    }
    const before = opts.pool.entry(id);
    const entry = await opts.pool.check(id, { bootOnly: id === opts.activeId });
    if (stopped) return;
    opts.onChecked?.(id, entry, before);
    emitChecked(id, entry, before);
    if (!entry) return; // removed
    arm(id, nextCheckDelayMs(entry));
  };

  const restart = (id: string, force: boolean) => {
    const prev = timers.get(id);
    if (prev !== undefined) clearTimer(prev);
    timers.delete(id);
    void tick(id, force);
  };

  const recheckAll = (force: string[] = []) => {
    for (const id of opts.serverIds) restart(id, force.includes(id));
  };

  recheckAll();

  return {
    retryNow(id) {
      if (stopped || !opts.serverIds.includes(id)) return;
      restart(id, true);
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
  if (current) {
    current.retryNow(serverId);
    return;
  }
  const before = appPool.entry(serverId);
  void appPool.check(serverId).then((entry) => emitChecked(serverId, entry, before));
}

/** Is the loop running (flag on, Zen mounted)? */
export function poolLoopRunning(): boolean {
  return current !== null;
}

/** Check every server the loop may check now (pull to refresh, tests). */
export function recheckServersNow(force: string[] = []): void {
  current?.recheckAll(force);
}

function visibleNow(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Run the loop while `enabled` (the flag is on), foregrounded only.
 *  Restarts when the saved servers or the active one change. A tick checks
 *  a healthy server only while `listOnScreen`; `watched(id)` servers (down,
 *  the room's, in trouble) always. Foreground and `online` re-check, with
 *  `foregroundIds()` forced. */
export function usePoolLoop(
  enabled: boolean,
  serverIds: string[],
  activeId: string | null,
  onChecked: (serverId: string, entry: PoolEntry | undefined) => void,
  opts: {
    listOnScreen?: boolean;
    watched?: (serverId: string) => boolean;
    foregroundIds?: () => string[];
  } = {}
): void {
  const onCheckedRef = useRef(onChecked);
  onCheckedRef.current = onChecked;
  const listOnScreen = opts.listOnScreen ?? true;
  const listRef = useRef(listOnScreen);
  listRef.current = listOnScreen;
  const watchedRef = useRef(opts.watched);
  watchedRef.current = opts.watched;
  const fgRef = useRef(opts.foregroundIds);
  fgRef.current = opts.foregroundIds;
  const loopRef = useRef<PoolLoop | null>(null);
  const key = serverIds.join(",");
  useEffect(() => {
    if (!enabled || !key) return;
    const loop = startPoolLoop({
      pool: appPool,
      serverIds: key.split(","),
      activeId,
      isVisible: visibleNow,
      shouldCheck: (id) => listRef.current || !!watchedRef.current?.(id),
      onChecked: (id, e) => onCheckedRef.current(id, e),
    });
    current = loop;
    loopRef.current = loop;
    const recheck = () => {
      if (visibleNow()) loop.recheckAll(fgRef.current?.() ?? []);
    };
    const onVis = () => {
      if (document.visibilityState !== "hidden") recheck();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", recheck);
    window.addEventListener("pageshow", recheck);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", recheck);
      window.removeEventListener("pageshow", recheck);
      loop.stop();
      if (current === loop) current = null;
      if (loopRef.current === loop) loopRef.current = null;
    };
  }, [enabled, key, activeId]);

  // Back on the list: every server is checked again (as when the loop used
  // to start with the list).
  const prevList = useRef(listOnScreen);
  useEffect(() => {
    const was = prevList.current;
    prevList.current = listOnScreen;
    if (listOnScreen && !was) loopRef.current?.recheckAll();
  }, [listOnScreen]);
}
