// iOS-style left-edge swipe-back for the pushed sub-screens
// (FeedbackThread / ProjectChat / ProjectHtmlDocs): a touch starting
// within EDGE_ARM_PX of the LEFT viewport edge arms the gesture; a
// dominant-X rightward drag tracks the finger (the screen's fixed
// overlay root translates with it). On release (UINavigationController's
// interactive pop): past the distance threshold — or on a rightward
// flick, and not while flicking back left — the screen ANIMATES the rest
// of the way off to the right at the finger's speed and only then fires
// `onBack()`; otherwise it animates home to 0. The navigation therefore
// happens with the outgoing screen already off screen, so nothing snaps.
// All the decisions (threshold, duration/curve, underlay parallax) are
// pure functions in swipeBack.ts; this hook is only the plumbing.
// Compositor-only: transform / opacity transitions, no layout per frame.
// Reduced motion: a short fade instead of the remaining slide.
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
//     finger and `(false)` once it has settled (sprung home, or right
//     after `onBack`) — Zen uses it to show the list underneath.
//   - `underlay` (optional getter, read when tracking starts) is the
//     screen a back lands on: it trails the drag with a parallax offset
//     and a dim (opacity over black) and finishes both with the release
//     animation; its inline transform/opacity are cleared afterwards.
//     Pass the moving surface itself (e.g. a `position: fixed` screen
//     root), never an ANCESTOR of fixed content: a transform (or
//     will-change) makes it their containing block, so they would sit
//     somewhere else during the slide and jump the frame it clears. The
//     animation ends exactly at identity (no transform, opacity 1), so
//     its last frame is the screen's first frame after Back.
//
// Usage: `const swipeRef = useSwipeBack(onBack, { enabled })`, attached
// to the screen's OUTER fixed-overlay div (the `fixed inset-0` root
// those screens already have — a clean transform target that leaves
// their internal keyboard/scroll machinery alone).
//
// The keyboard: iOS moves its keyboard sideways only in its own native
// transitions, never with a page's CSS swipe (4.0.3 behaved the same), so
// a keyboard left up would sit still while the screen slides away. When
// the screen starts following the finger, a focused text field inside it
// is blurred: the keyboard drops as the screen slides. A swipe that
// springs home focuses that field again with its keyboard
// (`focusWithKeyboard`: iOS shows a keyboard for a script's focus only
// when the shell allows it); a completing one leaves it closed. Touches
// are ignored
// while a release animation runs.

import { useEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  REDUCED_MOTION_FADE_MS,
  canArm,
  dragOffset,
  nextPhase,
  releaseAnimation,
  shouldComplete,
  underlayFrame,
  velocityFromSamples,
  type SwipePhase,
} from "./swipeBack";
import { kbMark } from "./kbDiag";
import { focusWithKeyboard } from "./nativeKeyboard";

/** Drop move samples older than the velocity window needs (bounded). */
const MAX_SAMPLES = 20;

/** A field that raises the keyboard. */
function isTextField(n: Element | null): n is HTMLElement {
  if (!(n instanceof HTMLElement)) return false;
  if (n instanceof HTMLTextAreaElement) return true;
  if (n instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image", "hidden"].includes(n.type);
  }
  return n.isContentEditable;
}

/** Slack past a transition's duration before its timer finishes it
 *  anyway (transitionend can be skipped — hidden tab, interrupted). */
const TRANSITION_SLACK_MS = 60;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

