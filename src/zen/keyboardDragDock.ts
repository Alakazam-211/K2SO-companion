// Interactive keyboard dismiss, iMessage-style, without per-frame JS.
//
// Dragging the Thread list down into the keyboard: the keyboard follows
// the finger and so does the list — WebKit scrolls it natively (a child
// UIScrollView, UI process, the same frame as the keyboard). Anything the
// page moves per frame (native → JS → rAF) trails both. So at the moment
// the keyboard starts to follow the finger, a stand-in of the composer
// dock is put INTO the scrolled content at the dock's exact on-screen
// spot, and the real dock is made invisible (opacity 0: its textarea
// keeps focus, so the keyboard stays). From then on native scrolling
// carries the stand-in with the finger, in lockstep with the keyboard.
//
//   - The switch: a passive `touchmove` on the scroller crossing the
//     keyboard's top (minus the shell's keyboardDismissPadding — the
//     composer's height, so the drag starts at the composer like iMessage).
//     Fallback: the shell's first keyboard sample (or the older shell's
//     "started moving" signal), placed lower by how far the keyboard had
//     already gone.
//   - Exact placement: the shell samples the keyboard only while a dismiss
//     drag moves it (a few frames, then one ~100ms later), each with the
//     panning scroll view's contentOffset.y from the same native frame.
//     The stand-in and the keyboard then move 1:1, so the stand-in's
//     offset from the keyboard is constant: `sampleDiff` computes it from
//     the stand-in's content-space bottom and the sample's own scroll
//     offset (no dependence on when the page last saw the scroll). The
//     first sample after the attach gives it; the stand-in EASES there by
//     a transform transition (compositor-only, on top of the native
//     scroll; 80–220ms by size, ease-out, either sign). One confirmation
//     sample ~100ms later eases a second small correction if it disagrees
//     by more than CONFIRM_TOLERANCE_PX. Never per frame.
//   - The finger going back above the line (keyboard fully up again):
//     hand back, unanimated. Let go with no Will*: the same, after a grace.
//   - Release (Will*Hide / Will*Show): useViewportHeight's finishDrag asks
//     `draggedBottom()`, `detach()`es, sizes the column to that bottom and
//     eases on from there. Scroll momentum goes on without the composer.
//
// A not-moving-with-content stand-in would mean the scroll was clamped
// (rubber band at the top): ThreadPane keeps real scroll range above the
// view while the keyboard is up (`topRoomFor`).

import {
  beginKeyboardDrag,
  endKeyboardDrag,
  keyboardTopNow,
  setKeyboardDragHandler,
  type KeyboardDragHandler,
  type KeyboardSample,
} from "../lib/useViewportHeight";
import { prefersReducedMotion } from "./sendFly";

/** The finger this far back above the line = the keyboard is fully up. */
export const RETURN_SLOP_PX = 4;
/** Let go with no Will* within this long: hand back. */
export const RELEASE_GRACE_MS = 300;
/** Scroll range kept above the view beyond the keyboard's height. */
export const TOP_ROOM_MARGIN = 48;
/** Smaller diffs (px) are not worth a move. */
export const MIN_CORRECTION_PX = 0.5;
/** Larger ones are a bad reading (another scroll view's offset…). */
export const MAX_CORRECTION_PX = 48;
/** The confirmation: a sample this long (ms) after the one used. */
export const CONFIRM_AFTER_MS = 90;
/** …that moves the stand-in again only if it disagrees by more (px). */
export const CONFIRM_TOLERANCE_PX = 2;
/** Correction ease: duration bounds (ms) and curve (ease-out). */
export const CORRECTION_MIN_MS = 80;
export const CORRECTION_MAX_MS = 220;
export const CORRECTION_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Duration (ms) of a correction ease: longer for a bigger move. */
export function correctionMs(delta: number): number {
  const d = Number.isFinite(delta) ? Math.abs(delta) : 0;
  return Math.round(Math.min(CORRECTION_MAX_MS, Math.max(CORRECTION_MIN_MS, 80 + 7 * d)));
}

/** The iOS app shell (interactive dismiss is set up natively): lib.rs's
 *  injected `__k2KeyboardSetup`, or (that injection can be lost on a page
 *  reload) an iOS WebView inside Tauri. Android / a browser: none of this
 *  runs. */
export function iosKeyboardShell(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __k2KeyboardSetup?: unknown; __TAURI_INTERNALS__?: unknown };
  if (w.__k2KeyboardSetup === true) return true;
  if (!w.__TAURI_INTERNALS__ || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
  );
}

export type Box = { left: number; top: number; width: number; height: number };
type RectLike = { left: number; top: number; width: number; height: number };

/** Viewport y at which a downward drag starts moving the keyboard. */
export function crossLine(keyboardTop: number, dismissPadding: number): number {
  return keyboardTop - (Number.isFinite(dismissPadding) ? Math.max(0, dismissPadding) : 0);
}

/** Where the stand-in goes inside the drag layer (a zero-height block in
 *  the scrolled content) so it covers the dock exactly. Both rects are
 *  viewport rects read in the same layout; `lead` moves it down (px). */
