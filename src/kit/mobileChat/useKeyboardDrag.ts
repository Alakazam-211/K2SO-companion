// Interactive keyboard dismiss for one chat screen: the touch-crossing
// switch of an inert composer copy into the scrolled content
// (keyboardDragDock), and the shell's keyboardDismissPadding kept at the
// composer's height so the drag starts at its top (iOS 17+).

import { useEffect, useRef } from "react";
import { installKeyboardDragDock, syncDismissPadding } from "./keyboardDragDock";

export function useKeyboardDrag(opts: {
  scroller: () => HTMLElement | null;
  dock: () => HTMLElement | null;
  /** A zero-height `position: relative` block in the scrolled content,
   *  stacked above the list (z-index). */
  layer: () => HTMLElement | null;
  /** The composer's height above the keyboard (px), for the padding. */
  composerPx: number;
  enabled?: boolean;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    return installKeyboardDragDock({
      scroller: () => ref.current.scroller(),
      dock: () => ref.current.dock(),
      layer: () => ref.current.layer(),
    });
  }, [enabled]);
  useEffect(() => {
    if (enabled && opts.composerPx > 0) void syncDismissPadding(opts.composerPx);
  }, [opts.composerPx, enabled]);
}