export function useSwipeBack(
  onBack: () => void,
  opts: {
    enabled?: boolean | (() => boolean);
    onDragChange?: (dragging: boolean) => void;
    /** The screen underneath (where Back lands): parallax + dim. */
    underlay?: () => HTMLElement | null;
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
  const underlayRef = useRef(opts.underlay);
  underlayRef.current = opts.underlay;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // null = this touch never armed (or already ended).
    let phase: SwipePhase | null = null;
    let startX = 0;
    let startY = 0;
    let samples: Array<{ t: number; x: number }> = [];
    // Current translateX of the screen (px).
    let offset = 0;
    // Whether onDragChange(true) is outstanding (cleared once the
    // release animation settles; unmount clears it too).
    let dragging = false;
    // The underlay captured when tracking started (null = none).
    let under: HTMLElement | null = null;
    // A running release animation: its end callback, the property whose
    // transitionend finishes it (null = timers only), and its timers.
    let anim: { done: () => void; endsOn: string | null } | null = null;
    let timers: number[] = [];
    // The field this drag blurred (its keyboard dropped), for a cancel.
    let typed: HTMLElement | null = null;

    const width = (): number => window.innerWidth || el.getBoundingClientRect().width || 1;
    const isEnabled = (): boolean => {
      const e = enabledRef.current;
      return typeof e === "function" ? e() : e !== false;
    };
    const later = (fn: () => void, ms: number): void => {
      timers.push(window.setTimeout(fn, ms));
    };
    const clearTimers = (): void => {
      for (const t of timers) window.clearTimeout(t);
      timers = [];
    };
    const settle = (): void => {
      if (!dragging) return;
      dragging = false;
      onDragRef.current?.(false);
    };

    const paintUnderlay = (px: number): void => {
      if (!under) return;
      const f = underlayFrame(px, width());
      under.style.transform = f.x ? `translateX(${f.x}px)` : "";
      under.style.opacity = f.opacity < 1 ? String(f.opacity) : "";
    };
    const setDrag = (px: number): void => {
      offset = px;
      el.style.transition = "";
      el.style.willChange = "transform";
      el.style.transform = px > 0 ? `translateX(${px}px)` : "";
      // Depth cue over whatever sits underneath the overlay (painted
      // once; the layer moves on the compositor).
      el.style.boxShadow = px > 0 ? "-12px 0 24px var(--shadow)" : "";
      if (under) under.style.transition = "";
      paintUnderlay(px);
    };
    const clearUnderlay = (): void => {
      if (!under) return;
      under.style.transition = "";
      under.style.transform = "";
      under.style.opacity = "";
      under.style.willChange = "";
      under = null;
    };
    const clearScreen = (): void => {
      offset = 0;
      el.style.transition = "";
      el.style.transform = "";
      el.style.boxShadow = "";
      el.style.willChange = "";
      el.style.opacity = "";
      el.style.pointerEvents = "";
    };

    const finishAnim = (): void => {
      const a = anim;
      if (!a) return;
      anim = null;
      clearTimers();
      a.done();
    };
    const onTransitionEnd = (e: TransitionEvent): void => {
      if (anim?.endsOn && e.target === el && e.propertyName === anim.endsOn) finishAnim();
    };

    /** Carry the screen from `offset` to `to` (0 = home, width = gone),
     *  then run `done`. Transform transitions only. */
    const animateTo = (to: number, velocity: number, done: () => void): void => {
      const { durationMs, easing } = releaseAnimation(offset, to, velocity);
      anim = { done, endsOn: "transform" };
      el.style.transition = `transform ${durationMs}ms ${easing}`;
      el.style.transform = to > 0 ? `translateX(${to}px)` : "";
      offset = to;
      if (under) {
        under.style.transition = `transform ${durationMs}ms ${easing}, opacity ${durationMs}ms ${easing}`;
        paintUnderlay(to);
      }
      later(finishAnim, durationMs + TRANSITION_SLACK_MS);
    };

    /** Released past the threshold: the rest of the slide, then Back. */
    const complete = (velocity: number): void => {
      // Keyboard must not survive the pop: it dismisses as we slide.
      kbMark("swipe release");
      typed = null;
      (document.activeElement as HTMLElement | null)?.blur?.();
      // No taps on a screen that is leaving.
      el.style.pointerEvents = "none";
      const done = (): void => {
        // Navigate with the screen already off screen. Synchronously, so
        // when we tidy up below the new screen has already committed (a
        // screen that STAYS mounted — the docs viewer's list, the next
        // open file — then shows at home instead of off to the right).
        kbMark("swipe done");
        flushSync(() => onBackRef.current());
        settle();
        clearUnderlay();
        if (el.isConnected) clearScreen();
      };
      if (prefersReducedMotion()) {
        // No further slide: fade out where it is, the underlay settles.
        anim = { done, endsOn: null };
        el.style.transition = `opacity ${REDUCED_MOTION_FADE_MS}ms linear`;
        el.style.opacity = "0";
        if (under) {
          under.style.transition = `transform ${REDUCED_MOTION_FADE_MS}ms linear, opacity ${REDUCED_MOTION_FADE_MS}ms linear`;
          paintUnderlay(width());
        }
        later(finishAnim, REDUCED_MOTION_FADE_MS);
        return;
      }
      animateTo(width(), velocity, done);
    };

    /** Released short (or interrupted): back home to 0. */
    const cancel = (velocity: number): void => {
      // The field the drag blurred gets its keyboard back as the screen
      // returns.
      const field = typed;
      typed = null;
      if (field?.isConnected) focusWithKeyboard(field);
      const done = (): void => {
        clearScreen();
        clearUnderlay();
        settle();
      };
      if (prefersReducedMotion()) {
        // Fade out, jump home while invisible, fade back in.
        const half = Math.round(REDUCED_MOTION_FADE_MS / 2);
        anim = { done, endsOn: null };
        el.style.transition = `opacity ${half}ms linear`;
        el.style.opacity = "0";
        later(() => {
          el.style.transition = "";
          el.style.transform = "";
          el.style.boxShadow = "";
          offset = 0;
          clearUnderlay();
          // Next frame so the jump commits before the fade-in starts.
          later(() => {
            el.style.transition = `opacity ${half}ms linear`;
            el.style.opacity = "";
            later(finishAnim, half);
          }, 16);
        }, half);
        return;
      }
      animateTo(0, velocity, done);
    };

    const onTouchStart = (e: TouchEvent): void => {
      // A release animation owns the screen until it ends.
      if (anim || e.touches.length !== 1) {
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
      if (!dragging) {
        dragging = true;
        kbMark("swipe start");
        // The keyboard can't follow the slide: drop it now.
        const a = document.activeElement;
        if (isTextField(a) && el.contains(a)) {
          typed = a;
          a.blur();
        }
        onDragRef.current?.(true);
        under = underlayRef.current?.() ?? null;
        if (under) under.style.willChange = "transform, opacity";
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
      const velocity = velocityFromSamples(samples);
      const dx = dragOffset(endX - startX);
      if (dx !== offset) setDrag(dx);
      if (shouldComplete(dx, velocity, width())) complete(velocity);
      else cancel(velocity);
    };

    const onTouchCancel = (): void => {
      if (phase === "tracking") cancel(0);
      phase = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchCancel);
    el.addEventListener("transitionend", onTransitionEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("transitionend", onTransitionEnd);
      anim = null;
      clearTimers();
      clearScreen();
      clearUnderlay();
      settle();
    };
  }, []);

  return ref;
}
