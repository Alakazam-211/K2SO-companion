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
//     Fallback: the shell's "keyboard started moving" signal
//     (useViewportHeight `keyboardMoved`), placed lower by how far the
//     keyboard had already gone.
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
} from "../lib/useViewportHeight";

/** The finger this far back above the line = the keyboard is fully up. */
export const RETURN_SLOP_PX = 4;
/** Let go with no Will* within this long: hand back. */
export const RELEASE_GRACE_MS = 300;
/** Scroll range kept above the view beyond the keyboard's height. */
export const TOP_ROOM_MARGIN = 48;
/** Device knob: if the stand-in lands one finger-frame low at the switch
 *  (the web process saw the scroll a frame late), set true to place it
 *  up by the last touch delta. Off until measured on device. */
export const ATTACH_DRIFT_COMP = false;

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
        attach(ATTACH_DRIFT_COMP && lastY != null ? -(y - lastY) : 0);
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
