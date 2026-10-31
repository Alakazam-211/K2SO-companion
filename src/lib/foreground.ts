// A return to the foreground, staggered (Plan - Phone Speed and Battery PRD,
// A1). The open chat's reads go first; lists, badges, sync and usage wait
// a moment, so they don't queue ahead of what the person is looking at.
// A module whose live socket reopens on the same return cancels its
// waiting run and does it once from the reopen instead.

export const FOREGROUND_STAGGER_MS = 1500;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Run `fn` a moment from now; a later call for `key` replaces this one. */
export function afterForeground(key: string, fn: () => void, delayMs = FOREGROUND_STAGGER_MS): void {
  const old = timers.get(key);
  if (old) clearTimeout(old);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      fn();
    }, delayMs)
  );
}

/** Drop `key`'s waiting run (it is being done now another way). True when
 *  one was waiting. */
export function cancelForeground(key: string): boolean {
  const t = timers.get(key);
  if (!t) return false;
  clearTimeout(t);
  timers.delete(key);
  return true;
}

/** On each return to the foreground, `fn` after the stagger. Returns the
 *  remover (which also drops a waiting run). */
export function onForegroundLater(key: string, fn: () => void, delayMs = FOREGROUND_STAGGER_MS): () => void {
  if (typeof document === "undefined") return () => {};
  const onVis = () => {
    if (document.visibilityState === "visible") afterForeground(key, fn, delayMs);
  };
  document.addEventListener("visibilitychange", onVis);
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    cancelForeground(key);
  };
}

export function __resetForegroundForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
