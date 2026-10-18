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
//
// Keyboard motion (iOS): the native shell forwards UIKeyboardWill{Show,
// Hide,ChangeFrame} (src-tauri/src/lib.rs → `window.__k2KeyboardWill` →
// `k2-keyboard-will`) with the keyboard's overlap, animation duration and
// curve. The store jumps straight to the height the keyboard is heading
// for and publishes `motion` ({ms, easing, elapsed}); a screen that sets
// `transition: viewportTransition(motion)` glides its column with the
// keyboard instead of stepping through WebKit's visualViewport updates.
// Until the keyboard lands, measurements may reset the page pan and
// report offsetTop but do not move the height (they would fight the
// glide); once it has, a normal re-measure settles it. Reduced motion:
// the same final height at once, no motion. Android never sends the
// event: the visualViewport path is unchanged there.
//
// Interactive dismiss (iOS, iMessage-style): dragging a native-scrolling
// list down into the keyboard moves it with the finger. The shell tracks
// the keyboard's top every frame and calls `window.__k2KeyboardTrack(
// overlap)` (→ `k2-keyboard-track`). That is too often for a React render
// (the Thread re-renders every message), so the store writes the height
// straight onto the columns registered with `useViewportTrackRef`, with
// no transition, and only flips `interactive` (one render at the start)
// so the Thread stops re-pinning under the finger. Everyone else keeps
// the held height (the terminal does not re-fit every frame). On release
// iOS posts WillHide / WillShow with the rest of the animation: the store
// writes that target + transition onto the same columns (so it starts
// from the dragged height, also when the target equals the old height —
// a spring back) and publishes it as usual.

import { useRef, useSyncExternalStore } from "react";

/** The iOS keyboard is animating `height` to its current value. */
export type ViewportMotion = {
  /** Full keyboard animation duration (ms). */
  ms: number;
  /** CSS timing function matching the keyboard's curve. */
  easing: string;
  /** How far into the animation the page heard about it (ms): the
   *  bridge hop. A negative transition-delay starts mid-curve, in step. */
  elapsed: number;
};

export type ViewportState = {
  /** Height for a fixed, top:0 container. */
  height: number;
  /** visualViewport.offsetTop still left after the scroll reset. A
   *  fixed container sets `top` to this so it tracks the visible area. */
  offsetTop: number;
  /** Set while the keyboard animates the height (iOS). */
  motion: ViewportMotion | null;
  /** The keyboard follows a finger (interactive dismiss, iOS). `height`
   *  holds its pre-drag value; tracked columns are sized directly. */
  interactive: boolean;
};

/** What the native shell sends on UIKeyboardWill{Show,Hide,ChangeFrame}. */
export type KeyboardWill = {
  /** Keyboard overlap of the web view's bottom (px); 0 when hiding. */
  height: number;
  /** Animation duration (ms). */
  duration: number;
  /** UIViewAnimationCurve (7 = the keyboard's own curve). */
  curve?: number;
  show: boolean;
  /** Date.now() when UIKit posted it. */
  at?: number;
};

/** UIKit's private keyboard curve (UIViewAnimationCurve 7). */
export const KEYBOARD_EASING = "cubic-bezier(0.38, 0.7, 0.125, 1)";
/** The keyboard's usual duration (ms), until the shell reports one. */
export const KEYBOARD_MS = 250;
/** After the keyboard's animation: when the re-measure takes over. */
const SETTLE_SLOP_MS = 60;

/** CSS timing function for a UIViewAnimationCurve. */
export function keyboardEasing(curve?: number): string {
  switch (curve) {
    case 0:
      return "ease-in-out";
    case 1:
      return "ease-in";
    case 2:
      return "ease-out";
    case 3:
      return "linear";
    default:
      return KEYBOARD_EASING;
  }
}

