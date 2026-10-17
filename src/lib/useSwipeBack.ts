// iOS-style left-edge swipe-back for the pushed sub-screens
// (FeedbackThread / ProjectChat / ProjectHtmlDocs): a touch starting
// within EDGE_ARM_PX of the LEFT viewport edge arms the gesture; a
// dominant-X rightward drag tracks the finger (the screen's fixed
// overlay root translates with it); releasing past the distance
// threshold — or with a rightward flick — fires `onBack()`, otherwise
// the screen springs home. All the decisions are pure functions in
// swipeBack.ts (node-tested); this hook is only the touch plumbing.
//
// What it deliberately does NOT fight:
//   - Vertical scrolling: dominant-Y movement rejects the touch before
//     tracking starts (nextPhase), and preventDefault only fires once
//     tracking — so the screens' inner overflow scrollers keep their
//     native momentum.
//   - The docs viewer's iframe: touch events inside an iframe go to the
//     iframe's OWN document and never reach these listeners, so with a
//     doc open the swipe must start on chrome outside the iframe (the
//     header) — the list screen and the other pages arm anywhere on the
//     edge. (Not worth an edge-strip overlay: it would eat the left
//     sliver of wide dashboards' own panning.)
//   - Bottom sheets: screens pass `enabled: false` while one is open
//     (FeedbackThread's TicketSheet) so a sheet drag can't drag the
//     thread behind it. `enabled` may also be a getter, read at each
//     touch start — Zen's thread and open ticket pass their androidBack
//     "am I the topmost layer?" so any sheet, drawer or menu above the
//     screen wins.
//   - `onDragChange(true)` fires when the screen starts following the
//     finger and `(false)` once it has settled (sprung home, or just
//     before `onBack`) — Zen uses it to show the list underneath.
//
// Usage: `const swipeRef = useSwipeBack(onBack, { enabled })`, attached
// to the screen's OUTER fixed-overlay div (the `fixed inset-0` root
// those screens already have — a clean transform target that leaves
// their internal keyboard/scroll machinery alone). Completion blurs the
// focused element first so an open keyboard doesn't survive the pop.

import { useEffect, useRef, type RefObject } from "react";
import {
  canArm,
  dragOffset,
  nextPhase,
  shouldComplete,
  velocityFromSamples,
  type SwipePhase,
} from "./swipeBack";

/** Drop move samples older than the velocity window needs (bounded). */
const MAX_SAMPLES = 20;

export function useSwipeBack(
  onBack: () => void,
  opts: {
    enabled?: boolean | (() => boolean);
    onDragChange?: (dragging: boolean) => void;
  } = {}
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  // Latest callbacks/flag in refs so the touch listeners bind ONCE — a
  // mid-gesture re-render (live refetches) can't tear the gesture down.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const enabledRef = useRef(opts.enabled);
  enabledRef.current = opts.enabled;
  const onDragRef = useRef(opts.onDragChange);
  onDragRef.current = opts.onDragChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // null = this touch never armed (or already ended).
    let phase: SwipePhase | null = null;
    let startX = 0;
    let startY = 0;
    let samples: Array<{ t: number; x: number }> = [];
    // Whether onDragChange(true) is outstanding (spring-back clears it
    // after its transition; unmount clears it too).
    let dragging = false;
    let settleTimer: number | undefined;
    const settle = (): void => {
      window.clearTimeout(settleTimer);
      settleTimer = undefined;
      if (!dragging) return;
      dragging = false;
      onDragRef.current?.(false);
    };
    const isEnabled = (): boolean => {
      const e = enabledRef.current;
      return typeof e === "function" ? e() : e !== false;
    };

    const setDrag = (px: number): void => {
      el.style.transition = "";
      el.style.transform = px > 0 ? `translateX(${px}px)` : "";
      // Depth cue over whatever sits underneath the overlay.
      el.style.boxShadow = px > 0 ? "-12px 0 24px var(--shadow)" : "";
    };
    const resetDrag = (): void => {
      el.style.transition = "";
      el.style.transform = "";
      el.style.boxShadow = "";
    };
    const springBack = (): void => {
      el.style.transition = "transform 200ms ease-out, box-shadow 200ms ease-out";
      el.style.transform = "";
      el.style.boxShadow = "";
      settleTimer = window.setTimeout(() => {
        el.style.transition = "";
        settle();
      }, 250);
    };

    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) {
        phase = null; // a second finger cancels any armed gesture
        return;
      }
      const t = e.touches[0];
      phase = canArm(t.clientX, isEnabled()) ? "armed" : null;
      if (phase === null) return;
      startX = t.clientX;
      startY = t.clientY;
      samples = [{ t: e.timeStamp, x: t.clientX }];
    };

    const onTouchMove = (e: TouchEvent): void => {
      if (phase !== "armed" && phase !== "tracking") return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      phase = nextPhase(phase, dx, t.clientY - startY);
      if (phase !== "tracking") return;
      // Ours now: stop the inner scrollers/selection for the rest of
      // the touch (listener is passive: false for exactly this).
      e.preventDefault();
      window.clearTimeout(settleTimer); // re-grabbed mid spring-back
      if (!dragging) {
        dragging = true;
        onDragRef.current?.(true);
      }
      samples.push({ t: e.timeStamp, x: t.clientX });
      if (samples.length > MAX_SAMPLES) samples.shift();
      setDrag(dragOffset(dx));
    };

    const onTouchEnd = (e: TouchEvent): void => {
      const wasTracking = phase === "tracking";
      phase = null;
      if (!wasTracking) return;
      const endX = e.changedTouches[0]?.clientX ?? startX;
      samples.push({ t: e.timeStamp, x: endX });
      if (shouldComplete(dragOffset(endX - startX), velocityFromSamples(samples), window.innerWidth)) {
        // Keyboard must not survive the pop.
        (document.activeElement as HTMLElement | null)?.blur?.();
        resetDrag(); // the docs viewer stays mounted (openDoc close)
        settle();
        onBackRef.current();
      } else {
        springBack();
      }
    };

    const onTouchCancel = (): void => {
      if (phase === "tracking") springBack();
      phase = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchCancel);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      resetDrag();
      settle();
    };
  }, []);

  return ref;
}
