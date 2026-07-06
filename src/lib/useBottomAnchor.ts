// The chat bottom-anchoring hook shared by ProjectChat and
// FeedbackThread. Those screens are fixed overlays whose column height
// is the useViewportHeight value; when the keyboard opens the list
// container SHRINKS but its scrollTop stays put, so the newest message
// slides under the composer and the user has to scroll manually. This
// hook re-pins the list to the bottom through those resizes — but only
// when the user was already reading the tail (within the near-bottom
// slop); scrolled-up history reading is never yanked.
//
// Usage: `const { onScroll, scrollToBottom } = useBottomAnchor(ref, h)`,
// attach `onScroll` to the scroll container (JSX prop, so it survives
// the container conditionally mounting), and route the screen's own
// new-message pins through `scrollToBottom` so everything shares one
// near-bottom bookkeeping.
//
// Pins are INSTANT (direct scrollTop assignment = behavior:"auto") — a
// smooth scroll fights the keyboard animation.

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { isNearBottom, shouldPinAfterResize } from "./bottomAnchor";

export function useBottomAnchor(
  scrollRef: RefObject<HTMLDivElement | null>,
  containerHeight: number
): { onScroll: () => void; scrollToBottom: () => void } {
  // Chats open pinned to the tail — anchored until a scroll says not.
  const nearBottomRef = useRef(true);

  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  }, [scrollRef]);

  const scrollToBottom = useCallback((): void => {
    nearBottomRef.current = true;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [scrollRef]);

  // Keyboard open/close: the column height changes AFTER the DOM commit
  // that carries it, so deciding here (post-commit effect) + one rAF
  // lands the pin on the resized layout. `nearBottomRef` still holds the
  // pre-resize reading — pure container resizes don't fire scroll events.
  const prevHeight = useRef(containerHeight);
  useEffect(() => {
    const pin = shouldPinAfterResize(nearBottomRef.current, prevHeight.current, containerHeight);
    prevHeight.current = containerHeight;
    if (pin) scrollToBottom();
  }, [containerHeight, scrollToBottom]);

  // Composer focus (the exact reported tap case): if the user is at the
  // tail, pin right away — before the polled viewport height even lands.
  // The only textarea on these screens is the shared MessageComposer.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      if (!(e.target instanceof HTMLTextAreaElement)) return;
      if (nearBottomRef.current) scrollToBottom();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [scrollToBottom]);

  return { onScroll, scrollToBottom };
}
