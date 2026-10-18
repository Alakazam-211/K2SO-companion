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
// for and publishes `motion` ({ms, easing, elapsed, from, to}). The
// Thread plays it on the compositor (ThreadPane's FLIP: final layout +
// a transform eased on the keyboard's own duration and curve, no
// per-frame layout); simpler screens may still `transition:
// viewportTransition(motion)` their height (the chats list).
// Until the keyboard lands, measurements may reset the page pan and
// report offsetTop but do not move the height (they would fight the
// glide); once it has, a normal re-measure settles it. Reduced motion:
// the same final height at once, no motion. Android never sends the
// event: the visualViewport path is unchanged there.
//
// Interactive dismiss (iOS, iMessage-style): dragging the native-scrolling
// Thread list down into the keyboard moves the keyboard with the finger,
// and the list scrolls with the same finger in the UI process, in the
// same frame. Anything the page does per frame (IPC + rAF) trails it, so
// the composer is not moved per frame at all: at the moment the keyboard
// starts to follow the finger the Thread puts a stand-in of the composer
// INTO the scrolled content (src/zen/keyboardDragDock.ts) and native
// scrolling carries it in lockstep with the keyboard. This store's part:
//   - `beginKeyboardDrag()`: once, columns (`useViewportTrackRef`) go to
//     full height and pads (`useViewportPadRef`, the scroller's tail) grow
//     by the keyboard's height — the scroller reaches the screen bottom
//     (the stand-in is not clipped) and nothing on screen moves;
//     `interactive` flips (one render) so the Thread stops re-pinning;
//   - the shell samples the keyboard only during a dismiss drag (a pan
//     that began with the keyboard up, and only once the keyboard has left
//     its rest: a few frames, then one ~100ms later):
//     `window.__k2KeyboardSample({top, scrollY, t})` (→ `k2-keyboard-
//     sample`) goes to the registered drag handler, which uses it to put
//     the stand-in exactly on the keyboard and as a fallback trigger;
//     (`__k2KeyboardTrack(overlap)`, the older shell's "started moving"
//     signal, still works as a fallback trigger);
//   - on release iOS posts WillHide / WillShow: the stand-in goes, pads
//     clear, and the motion starts at the keyboard's begin frame (else
//     the stand-in's bottom): hide — the columns go final at once and the
//     Thread FLIPs the composer down from there; spring back — the columns
//     hold the dragged height while the composer plays up, then commit.
//     No height transition. Scroll momentum carries on without it.

import { useRef, useSyncExternalStore } from "react";

/** The iOS keyboard is animating: the keyboard's top (as a column
 *  height) goes `from` → `to`. Hide: `height` is already `to`; show:
 *  `height` is `to` too, but a screen that animates on the compositor
 *  (Zen's Thread, FLIP) keeps its column at `from` until the motion
 *  clears, so nothing is clipped while the keyboard rises. */
export type ViewportMotion = {
  /** Full keyboard animation duration (ms). */
  ms: number;
  /** CSS timing function matching the keyboard's curve. */
  easing: string;
  /** How far into the animation the page heard about it (ms): the
   *  bridge hop. A negative transition-delay starts mid-curve, in step. */
  elapsed: number;
  /** Column height (keyboard top) where the animation starts / ends. */
  from: number;
  to: number;
};

/** Wall-clock ms with sub-ms precision (performance.timeOrigin + now),
 *  to compare with the shell's timestamps; Date.now() as a fallback. */
export function nowEpochMs(): number {
  try {
    const o = performance.timeOrigin;
    if (typeof o === "number" && Number.isFinite(o) && o > 0) return o + performance.now();
  } catch {
    /* no performance */
  }
  return Date.now();
}

/** CSS transition for a FLIP transform play on the keyboard's timing. */
export function keyboardFlipTransition(motion: ViewportMotion): string {
  const delay = motion.elapsed > 0 ? ` -${Math.round(motion.elapsed * 10) / 10}ms` : "";
  return `transform ${Math.round(motion.ms)}ms ${motion.easing}${delay}`;
}

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
  /** The keyboard's top (viewport px) as the animation begins (its begin
   *  frame): after an interactive drag, where the finger left it. */
  fromTop?: number;
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
  const delay = motion.elapsed > 0 ? ` -${Math.round(motion.elapsed * 10) / 10}ms` : "";
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
/** Interactive dismiss: viewport-sized columns (full height while the
 *  finger drags the keyboard). */
