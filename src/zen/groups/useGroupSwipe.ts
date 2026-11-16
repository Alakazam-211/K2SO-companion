// The plumbing for groupSwipe.ts: touch listeners on the Home list and on
// the group bar, the list following the finger (compositor-only
// transforms), and the release: a glide back, or a glide out, the group
// switch, and the new group's list gliding in from the other side (a plain
// slide, no peek). The bar's accent blend reads `useGroupSwipeStore`.

import { useEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { velocityFromSamples } from "../../lib/swipeBack";
import { chatterSwipeIgnores } from "../chatterSwipe";
import {
  GLIDE_EASE,
  GLIDE_MIN_MS,
  canArmGroupSwipe,
  glideMs,
  groupSwipeOffset,
  groupSwipePhase,
  groupSwipeProgress,
  groupSwipeRelease,
  swipeDirection,
  useGroupSwipeStore,
  type GroupSwipeDirection,
  type GroupSwipePhase,
} from "./groupSwipe";

export interface GroupSwipeOptions {
  /** The scrolling Home list: a swipe may start here, away from the left
   *  edge. */
  listRef: RefObject<HTMLElement | null>;
  /** The group bar: a swipe may start anywhere on it. */
  barRef: RefObject<HTMLElement | null>;
  /** What slides (the Home list's content). */
  slideRef: RefObject<HTMLElement | null>;
  /** Listeners attach while true (the Home tab on screen). */
  active: boolean;
  /** Changes when the list or bar element may have been swapped (they
   *  re-attach). */
  rebindKey?: string;
  /** Read at each touch start: nothing on top, not searching, not
   *  rearranging, more than one group. */
  canStart: () => boolean;
  /** Is there a group before / after the current one? (No wrap.) */
  neighbours: () => { prev: boolean; next: boolean };
  /** A committed swipe: select the group that way. */
  onCommit: (direction: GroupSwipeDirection) => void;
}

export function useGroupSwipe(opts: GroupSwipeOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const list = opts.listRef.current;
    const bar = opts.barRef.current;
    if (!opts.active || (!list && !bar)) return;
    let phase: GroupSwipePhase | null = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let width = 1;
    let can = { prev: false, next: false };
    let samples: { t: number; x: number }[] = [];
    let busy = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(fn, ms));
    };

    const slide = () => optsRef.current.slideRef.current;
    const place = (px: number, ms = 0) => {
      const el = slide();
      if (!el) return;
      el.style.transition = ms > 0 ? `transform ${ms}ms ${GLIDE_EASE}` : "none";
      el.style.transform = px === 0 && ms === 0 ? "" : `translate3d(${px}px, 0, 0)`;
    };

    const start = (onBar: boolean) => (e: TouchEvent) => {
      phase = null;
      if (busy || e.touches.length !== 1) return;
      const o = optsRef.current;
      if (!o.canStart()) return;
      const t = e.touches[0];
      if (!canArmGroupSwipe(t.clientX, onBar)) return;
      const root = onBar ? bar : list;
      if (!onBar && chatterSwipeIgnores(e.target, root)) return;
      if (e.target instanceof Element && e.target.closest("[data-no-group-swipe]")) return;
      x0 = t.clientX;
      y0 = t.clientY;
      dx = 0;
      width = Math.max(1, (list ?? bar)?.clientWidth || window.innerWidth || 1);
      can = o.neighbours();
      samples = [{ t: e.timeStamp || Date.now(), x: x0 }];
      phase = "armed";
    };

    const move = (e: TouchEvent) => {
      if (!phase || phase === "rejected") return;
      const t = e.touches[0];
      if (!t) return;
      dx = t.clientX - x0;
      phase = groupSwipePhase(phase, dx, t.clientY - y0);
      if (phase !== "tracking") return;
      if (e.cancelable) e.preventDefault();
      samples.push({ t: e.timeStamp || Date.now(), x: t.clientX });
      if (samples.length > 20) samples.shift();
      place(groupSwipeOffset(dx, width, can));
      const progress = groupSwipeProgress(dx, width, can);
      useGroupSwipeStore.getState().set(progress > 0 ? { progress, direction: swipeDirection(dx) } : null);
    };

    const end = () => {
      if (phase !== "tracking") {
        phase = null;
        return;
      }
      phase = null;
      const v = velocityFromSamples(samples);
      const at = groupSwipeOffset(dx, width, can);
      const r = groupSwipeRelease(dx, v, width, can);
      busy = true;
      if (r.outcome === "cancel") {
        const ms = glideMs(Math.abs(at) / width);
        place(0, ms);
        useGroupSwipeStore.getState().set(null);
        later(() => {
          place(0);
          busy = false;
        }, ms);
        return;
      }
      // Out the way the finger went, switch, in from the other side.
      const out = r.direction === "next" ? -width : width;
      const msOut = glideMs(1 - Math.abs(at) / width);
      place(out, msOut);
      useGroupSwipeStore.getState().set({ progress: 1, direction: r.direction });
      later(() => {
        flushSync(() => optsRef.current.onCommit(r.direction));
        useGroupSwipeStore.getState().set(null);
        place(-out);
        // Read layout so the jump to the far side lands before the glide in.
        void slide()?.getBoundingClientRect();
        place(0, GLIDE_MIN_MS);
        later(() => {
          place(0);
          busy = false;
        }, GLIDE_MIN_MS);
      }, msOut);
    };

    const cancel = () => {
      if (phase === "tracking") {
        dx = 0;
        phase = "tracking";
        end();
      } else phase = null;
    };

    const bind = (el: HTMLElement | null, onBar: boolean) => {
      if (!el) return () => {};
      const s = start(onBar);
      el.addEventListener("touchstart", s, { passive: true });
      el.addEventListener("touchmove", move, { passive: false });
      el.addEventListener("touchend", end, { passive: true });
      el.addEventListener("touchcancel", cancel, { passive: true });
      return () => {
        el.removeEventListener("touchstart", s);
        el.removeEventListener("touchmove", move);
        el.removeEventListener("touchend", end);
        el.removeEventListener("touchcancel", cancel);
      };
    };
    const offList = bind(list, false);
    const offBar = bind(bar, true);
    return () => {
      offList();
      offBar();
      for (const t of timers) clearTimeout(t);
      place(0);
      useGroupSwipeStore.getState().set(null);
    };
  }, [opts.active, opts.rebindKey, opts.listRef, opts.barRef]);
}
