// Chatter as a page to the right of the Thread (owner 2026-11-14): a
// right-to-left swipe anywhere on the chat brings it in over the Thread;
// a left-to-right swipe (or Back) takes it away. The left-edge swipe stays
// Back to the chats list while Chatter is closed (useSwipeBack); while it
// is open, Chatter's own Back handler is on top, so that edge swipe is off
// and this one closes Chatter instead. Thresholds match swipe-back's.
// Pure decisions here; useChatterSwipe.ts is the plumbing.

import { AXIS_LOCK_PX, COMPLETE_FRACTION, FLICK_MIN_DX_PX, FLICK_VELOCITY_PX_PER_MS } from "../lib/swipeBack";

export type ChatterPhase = "armed" | "tracking" | "rejected";

/** The panel's resting transforms (React and the release write the same). */
export const CHATTER_OPEN_TRANSFORM = "translateX(0px)";
export const CHATTER_CLOSED_TRANSFORM = "translateX(100%)";
export const CHATTER_SLIDE_MS = 280;
export const CHATTER_TRANSITION = `transform ${CHATTER_SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;

/** Closed: a dominant leftward drag opens. Open: a dominant rightward drag
 *  closes. Anything else (vertical, the other way) is the list's touch. */
export function chatterPhase(phase: ChatterPhase, dx: number, dy: number, open: boolean): ChatterPhase {
  if (phase !== "armed") return phase;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay > AXIS_LOCK_PX && ay > ax) return "rejected";
  const toward = open ? dx : -dx;
  if (toward < -AXIS_LOCK_PX) return "rejected";
  if (toward > AXIS_LOCK_PX && ax > ay) return "tracking";
  return "armed";
}

/** The panel's offset from its open place (0 = open, width = off screen). */
export function chatterOffset(dx: number, width: number, open: boolean): number {
  const raw = open ? dx : width + dx;
  return Math.max(0, Math.min(width, raw));
}

/** Where the panel settles on release: true = open. `velocity` is px/ms,
 *  positive rightward. A flick decides; else past the fraction. */
export function chatterSettlesOpen(dx: number, velocity: number, width: number, open: boolean): boolean {
  const toward = open ? dx : -dx; // the finger's travel the way this swipe goes
  const v = open ? velocity : -velocity;
  if (v >= FLICK_VELOCITY_PX_PER_MS && toward >= FLICK_MIN_DX_PX) return !open;
  if (v <= -FLICK_VELOCITY_PX_PER_MS) return open;
  return toward >= width * COMPLETE_FRACTION ? !open : open;
}

/** A touch that starts here is not a page swipe: text fields, something
 *  that scrolls sideways itself (code blocks, tables), or an open
 *  selection's handles. */
export function chatterSwipeIgnores(target: EventTarget | null, root: HTMLElement | null): boolean {
  let el = target instanceof Element ? target : null;
  if (el?.closest("textarea, input, [contenteditable='true'], [data-no-page-swipe]")) return true;
  try {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return true;
  } catch {
    /* no selection API */
  }
  while (el && el !== root) {
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}