/** A `transition` for a keyboard-driven change of `prop` (none at rest). */
export function viewportTransition(
  motion: ViewportMotion | null,
  prop = "height"
): string | undefined {
  if (!motion || motion.ms <= 0) return undefined;
  const delay = motion.elapsed > 0 ? ` -${Math.round(motion.elapsed)}ms` : "";
  return `${prop} ${Math.round(motion.ms)}ms ${motion.easing}${delay}`;
}

function reducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

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
  motion: null,
  interactive: false,
};
const subscribers = new Set<() => void>();
let teardown: (() => void) | null = null;
let frame: number | null = null;
const timers = new Set<ReturnType<typeof setTimeout>>();
/** The keyboard is animating: hold the height it is heading for. */
let animating = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** Last keyboard duration the shell reported (ms). */
let keyboardMs = KEYBOARD_MS;
/** Columns sized per frame during an interactive dismiss. */
const trackEls = new Set<HTMLElement>();
/** The height last written onto them while interactive. */
let trackedHeight = 0;

function writeTracked(height: number, transition: string): void {
  for (const el of trackEls) {
    el.style.transition = transition;
    el.style.height = `${height}px`;
  }
}

/** Callback ref for a viewport-sized column that should follow the
 *  keyboard under the finger (interactive dismiss) without re-rendering.
 *  Stable across renders. */
export function trackViewportElement(el: HTMLElement | null, prev: HTMLElement | null): void {
  if (prev && prev !== el) trackEls.delete(prev);
  if (el) trackEls.add(el);
}

export function useViewportTrackRef(): (el: HTMLElement | null) => void {
  const cb = useRef<((el: HTMLElement | null) => void) | null>(null);
  if (!cb.current) {
    let current: HTMLElement | null = null;
    cb.current = (el) => {
      trackViewportElement(el, current);
      current = el;
    };
  }
  return cb.current;
}

/** Duration (ms) of the keyboard's animation, as last reported. Screens
 *  easing something with the keyboard (the composer's bottom gap) use it. */
export function keyboardMotionMs(): number {
  return keyboardMs;
}

function set(next: ViewportState): void {
  if (
    next.height === state.height &&
    next.offsetTop === state.offsetTop &&
    next.motion === state.motion &&
    next.interactive === state.interactive
  ) {
    return;
  }
  state = next;
  for (const fn of [...subscribers]) fn();
}

/** Measure now: reset any page pan, then size to the visible height
 *  (held while the keyboard animates). */
function measure(): void {
  resetScroll();
  const vv = window.visualViewport;
  const visible = vv ? vv.height : window.innerHeight;
  const offsetTop = vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
  if (animating || state.interactive) {
    set({ ...state, offsetTop });
    return;
  }
  set({ height: heightFor(visible), offsetTop, motion: null, interactive: false });
}

/** The keyboard's top under the finger (interactive dismiss): size the
 *  tracked columns now, unanimated; no React render per frame. */
function keyboardTrack(overlap: number): void {
  if (!Number.isFinite(overlap)) return;
  const full = fullHeight();
  // No KEYBOARD_SLOP here: the finger moves it continuously to 0.
  const h = Math.round(full - Math.min(full, Math.max(0, overlap)));
  clearSettle();
  animating = false;
  trackedHeight = h;
  writeTracked(h, "none");
  if (!state.interactive) set({ ...state, motion: null, interactive: true });
}

/** A native resync (keyboard did show / hide) with no Will* after a drag:
 *  hand the columns back to the published height. */
function endInteractive(): void {
  if (!state.interactive) return;
  writeTracked(state.height, "");
  set({ ...state, interactive: false });
}

function clearSettle(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
}

/** UIKeyboardWill{Show,Hide,ChangeFrame}: go to where the keyboard is
 *  heading, with its timing, and hold there until it lands. */
