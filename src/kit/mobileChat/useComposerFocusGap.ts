// The composer's bottom gap: the home-indicator inset at rest, 8px while
// typing over the keyboard. The screen root carries COMPOSER_FOCUSED_ATTR
// while focus is in the composer bar; mobileChat.css derives
// --mchat-composer-gap from it for both the bar's bottom padding and a
// spacer ending the scroller, and eases both on the keyboard's timing.
// The attribute is flipped IN the focus event, so both start in the same
// style pass as the bar's :focus-within (no 26px step).
//
// Blur on the keyboard's own hide: an interactive drag-dismiss or the app
// backgrounding can hide the keyboard while WebKit keeps the field focused
// — the bar would keep the 8px typing gap and a tap would not bring the
// keyboard back. On a Will*Hide the field is blurred, as UIKit resigns
// the first responder.

import { useEffect, useRef } from "react";

export const COMPOSER_FOCUSED_ATTR = "data-composer-focused";

export function useComposerFocusGap(opts: {
  root: () => HTMLElement | null;
  bar: () => HTMLElement | null;
  /** The gap is about to ease (stick the list through it, etc.). */
  onChange?: () => void;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    const root = ref.current.root();
    if (!root) return;
    const apply = (on: boolean) => {
      if (root.hasAttribute(COMPOSER_FOCUSED_ATTR) === on) return;
      if (on) root.setAttribute(COMPOSER_FOCUSED_ATTR, "");
      else root.removeAttribute(COMPOSER_FOCUSED_ATTR);
      ref.current.onChange?.();
    };
    const inBar = (n: EventTarget | null) => {
      const b = ref.current.bar();
      return Boolean(b && n instanceof Node && b.contains(n));
    };
    apply(inBar(document.activeElement));
    const onIn = (e: FocusEvent) => apply(inBar(e.target));
    const onOut = (e: FocusEvent) => apply(inBar(e.relatedTarget));
    const onKeyboardWill = (e: Event) => {
      const d = (e as CustomEvent<{ show?: boolean }>).detail;
      if (!d || d.show !== false) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && inBar(el)) el.blur();
      apply(false);
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    window.addEventListener("k2-keyboard-will", onKeyboardWill);
    return () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
      window.removeEventListener("k2-keyboard-will", onKeyboardWill);
    };
  }, []);
}
