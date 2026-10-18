// Real scroll range above the view while the keyboard is up (iOS):
// at least the keyboard's height + TOP_ROOM_MARGIN, so an interactive
// dismiss drag is a 1:1 native scroll (the composer's stand-in rides it),
// never a top rubber band. Added and removed with scrollTop compensated:
// nothing on screen moves. Removed only once scrolling is idle (a
// programmatic scroll would stop a release's momentum).
//
// The list's content block must ALWAYS carry CHAT_CONTENT_CLASS
// (.mchat-content): min-height = the scroller's height minus the composer
// gap spacer (easing with it) and minus the drag pad while a drag holds the
// column full height. A short list then fills the view exactly (no phantom
// scroll range), the room is reachable above it, and adding / removing the
// room never changes where short content sits — a min-height that came
// and went with the room let a short chat drop to its natural layout as
// the room left: the snap after a keyboard hide (TestFlight). A chat list
// also pushes its messages to the bottom (justify-content: flex-end,
// iMessage); a document-like list (a ticket) stays top-aligned.
//
// A keyboard hide that is not a drag release drops the room at once inside
// the FLIP (`dropNow`, via FlipList.beforeHide), so the content reaches its
// resting place in the hide's one glide. After a drag release the room
// waits for scroll idle; if dropping it then has to move visible content
// (the reader had scrolled into the room: scrollTop clamps), the move is
// played over ROOM_SETTLE_MS instead of snapping.

import { useLayoutEffect, useRef } from "react";
import { fullViewportHeight } from "../../lib/useViewportHeight";
import { iosKeyboardShell, topRoomFor } from "./keyboardDragDock";

export const TOP_ROOM_IDLE_MS = 200;
/** An idle room drop that moves visible content eases over this long. */
export const ROOM_SETTLE_MS = 250;
const ROOM_SETTLE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** The class a list's content block always carries (see above). */
export const CHAT_CONTENT_CLASS = "mchat-content";

export function useScrollRoom(opts: {
  viewportHeight: number | null | undefined;
  scroller: () => HTMLElement | null;
  /** An empty block first in the scroller. */
  room: () => HTMLElement | null;
  /** The list's content block (class CHAT_CONTENT_CLASS). */
  content: () => HTMLElement | null;
  /** Date.now() of the last scroll event. */
  lastScrollAt: () => number;
  /** The hook wrote scrollTop (so the screen's onScroll can ignore it). */
  onScrollWrite?: (top: number) => void;
}): { dropNow(): void } {
  const ref = useRef(opts);
  ref.current = opts;
  const roomPx = useRef(0);
  // Drop the room now; returns how far the content moved (px, down +).
  const drop = (): number => {
    const { scroller, room: roomOf, content: contentOf } = ref.current;
    const el = scroller();
    const room = roomOf();
    const content = contentOf();
    const px = roomPx.current;
    if (!el || !room || px <= 0) return 0;
    const before = (content ? content.offsetTop : 0) - el.scrollTop;
    roomPx.current = 0;
    room.style.height = "";
    el.scrollTop = Math.max(0, el.scrollTop - px);
    ref.current.onScrollWrite?.(el.scrollTop);
    return (content ? content.offsetTop : 0) - el.scrollTop - before;
  };
  const api = useRef({ dropNow: () => void drop() });
  const vh = opts.viewportHeight;
  const keyboardInset = vh == null ? 0 : Math.max(0, fullViewportHeight() - vh);
  // iOS only (interactive dismiss); Android scrolls as it always did.
  const keyboardUp = keyboardInset > 100 && iosKeyboardShell();
  useLayoutEffect(() => {
    const { scroller, room: roomOf, content: contentOf } = ref.current;
    const el = scroller();
    const room = roomOf();
    const content = contentOf();
    if (!el || !room || !content) return;
    const wrote = () => ref.current.onScrollWrite?.(el.scrollTop);
    if (keyboardUp) {
      const px = topRoomFor(keyboardInset, el.scrollTop);
      if (px <= 0 || roomPx.current > 0) return;
      roomPx.current = px;
      room.style.height = `${px}px`;
      el.scrollTop += px;
      wrote();
      return;
    }
    let t: ReturnType<typeof setTimeout> | null = null;
    const idleDrop = () => {
      t = null;
      if (roomPx.current <= 0) return;
      if (Date.now() - ref.current.lastScrollAt() < TOP_ROOM_IDLE_MS) {
        t = setTimeout(idleDrop, TOP_ROOM_IDLE_MS);
        return;
      }
      const moved = drop();
      if (Math.abs(moved) < 0.5) return;
      // Clamped: play the content from where it was instead of snapping.
      const kids = Array.from(el.children) as HTMLElement[];
      for (const k of kids) {
        k.style.transition = "none";
        k.style.transform = `translate3d(0, ${-moved}px, 0)`;
      }
      void el.getBoundingClientRect();
      for (const k of kids) {
        k.style.transition = `transform ${ROOM_SETTLE_MS}ms ${ROOM_SETTLE_EASE}`;
        k.style.transform = "";
      }
    };
    idleDrop();
    return () => {
      if (t !== null) clearTimeout(t);
    };
  }, [keyboardUp]);
  return api.current;
}