function keyboardWill(will: KeyboardWill): void {
  const full = fullHeight();
  const overlap =
    will.show && Number.isFinite(will.height) ? Math.min(full, Math.max(0, will.height)) : 0;
  const target = heightFor(full - overlap);
  const ms = Number.isFinite(will.duration) ? Math.max(0, will.duration) : 0;
  if (ms > 0) {
    keyboardMs = ms;
    try {
      const root = document.documentElement.style;
      root.setProperty("--k2-kb-ms", `${Math.round(ms)}ms`);
      root.setProperty("--k2-kb-ease", keyboardEasing(will.curve));
    } catch {
      /* no document */
    }
  }
  // WillChangeFrame + WillShow/Hide both arrive for one animation.
  if (animating && target === state.height) return;
  // After a drag the columns sit at the tracked height, not state.height.
  const wasInteractive = state.interactive;
  const from = wasInteractive ? trackedHeight : state.height;
  const lag =
    typeof will.at === "number" && Number.isFinite(will.at)
      ? Math.min(ms, Math.max(0, Date.now() - will.at))
      : 0;
  const remaining = ms - lag;
  const motion: ViewportMotion | null =
    remaining > 0 && target !== from && !reducedMotion()
      ? { ms, easing: keyboardEasing(will.curve), elapsed: lag }
      : null;
  resetScroll();
  animating = true;
  clearSettle();
  settleTimer = setTimeout(() => {
    settleTimer = null;
    animating = false;
    measure();
  }, remaining + SETTLE_SLOP_MS);
  // Released: finish from where the finger left it (also a spring back
  // to the old height, which React alone would not rewrite).
  if (wasInteractive) writeTracked(target, viewportTransition(motion) ?? "");
  set({ height: target, offsetTop: state.offsetTop, motion, interactive: false });
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
    // The native height is authoritative now (unless the keyboard is
    // still animating to a known one); still re-pin the scroll.
    if (typeof h === "number" && !animating && !state.interactive) {
      set({ height: heightFor(h), offsetTop: state.offsetTop, motion: null, interactive: false });
    }
    schedule();
  };
  const onTrack = (e: Event) => {
    const h = (e as CustomEvent<{ height?: number }>).detail?.height;
    if (typeof h === "number") keyboardTrack(h);
  };
  const onWill = (e: Event) => {
    const d = (e as CustomEvent<KeyboardWill>).detail;
    if (d && typeof d === "object") keyboardWill(d);
  };
  // Native Did* / app-active pings (and pageshow / focus).
  const onResync = () => {
    endInteractive();
    scheduleAfter(RESUME_DELAYS);
  };
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") scheduleAfter(RESUME_DELAYS);
  };
  const onFocusIn = () => scheduleAfter(FOCUS_IN_DELAYS);
  const onFocusOut = () => scheduleAfter(FOCUS_OUT_DELAYS);

  window.addEventListener("k2-viewport-resize", onCustom);
  window.addEventListener("k2-keyboard-will", onWill);
  window.addEventListener("k2-keyboard-track", onTrack);
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
    window.removeEventListener("k2-keyboard-will", onWill);
    window.removeEventListener("k2-keyboard-track", onTrack);
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
    clearSettle();
    animating = false;
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

// The shell's hook (lib.rs also injects it; this survives a page reload).
if (typeof window !== "undefined") {
  const w = window as unknown as {
    __k2KeyboardWill?: (d: KeyboardWill) => void;
    __k2KeyboardTrack?: (overlap: number) => void;
  };
  if (typeof w.__k2KeyboardWill !== "function") {
    w.__k2KeyboardWill = (d: KeyboardWill) => {
      window.dispatchEvent(new CustomEvent("k2-keyboard-will", { detail: d }));
    };
  }
  if (typeof w.__k2KeyboardTrack !== "function") {
    w.__k2KeyboardTrack = (overlap: number) => {
      window.dispatchEvent(new CustomEvent("k2-keyboard-track", { detail: { height: overlap } }));
    };
  }
}

/** Height + residual offsetTop (+ keyboard motion) for a fixed,
 *  viewport-anchored column. */
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
  clearSettle();
  animating = false;
  keyboardMs = KEYBOARD_MS;
  trackEls.clear();
  trackedHeight = 0;
  state = { height: window.innerHeight, offsetTop: 0, motion: null, interactive: false };
}
