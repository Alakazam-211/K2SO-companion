// The composer's bottom gap: the home-indicator inset at rest, 8px while
// typing over the keyboard. The screen root carries COMPOSER_FOCUSED_ATTR
// while focus is in the composer bar; index.css derives
// --mchat-composer-gap from it for both the bar's bottom padding and a
// spacer ending the scroller. The bar's padding eases on the keyboard's
// timing; the spacer changes at once (no per-frame column layout) and the
// screen's `onChange` re-sticks a following list once and plays the
// difference with `easeGapShift` (a compositor `translate`, same timing).
// The attribute is flipped IN the focus event, so both start in the same
// style pass as the bar's :focus-within (no 26px step).
//
// Blur on the keyboard's own hide: an interactive drag-dismiss or the app
// backgrounding can hide the keyboard while WebKit keeps the field focused
// — the bar would keep the 8px typing gap and a tap would not bring the
// keyboard back. On a Will*Hide the field is blurred, as UIKit resigns
// the first responder (the shell also resigns WebKit's content view on
// DidHide). Only for a keyboard this screen saw come up, and never a field
// focused moments ago: a late / stale hide (UIKit can post a WillChangeFrame
// with the old, hidden frame as the keyboard comes back) must not undo the
// tap that is bringing the keyboard back.

import { useEffect, useRef } from "react";
import { keyboardMotionMs, keyboardTopNow } from "../../lib/useViewportHeight";

/** The keyboard's curve as the CSS has it (useViewportHeight keeps
 *  --k2-kb-ease in step with the native notifications). */
const KB_EASE_FALLBACK = "cubic-bezier(0.38, 0.7, 0.125, 1)";
function keyboardEase(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--k2-kb-ease").trim();
    return v || KB_EASE_FALLBACK;
  } catch {
    return KB_EASE_FALLBACK;
  }
}

function prefersReduced(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** The vertical part of an element's running `translate` (px). */
function translateY(el: HTMLElement): number {
  try {
    const parts = getComputedStyle(el).translate.trim().split(/\s+/);
    const y = parts.length > 1 ? parseFloat(parts[1]) : 0;
    return Number.isFinite(y) ? y : 0;
  } catch {
    return 0;
  }
}

const gapShifts = new WeakMap<HTMLElement, Animation>();

/** The list's content just moved `dy` px up the screen (a re-stick to the
 *  new gap: scrollTop + dy): draw it where it was and ease it there on the
 *  keyboard's timing — what the spacer's own height transition used to
 *  show, on the compositor. A `translate`, so it composes with the
 *  keyboard FLIP's and the list glide's `transform`. No motion on Android
 *  or with reduced motion (the gap never eased there either). */
export function easeGapShift(el: HTMLElement | null, dy: number): void {
  if (!el || !(Math.abs(dy) >= 0.5) || typeof el.animate !== "function") return;
  if (prefersReduced() || el.closest(".platform-android")) return;
  let from = dy;
  // A gap change mid-ease (focus bounced): from where it is now.
  const running = gapShifts.get(el);
  if (running) {
    from += translateY(el);
    running.cancel();
  }
  let anim: Animation;
  try {
    anim = el.animate([{ translate: `0px ${from}px` }, { translate: "0px 0px" }], {
      duration: keyboardMotionMs(),
      easing: keyboardEase(),
    });
  } catch {
    return;
  }
  gapShifts.set(el, anim);
  const done = () => {
    if (gapShifts.get(el) === anim) gapShifts.delete(el);
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

export const COMPOSER_FOCUSED_ATTR = "data-composer-focused";
/** A field focused this recently (ms) is never blurred by a Will*Hide. */
export const FRESH_FOCUS_MS = 400;

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
    // The keyboard as this screen saw it (Will* show / hide), and when the
    // composer last took focus.
    let keyboardUp = keyboardTopNow() != null;
    let focusedAt = Number.NEGATIVE_INFINITY;
    const onIn = (e: FocusEvent) => {
      if (inBar(e.target)) focusedAt = performance.now();
      apply(inBar(e.target));
    };
    const onOut = (e: FocusEvent) => apply(inBar(e.relatedTarget));
    const onKeyboardWill = (e: Event) => {
      const d = (e as CustomEvent<{ show?: boolean }>).detail;
      if (!d) return;
      if (d.show !== false) {
        keyboardUp = true;
        return;
      }
      // Just tapped: the keyboard is coming back; this hide predates it.
      if (performance.now() - focusedAt < FRESH_FOCUS_MS) return;
      const wasUp = keyboardUp;
      keyboardUp = false;
      if (!wasUp) return; // a hide for a keyboard that is not up: stale
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
