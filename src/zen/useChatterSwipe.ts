// The plumbing for chatterSwipe.ts: touch listeners on the chat column,
// the panel following the finger (compositor-only transforms), and the
// release animation to wherever it settles. Chatter's panel is mounted
// only while it is open or on its way (it polls the server while mounted).

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { velocityFromSamples } from "../lib/swipeBack";
import {
  CHATTER_CLOSED_TRANSFORM,
  CHATTER_OPEN_TRANSFORM,
  CHATTER_SLIDE_MS,
  CHATTER_TRANSITION,
  chatterOffset,
  chatterPhase,
  chatterSettlesOpen,
  chatterSwipeIgnores,
  type ChatterPhase,
} from "./chatterSwipe";

export type ChatterSwipe = {
  open: boolean;
  /** The panel is in the DOM (open, dragging, or sliding away). */
  mounted: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  close: () => void;
};

/**
 * `rootRef`: the chat column the swipe starts on. `canOpen()` / `canClose()`
 * are read at each touch start (nothing else on top; not a project chat).
 * `resetKey`: another chat closes Chatter at once.
 */
export function useChatterSwipe(
  rootRef: RefObject<HTMLElement | null>,
  opts: { canOpen: () => boolean; canClose: () => boolean; resetKey: string; /** The column is on screen (listeners attach). */ active: boolean }
): ChatterSwipe {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settle = useCallback((next: boolean) => {
    const panel = panelRef.current;
    if (panel) {
      panel.style.transition = CHATTER_TRANSITION;
      panel.style.transform = next ? CHATTER_OPEN_TRANSFORM : CHATTER_CLOSED_TRANSFORM;
    }
    if (unmountTimer.current) clearTimeout(unmountTimer.current);
    unmountTimer.current = null;
    setOpen(next);
    if (next) setMounted(true);
    else unmountTimer.current = setTimeout(() => setMounted(false), CHATTER_SLIDE_MS + 40);
  }, []);

  const close = useCallback(() => settle(false), [settle]);

  // Another chat: Chatter is closed there.
  useEffect(() => {
    if (unmountTimer.current) clearTimeout(unmountTimer.current);
    unmountTimer.current = null;
    setOpen(false);
    setMounted(false);
  }, [opts.resetKey]);

  useEffect(() => () => {
    if (unmountTimer.current) clearTimeout(unmountTimer.current);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let phase: ChatterPhase | null = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let startOpen = false;
    let width = 1;
    let samples: { t: number; x: number }[] = [];

    const start = (e: TouchEvent) => {
      phase = null;
      if (e.touches.length !== 1) return;
      startOpen = openRef.current;
      const allowed = startOpen ? optsRef.current.canClose() : optsRef.current.canOpen();
      if (!allowed || chatterSwipeIgnores(e.target, root)) return;
      const t = e.touches[0];
      x0 = t.clientX;
      y0 = t.clientY;
      dx = 0;
      width = Math.max(1, root.clientWidth || window.innerWidth || 1);
      samples = [{ t: e.timeStamp || Date.now(), x: x0 }];
      phase = "armed";
    };

    const move = (e: TouchEvent) => {
      if (!phase || phase === "rejected") return;
      const t = e.touches[0];
      if (!t) return;
      dx = t.clientX - x0;
      const dy = t.clientY - y0;
      const was = phase;
      phase = chatterPhase(phase, dx, dy, startOpen);
      if (phase !== "tracking") return;
      if (e.cancelable) e.preventDefault();
      samples.push({ t: e.timeStamp || Date.now(), x: t.clientX });
      if (samples.length > 20) samples.shift();
      if (was === "armed") {
        // Starting to open: mount the panel off screen first; the keyboard
        // goes down with the Thread behind it.
        if (!startOpen) {
          if (unmountTimer.current) clearTimeout(unmountTimer.current);
          unmountTimer.current = null;
          flushSync(() => setMounted(true));
          const active = document.activeElement;
          if (active instanceof HTMLElement && root.contains(active)) active.blur();
        }
      }
      const panel = panelRef.current;
      if (!panel) return;
      panel.style.transition = "none";
      panel.style.transform = `translateX(${chatterOffset(dx, width, startOpen)}px)`;
    };

    const end = () => {
      if (phase !== "tracking") {
        phase = null;
        return;
      }
      phase = null;
      const v = velocityFromSamples(samples);
      settle(chatterSettlesOpen(dx, v, width, startOpen));
    };

    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end, { passive: true });
    root.addEventListener("touchcancel", end, { passive: true });
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", end);
    };
  }, [rootRef, settle, opts.active]);

  return { open, mounted, panelRef, close };
}
