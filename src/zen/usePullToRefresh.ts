// Pull to refresh for a scrolling list (Home / Agents). Watches touches
// only (passive listeners: the list's own scrolling, the iOS rubber band,
// row swipes and the pin drag are untouched): a downward drag that starts
// with the list at its top, mostly vertical, past `PULL_TRIGGER_PX` on
// release, runs `onRefresh` once. `pull` (0…1) drives the indicator.

import { useEffect, useRef, useState, type RefObject } from "react";

export const PULL_TRIGGER_PX = 70;
/** How long the indicator spins at least after a refresh starts. */
export const PULL_SPIN_MS = 700;

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: () => void,
  enabled = true
): { pull: number; refreshing: boolean } {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let start: { x: number; y: number } | null = null;
    let dist = 0;
    let spin: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      start = null;
      dist = 0;
      setPull(0);
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || el.scrollTop > 0) {
        start = null;
        return;
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      // A sideways swipe (row actions) or a scroll down the list: not a pull.
      if (Math.abs(dx) > Math.abs(dy) || dy <= 0 || el.scrollTop > 0) {
        if (dist > 0) setPull(0);
        dist = 0;
        if (Math.abs(dx) > 12 || el.scrollTop > 0) start = null;
        return;
      }
      dist = dy;
      setPull(Math.min(1, dy / PULL_TRIGGER_PX));
    };
    const onEnd = () => {
      const fire = start !== null && dist >= PULL_TRIGGER_PX;
      reset();
      if (!fire) return;
      setRefreshing(true);
      try {
        onRefreshRef.current();
      } finally {
        if (spin) clearTimeout(spin);
        spin = setTimeout(() => setRefreshing(false), PULL_SPIN_MS);
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", reset);
      if (spin) clearTimeout(spin);
    };
  }, [ref, enabled]);

  return { pull, refreshing };
}