export function standInBox(dock: RectLike, layer: RectLike, lead = 0): Box {
  return {
    left: dock.left - layer.left,
    top: dock.top - layer.top + lead,
    width: dock.width,
    height: dock.height,
  };
}

/** Top spacer (px) so the list keeps at least the keyboard's height (+ a
 *  margin) of real scroll range above the view: dragging it down is a
 *  1:1 scroll, not a rubber band. */
export function topRoomFor(keyboardInset: number, scrollTop: number, margin = TOP_ROOM_MARGIN): number {
  if (!(keyboardInset > 0)) return 0;
  return Math.max(0, Math.ceil(keyboardInset + margin - Math.max(0, scrollTop)));
}

/** How far (px) the stand-in must move (down +, up −) to sit on the
 *  keyboard. `copyBottomContent` is the stand-in's untransformed bottom in
 *  content space (viewport y at scrollTop 0); at the sample's native frame
 *  it was at `copyBottomContent - sample.scrollY`, the keyboard's top at
 *  `sample.top`. Null without a native scroll offset or when implausible. */
export function sampleDiff(copyBottomContent: number, sample: KeyboardSample): number | null {
  if (sample.scrollY == null || !Number.isFinite(sample.scrollY)) return null;
  const d = sample.top - (copyBottomContent - sample.scrollY);
  if (!Number.isFinite(d) || Math.abs(d) > MAX_CORRECTION_PX) return null;
  return d;
}

/** Shall this touchmove switch the composer into the content? */
export function shouldAttach(
  y: number,
  lastY: number | null,
  line: number | null
): boolean {
  return line != null && lastY != null && y > lastY && y >= line;
}

/** Shall this touchmove hand the composer back (finger above the line)? */
export function shouldReturn(y: number, line: number | null): boolean {
  return line != null && y < line - RETURN_SLOP_PX;
}

const FIELDS = "textarea, input";

/** An inert copy of the dock: same look (values, field scroll), no ids,
 *  no test ids, no focus, no pointer. */
export function buildStandIn(dock: HTMLElement): HTMLElement {
  const clone = dock.cloneNode(true) as HTMLElement;
  const src = dock.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(FIELDS);
  const dst = clone.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(FIELDS);
  dst.forEach((d, i) => {
    const s = src[i];
    if (s) d.value = s.value;
  });
  for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))]) {
    el.removeAttribute("id");
    el.removeAttribute("data-testid");
  }
  clone.setAttribute("data-testid", "thread-composer-standin");
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.style.position = "absolute";
  clone.style.right = "auto";
  clone.style.bottom = "auto";
  clone.style.margin = "0";
  clone.style.opacity = "";
  clone.style.transform = "";
  clone.style.transition = "none";
  clone.style.pointerEvents = "none";
  return clone;
}

/** iOS 17+ shell: dismissal starts at the composer's top (the padding
 *  in effect, px; 0 = unsupported / not set). */
let dismissPadding = 0;
let askedPadding = -1;

export function dismissPaddingPx(): number {
  return dismissPadding;
}

/** Tell the shell the composer's height (keyboardDismissPadding). */
export async function syncDismissPadding(px: number): Promise<void> {
  const want = Math.max(0, Math.round(px));
  if (Math.abs(want - askedPadding) < 2) return;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!w.__TAURI_INTERNALS__ || !iosKeyboardShell()) return;
  askedPadding = want;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const ok = await invoke<boolean>("ios_keyboard_dismiss_padding", { px: want });
    if (askedPadding === want) dismissPadding = ok ? want : 0;
  } catch {
    dismissPadding = 0;
  }
}

export type DockParts = {
  scroller: () => HTMLElement | null;
  dock: () => HTMLElement | null;
  layer: () => HTMLElement | null;
  /** Dismiss padding in effect (px). */
  padding?: () => number;
};

