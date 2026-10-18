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

import { useLayoutEffect, useRef } from "react";
import { fullViewportHeight } from "../../lib/useViewportHeight";
import { iosKeyboardShell, topRoomFor } from "./keyboardDragDock";

export const TOP_ROOM_IDLE_MS = 200;
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
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  const roomPx = useRef(0);
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
    const drop = () => {
      t = null;
      const px = roomPx.current;
      if (px <= 0) return;
      if (Date.now() - ref.current.lastScrollAt() < TOP_ROOM_IDLE_MS) {
        t = setTimeout(drop, TOP_ROOM_IDLE_MS);
        return;
      }
      roomPx.current = 0;
      room.style.height = "";
      el.scrollTop = Math.max(0, el.scrollTop - px);
      wrote();
    };
    drop();
    return () => {
      if (t !== null) clearTimeout(t);
    };
  }, [keyboardUp]);
}
