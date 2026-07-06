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

import { useEffect, useState } from "react";

export function useViewportHeight(): number {
  const [height, setHeight] = useState(window.innerHeight);

  useEffect(() => {
    const fullHeight = window.innerHeight;

    // A viewport meaningfully shorter than the window = keyboard open
    // (the ChatSession -100px heuristic).
    const apply = (h: number) => {
      setHeight(h < fullHeight - 100 ? h : fullHeight);
    };

    const update = () => {
      const vv = window.visualViewport;
      apply(vv ? vv.height : window.innerHeight);
      // Keep iOS from scrolling the page during the keyboard animation.
      window.scrollTo(0, 0);
    };
    const onCustom = (e: Event) => {
      const h = (e as CustomEvent).detail?.height;
      if (typeof h === "number") apply(h);
    };

    update();
    window.addEventListener("k2-viewport-resize", onCustom);
    window.visualViewport?.addEventListener("resize", update);
    // Poll through focus transitions (the keyboard animates in late).
    const onFocusIn = () => {
      setTimeout(update, 100);
      setTimeout(update, 300);
      setTimeout(update, 500);
    };
    const onFocusOut = () => {
      setTimeout(update, 100);
      setTimeout(update, 300);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      window.removeEventListener("k2-viewport-resize", onCustom);
      window.visualViewport?.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  return height;
}