/** Wire the switch for one Thread; returns the teardown. */
export function installKeyboardDragDock(parts: DockParts): () => void {
  const padding = parts.padding ?? dismissPaddingPx;
  let standIn: HTMLElement | null = null;
  let hidden: HTMLElement | null = null;
  let line: number | null = null;
  let lastY: number | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const clearGrace = () => {
    if (grace !== null) clearTimeout(grace);
    grace = null;
  };

  // This drag's correction: the transform the stand-in eases to (px),
  // whether the first sample after the attach was used and when.
  let target = 0;
  let usedAt: number | null = null;
  let confirmed = false;
  const resetSamples = () => {
    target = 0;
    usedAt = null;
    confirmed = false;
  };

  /** The stand-in's untransformed bottom in content space: the layer's
   *  rect and the scroller's scrollTop come from the same page snapshot. */
  const copyBottomContent = (): number | null => {
    const scroller = parts.scroller();
    const layer = parts.layer();
    if (!standIn || !scroller || !layer) return null;
    const top = parseFloat(standIn.style.top) || 0;
    const h = parseFloat(standIn.style.height) || 0;
    return layer.getBoundingClientRect().top + scroller.scrollTop + top + h;
  };

  /** Ease the stand-in to `next` (px) over the native scroll. */
  const easeTo = (next: number) => {
    if (!standIn) return;
    const ms = correctionMs(next - target);
    target = next;
    standIn.style.transition = prefersReducedMotion()
      ? "none"
      : `transform ${ms}ms ${CORRECTION_EASE}`;
    standIn.style.transform = next ? `translate3d(0, ${next}px, 0)` : "translate3d(0, 0, 0)";
  };

  /** A sample after the attach: the first sets the correction, one
   *  ~100ms later may refine it. */
  const useSample = (sample: KeyboardSample) => {
    if (!standIn || confirmed) return;
    if (usedAt != null && sample.t - usedAt < CONFIRM_AFTER_MS) return;
    const base = copyBottomContent();
    const diff = base == null ? null : sampleDiff(base, sample);
    if (usedAt == null) {
      usedAt = sample.t;
      if (diff != null && Math.abs(diff) >= MIN_CORRECTION_PX) easeTo(diff);
      return;
    }
    confirmed = true;
    if (diff != null && Math.abs(diff - target) > CONFIRM_TOLERANCE_PX) easeTo(diff);
  };

  const attach = (lead: number): boolean => {
    if (standIn) return true;
    const dock = parts.dock();
    const layer = parts.layer();
    if (!dock || !layer || keyboardTopNow() == null) return false;
    const dockRect = dock.getBoundingClientRect();
    if (!beginKeyboardDrag()) return false;
    // Columns are full height now; the content did not move (the pad).
    const box = standInBox(dockRect, layer.getBoundingClientRect(), lead);
    const clone = buildStandIn(dock);
    clone.style.left = `${box.left}px`;
    clone.style.top = `${box.top}px`;
    clone.style.width = `${box.width}px`;
    clone.style.height = `${box.height}px`;
    layer.appendChild(clone);
    const src = dock.querySelectorAll<HTMLElement>(FIELDS);
    clone.querySelectorAll<HTMLElement>(FIELDS).forEach((d, i) => {
      if (src[i]) d.scrollTop = src[i].scrollTop;
    });
    dock.style.opacity = "0";
    dock.style.pointerEvents = "none";
    standIn = clone;
    hidden = dock;
    return true;
  };

  const detach = () => {
    clearGrace();
    resetSamples();
    standIn?.remove();
    standIn = null;
    if (hidden) {
      hidden.style.opacity = "";
      hidden.style.pointerEvents = "";
    }
    hidden = null;
  };

  const handler: KeyboardDragHandler = {
    keyboardMoved(moved) {
      if (!standIn && iosKeyboardShell()) attach(Math.max(0, moved));
    },
    keyboardSample(sample) {
      if (!iosKeyboardShell()) return;
      if (!standIn) {
        // Fallback trigger: the keyboard is moving and no touch crossing
        // was seen. Attach where the dock is; this sample's diff eases it
        // onto the keyboard.
        const rest = keyboardTopNow();
        const moved = rest == null ? 0 : sample.top - rest;
        if (moved < 0.5 || !attach(0)) return;
      }
      useSample(sample);
    },
    draggedBottom() {
      return standIn ? standIn.getBoundingClientRect().bottom : null;
    },
    detach,
  };
  setKeyboardDragHandler(handler);

  const yOf = (e: TouchEvent): number | null => {
    const t = e.touches[0] ?? e.changedTouches[0];
    return t ? t.clientY : null;
  };
  const onStart = (e: TouchEvent) => {
    clearGrace();
    if (!standIn) resetSamples();
    const y = yOf(e);
    const top = iosKeyboardShell() ? keyboardTopNow() : null;
    line = top == null ? null : crossLine(top, padding());
    lastY = y;
  };
  const onMove = (e: TouchEvent) => {
    const y = yOf(e);
    if (y == null) return;
    if (!standIn) {
      if (shouldAttach(y, lastY, line)) {
        attach(0);
      }
    } else if (shouldReturn(y, line)) {
      endKeyboardDrag(); // detaches through the handler
    }
    lastY = y;
  };
  const onEnd = () => {
    lastY = null;
    if (!standIn) return;
    clearGrace();
    grace = setTimeout(() => {
      grace = null;
      if (standIn) endKeyboardDrag();
    }, RELEASE_GRACE_MS);
  };

  const scroller = parts.scroller();
  const opts: AddEventListenerOptions = { passive: true };
  scroller?.addEventListener("touchstart", onStart, opts);
  scroller?.addEventListener("touchmove", onMove, opts);
  scroller?.addEventListener("touchend", onEnd, opts);
  scroller?.addEventListener("touchcancel", onEnd, opts);
  return () => {
    scroller?.removeEventListener("touchstart", onStart);
    scroller?.removeEventListener("touchmove", onMove);
    scroller?.removeEventListener("touchend", onEnd);
    scroller?.removeEventListener("touchcancel", onEnd);
    if (standIn) endKeyboardDrag();
    detach();
    setKeyboardDragHandler(null);
  };
}
