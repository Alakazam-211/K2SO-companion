// iMessage-style tap-to-dismiss: a plain tap on non-interactive content in
// the list (empty space, a bubble's text) blurs the composer, so the
// keyboard closes (the Will*Hide FLIP path animates it).
//
// A tap = pointerup within TAP_SLOP_PX of its pointerdown, inside
// TAP_MAX_MS, not cancelled (WebKit cancels pointers when a scroll pan
// starts — a scroll / drag is never a tap; the interactive dismiss covers
// that). Never dismisses:
//   - on interactive elements (NO_DISMISS_SELECTOR, `[data-no-dismiss]`):
//     they do their own action;
//   - with a text selection (long-press select);
//   - while a menu of the composer is open (`aria-expanded="true"` inside
//     it): the outside tap closes the menu only;
//   - when the screen says a tap means something else (`canDismiss`).

import { useEffect, useRef } from "react";

export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 350;
export const NO_DISMISS_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  "video",
  "audio",
  "[role=button]",
  "[role=menuitem]",
  "[role=link]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=tab]",
  "[contenteditable='']",
  "[contenteditable=true]",
  "[data-no-dismiss]",
].join(", ");

export type TapFacts = {
  /** Distance (px) between pointerdown and pointerup. */
  moved: number;
  /** Duration (ms) of the press. */
  ms: number;
  /** The pointer was cancelled (a scroll pan took it). */
  cancelled: boolean;
  target: Element | null;
  /** The current text selection (getSelection().toString()). */
  selection: string;
  /** A composer menu is open. */
  menuOpen: boolean;
};

/** Pure: is this pointer sequence a dismissing tap? */
export function isDismissTap(f: TapFacts): boolean {
  if (f.cancelled || f.moved > TAP_SLOP_PX || f.ms > TAP_MAX_MS) return false;
  if (f.menuOpen) return false;
  if (f.selection.trim() !== "") return false;
  if (!f.target) return false;
  if (f.target.closest(NO_DISMISS_SELECTOR)) return false;
  return true;
}

export function useTapToDismiss(opts: {
  /** Where taps count (the list / the terminal output). */
  area: () => HTMLElement | null;
  /** The composer (its focused field is what gets blurred). */
  composer: () => HTMLElement | null;
  /** Default true. */
  enabled?: boolean;
  /** Per tap: false when a tap means something else here (e.g. a
   *  terminal in direct-typing mode). */
  canDismiss?: () => boolean;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    const area = ref.current.area();
    if (!enabled || !area) return;
    let down: { id: number; x: number; y: number; t: number; moved: number; cancelled: boolean } | null =
      null;
    const onDown = (e: PointerEvent) => {
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, moved: 0, cancelled: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return;
      down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
    };
    const onCancel = (e: PointerEvent) => {
      if (down && e.pointerId === down.id) down.cancelled = true;
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || e.pointerId !== d.id) return;
      const composer = ref.current.composer();
      const active = document.activeElement;
      if (!composer || !(active instanceof HTMLElement) || !composer.contains(active)) return;
      let selection = "";
      try {
        selection = window.getSelection?.()?.toString() ?? "";
      } catch {
        selection = "";
      }
      const tap = isDismissTap({
        moved: Math.max(d.moved, Math.hypot(e.clientX - d.x, e.clientY - d.y)),
        ms: e.timeStamp - d.t,
        cancelled: d.cancelled,
        target: e.target instanceof Element ? e.target : null,
        selection,
        menuOpen: !!composer.querySelector('[aria-expanded="true"]'),
      });
      if (!tap) return;
      if (ref.current.canDismiss && !ref.current.canDismiss()) return;
      active.blur();
    };
    area.addEventListener("pointerdown", onDown, { passive: true });
    area.addEventListener("pointermove", onMove, { passive: true });
    area.addEventListener("pointercancel", onCancel, { passive: true });
    area.addEventListener("pointerup", onUp, { passive: true });
    return () => {
      area.removeEventListener("pointerdown", onDown);
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointercancel", onCancel);
      area.removeEventListener("pointerup", onUp);
    };
  }, [enabled]);
}