const trackEls = new Set<HTMLElement>();
/** Scroller tails that keep the scroll range while the column is full. */
const padEls = new Set<HTMLElement>();
/** Last keyboard overlap the shell signalled (px). */
let latestOverlap = 0;

/** One reading from the shell during a dismiss drag, all in the same
 *  native frame: the keyboard's top (viewport px), the panning scroll
 *  view's contentOffset.y (null if unknown), wall-clock ms. */
export type KeyboardSample = { top: number; scrollY: number | null; t: number };

/** The screen whose composer rides an interactive dismiss (the Thread). */
export type KeyboardDragHandler = {
  /** A sample from the shell (only while a dismiss drag moves it). */
  keyboardSample(sample: KeyboardSample): void;
  /** The shell saw the keyboard start moving with no Will* (fallback
   *  trigger when touch events did not catch the crossing). `moved` is
   *  how far (px) it had gone when sampled. */
  keyboardMoved(moved: number): void;
  /** Viewport y (px) of the stand-in's bottom: where the keyboard is. */
  draggedBottom(): number | null;
  /** Drop the stand-in and show the real composer again. */
  detach(): void;
  /** A Will* release is handing off (before `draggedBottom`/`detach`);
   *  `keyboardTop` = the shell's begin frame, if known. */
  released?(keyboardTop: number | null): void;
};
let dragHandler: KeyboardDragHandler | null = null;

export function setKeyboardDragHandler(h: KeyboardDragHandler | null): void {
  dragHandler = h;
}

/** The keyboard's top (viewport px) while it is up, else null. */
export function keyboardTopNow(): number | null {
  const full = fullHeight();
  if (state.height >= full - KEYBOARD_SLOP) return null;
  return state.offsetTop + state.height;
}

/** The keyboard-closed height (px), read fresh. */
export function fullViewportHeight(): number {
  return fullHeight();
}

/** Start a drag: columns full, pads take the keyboard's height (one
 *  layout; nothing on screen moves). False when no keyboard is up. */
export function beginKeyboardDrag(): boolean {
  if (state.interactive) return true;
  const full = fullHeight();
  const k = full - state.height;
  if (k <= KEYBOARD_SLOP) return false;
  clearSettle();
  animating = false;
  latestOverlap = k;
  for (const el of trackEls) {
    el.style.transition = "none";
    el.style.height = `${full}px`;
  }
  for (const el of padEls) el.style.height = `${k}px`;
  set({ ...state, motion: null, interactive: true });
  return true;
}

/** End a drag: in one frame the stand-in goes and the columns take its
 *  bottom as their height (no visible change), then go to `target` with
 *  `transition` (the keyboard's, or none). */
function finishDrag(
  target: number,
  keyboardTop?: number,
  animate = false,
  release = false
): number | null {
  if (!state.interactive) return null;
  // The true geometry when the shell reports it (the keyboard's begin
  // frame), else where the stand-in is.
  const known =
    typeof keyboardTop === "number" && Number.isFinite(keyboardTop) && keyboardTop > 0
      ? Math.min(fullHeight(), keyboardTop)
      : null;
  if (release) dragHandler?.released?.(known);
  const bottom = known ?? dragHandler?.draggedBottom() ?? null;
  dragHandler?.detach();
  for (const el of padEls) el.style.height = "";
  let from: number | null = null;
  for (const el of trackEls) {
    const top = el.getBoundingClientRect().top;
    const h =
      bottom != null && Number.isFinite(bottom)
        ? bottom - top
        : fullHeight() - Math.max(0, latestOverlap) - top;
    const dragged = Math.round(Math.max(0, h));
    if (from == null) from = dragged;
    // The final layout now (hide), or held at the dragged height while
    // the keyboard springs back (show; the screen plays it by transform
    // and the column takes `target` when the motion clears). No height
    // transition: no per-frame layout.
    el.style.transition = "";
    el.style.height = `${animate && target < dragged ? dragged : target}px`;
  }
  if (from == null && bottom != null && Number.isFinite(bottom)) {
    from = Math.round(bottom - state.offsetTop);
  }
  return from;
}

