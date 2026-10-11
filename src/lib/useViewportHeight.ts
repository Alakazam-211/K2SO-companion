// Slice C2 — the ChatSession keyboard-height idiom, adapted for FIXED
// full-screen overlays (the project chat screen).
//
// iOS WKWebView never resizes the layout viewport when the keyboard
// opens (docs/ios-keyboard-layout.md); with native scrolling disabled,
// a composer view must SIZE ITSELF: the native injection fires a
// `k2-viewport-resize` CustomEvent (visualViewport resize where it
// works), and the view sets an explicit pixel height so the composer
// sits above the keyboard.
//
// Returns the height for a viewport-anchored (fixed, top:0) container:
// keyboard OPEN → the visible height above the keyboard; keyboard
// CLOSED → the full window height (safe areas are the container's own
// padding + the shared `.input-bar` bottom-inset CSS).
//
// Resume case (IMG_0844): the app comes back from the background with
// the composer still focused, iOS re-shows the keyboard and pans the
// page up to "reveal" the input (visualViewport.offsetTop ≈ keyboard
// height). No focusin fires (the input never lost focus) and the pan is
// a visualViewport `scroll`, not a `resize`, so nothing re-pinned the
// scroll: the fixed column slid up under the status bar with a black
// gap above the keyboard. So every re-measure:
//   - runs on visibilitychange / pageshow / window focus / resize,
//     visualViewport resize AND scroll, focus transitions, and the native
//     `k2-viewport-resize` / `k2-viewport-resync` pings;
//   - resets document scroll (`scrollTo(0,0)` + scrollingElement);
//   - re-reads the full (keyboard-closed) height instead of a mount-time
//     capture, which was stale if the screen mounted with the keyboard up;
//   - reports any `offsetTop` iOS refuses to give back, so a fixed
//     container can translate down by it (`useViewport().offsetTop`).
// One shared store: every mounted screen reads the same measurement and
// the listeners are installed once, coalesced to an animation frame.

import { useSyncExternalStore } from "react";

export type ViewportState = {
  /** Height for a fixed, top:0 container. */
  height: number;
  /** visualViewport.offsetTop still left after the scroll reset. A
   *  fixed container sets `top` to this so it tracks the visible area. */
  offsetTop: number;
};

/** A viewport this much shorter than the window = keyboard open (the
 *  ChatSession -100px heuristic). */
const KEYBOARD_SLOP = 100;
/** Re-measures after a focus change / resume: the keyboard animates in
 *  (and iOS pans the page) after the triggering event. */
const FOCUS_IN_DELAYS = [100, 300, 500];
const FOCUS_OUT_DELAYS = [100, 300];
const RESUME_DELAYS = [100, 300, 600];

/** The keyboard-closed height, read fresh. iOS does not shrink the layout
 *  viewport for the keyboard, so these stay full height while it is up;
 *  on a WebView that does shrink them, the visible height is right anyway. */
function fullHeight(): number {
  const de = typeof document !== "undefined" ? document.documentElement : null;
  return Math.max(window.innerHeight || 0, de?.clientHeight || 0);
}

function heightFor(visible: number): number {
  const full = fullHeight();
  return visible < full - KEYBOARD_SLOP ? visible : full;
}

function resetScroll(): void {
  try {
    // Unconditional: the keyboard pan can show only as
    // visualViewport.offsetTop with scrollY already 0.
    window.scrollTo(0, 0);
  } catch {
    /* jsdom: not implemented */
  }
  const se = typeof document !== "undefined" ? document.scrollingElement : null;
  if (se && se.scrollTop !== 0) se.scrollTop = 0;
}

let state: ViewportState = {
  height: typeof window !== "undefined" ? window.innerHeight : 0,
  offsetTop: 0,
};
const subscribers = new Set<() => void>();
let teardown: (() => void) | null = null;
let frame: number | null = null;
const timers = new Set<ReturnType<typeof setTimeout>>();

function set(next: ViewportState): void {
  if (next.height === state.height && next.offsetTop === state.offsetTop) return;
  state = next;
  for (const fn of [...subscribers]) fn();
}

/** Measure now: reset any page pan, then size to the visible height. */
function measure(): void {
  resetScroll();
  const vv = window.visualViewport;
  const visible = vv ? vv.height : window.innerHeight;
  const offsetTop = vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
  set({ height: heightFor(visible), offsetTop });
}

/** Coalesce bursts (keyboard animation fires resize + scroll per frame). */
function schedule(): void {
  if (frame !== null) return;
  const run = () => {
    frame = null;
    measure();
  };
  if (typeof requestAnimationFrame === "function") {
    frame = requestAnimationFrame(run) as unknown as number;
  } else {
    frame = setTimeout(run, 0) as unknown as number;
  }
}

function scheduleAfter(delays: number[]): void {
  schedule();
  for (const ms of delays) {
    const t = setTimeout(() => {
      timers.delete(t);
      schedule();
    }, ms);
    timers.add(t);
  }
}

function install(): () => void {
  const vv = window.visualViewport;
  const onCustom = (e: Event) => {
    const h = (e as CustomEvent).detail?.height;
    // The native height is authoritative now; still re-pin the scroll.
    if (typeof h === "number") set({ height: heightFor(h), offsetTop: state.offsetTop });
    schedule();
  };
  const onResync = () => scheduleAfter(RESUME_DELAYS);
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") scheduleAfter(RESUME_DELAYS);
  };
  const onFocusIn = () => scheduleAfter(FOCUS_IN_DELAYS);
  const onFocusOut = () => scheduleAfter(FOCUS_OUT_DELAYS);

  window.addEventListener("k2-viewport-resize", onCustom);
  window.addEventListener("k2-viewport-resync", onResync);
  window.addEventListener("pageshow", onResync);
  window.addEventListener("focus", onResync);
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule);

  return () => {
    window.removeEventListener("k2-viewport-resize", onCustom);
    window.removeEventListener("k2-viewport-resync", onResync);
    window.removeEventListener("pageshow", onResync);
    window.removeEventListener("focus", onResync);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (frame !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      clearTimeout(frame as unknown as ReturnType<typeof setTimeout>);
      frame = null;
    }
  };
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (!teardown) {
    teardown = install();
    measure();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && teardown) {
      teardown();
      teardown = null;
    }
  };
}

function getSnapshot(): ViewportState {
  return state;
}

/** Height + residual offsetTop for a fixed, viewport-anchored column. */
export function useViewport(): ViewportState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useViewportHeight(): number {
  return useViewport().height;
}

/** Tests only: drop listeners and re-read the window. */
export function __resetViewportForTests(): void {
  teardown?.();
  teardown = null;
  subscribers.clear();
  state = { height: window.innerHeight, offsetTop: 0 };
}