/** The finger went back above the keyboard (it is fully up again) or
 *  let go without a Will*: hand everything back, unanimated. */
export function endKeyboardDrag(): void {
  if (!state.interactive) return;
  finishDrag(state.height);
  set({ ...state, interactive: false });
}

function registryRef(set: Set<HTMLElement>): (el: HTMLElement | null) => void {
  let current: HTMLElement | null = null;
  return (el) => {
    if (current && current !== el) set.delete(current);
    if (el) set.add(el);
    current = el;
  };
}

function useRegistryRef(set: Set<HTMLElement>): (el: HTMLElement | null) => void {
  const cb = useRef<((el: HTMLElement | null) => void) | null>(null);
  if (!cb.current) cb.current = registryRef(set);
  return cb.current;
}

/** Callback ref (stable) for a viewport-sized column: full height while
 *  the finger drags the keyboard, then eased from the dragged height. */
export function useViewportTrackRef(): (el: HTMLElement | null) => void {
  return useRegistryRef(trackEls);
}

/** Callback ref (stable) for an empty block at the end of a scroller in a
 *  tracked column: takes the keyboard's height during a drag. */
export function useViewportPadRef(): (el: HTMLElement | null) => void {
  return useRegistryRef(padEls);
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

/** The shell saw the keyboard move with no Will* (interactive dismiss
 *  started): a fallback trigger for the drag handler. */
function keyboardTrack(overlap: number): void {
  if (!Number.isFinite(overlap)) return;
  const was = state.interactive ? latestOverlap : fullHeight() - state.height;
  latestOverlap = Math.max(0, overlap);
  if (!state.interactive) dragHandler?.keyboardMoved(Math.max(0, was - latestOverlap));
}

/** A native resync (keyboard did show / hide) with no Will* after a drag:
 *  hand the columns back to the published height. */
function endInteractive(): void {
  endKeyboardDrag();
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
  const wasInteractive = state.interactive;
  const lag =
    typeof will.at === "number" && Number.isFinite(will.at)
      ? Math.min(ms, Math.max(0, nowEpochMs() - will.at))
      : 0;
  const remaining = ms - lag;
  const animate = remaining > 0 && !reducedMotion();
  // Released from a drag: the composer starts where the finger left it.
  const dragged = wasInteractive ? finishDrag(target, will.fromTop, animate, true) : null;
  const from = dragged ?? state.height;
  const motion: ViewportMotion | null =
    animate && target !== from
      ? { ms, easing: keyboardEasing(will.curve), elapsed: lag, from, to: target }
      : null;
  resetScroll();
  animating = true;
  clearSettle();
  settleTimer = setTimeout(() => {
    settleTimer = null;
    animating = false;
    measure();
  }, remaining + SETTLE_SLOP_MS);
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
  const onSample = (e: Event) => {
    const d = (e as CustomEvent<Partial<KeyboardSample>>).detail;
    if (!d || typeof d.top !== "number" || !Number.isFinite(d.top)) return;
    const scrollY = typeof d.scrollY === "number" && Number.isFinite(d.scrollY) ? d.scrollY : null;
    const t = typeof d.t === "number" && Number.isFinite(d.t) ? d.t : Date.now();
    dragHandler?.keyboardSample({ top: d.top, scrollY, t });
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
  window.addEventListener("k2-keyboard-sample", onSample);
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
    window.removeEventListener("k2-keyboard-sample", onSample);
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
    __k2KeyboardSample?: (s: KeyboardSample) => void;
  };
  if (typeof w.__k2KeyboardSample !== "function") {
    w.__k2KeyboardSample = (s: KeyboardSample) => {
      window.dispatchEvent(new CustomEvent("k2-keyboard-sample", { detail: s }));
    };
  }
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
  padEls.clear();
  dragHandler = null;
  latestOverlap = 0;
  state = { height: window.innerHeight, offsetTop: 0, motion: null, interactive: false };
}
