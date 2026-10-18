import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "./sendFly";

/** Delivered: the "Sending…" bubble brightens to full over this long.
 *  Subtler since the "Delivered" receipt (chatReceipt.ts) says it in
 *  words: a lighter dim and a shorter brighten. */
export const DELIVER_BRIGHTEN_MS = 500;
export const DELIVER_BRIGHTEN_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
/** The sending opacity and the breathe (`.zen-bubble-breathe` in
 *  sendFly.css: 0.85 ↔ 0.95, 1.2 s, ease-in-out, alternate). */
export const SENDING_OPACITY = 0.85;
const BREATHE_SPAN = 0.1;
const BREATHE_MS = 1200;

/** Where the CSS breathe is `elapsedMs` after it started (ease-in-out ≈
 *  smoothstep), so the brighten starts from the frame on screen. */
export function breatheOpacityAt(elapsedMs: number): number {
  if (!(elapsedMs > 0)) return SENDING_OPACITY;
  const t = elapsedMs / BREATHE_MS;
  const cycle = Math.floor(t);
  let f = t - cycle;
  if (cycle % 2 === 1) f = 1 - f;
  const eased = f * f * (3 - 2 * f);
  return SENDING_OPACITY + BREATHE_SPAN * eased;
}

/**
 * A sent bubble's hand-off to "delivered": instead of the old 240 ms step,
 * it brightens gradually from wherever the sending breathe is to full.
 * The bubble's inline opacity flips to 1 in the same commit; this runs
 * before paint and animates over it (compositor only). Skipped while the
 * flight still holds the bubble (the flight brightens its clone), under
 * reduced motion, and when Web Animations are missing (old WebKit).
 */
export function useDeliverBrighten(
  ref: RefObject<HTMLElement | null>,
  pending: boolean,
  breathing: boolean,
  flying: boolean
): void {
  const wasPending = useRef(pending);
  const breatheStart = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (breathing && breatheStart.current == null) breatheStart.current = performance.now();
    if (!breathing && pending) breatheStart.current = null;
  }, [breathing, pending]);
  useLayoutEffect(() => {
    const was = wasPending.current;
    wasPending.current = pending;
    if (!was || pending || flying) return;
    const el = ref.current;
    const start = breatheStart.current;
    breatheStart.current = null;
    // Reduced motion: the opacity just flips (no motion of any kind).
    if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return;
    const from = start != null ? breatheOpacityAt(performance.now() - start) : SENDING_OPACITY;
    el.animate([{ opacity: from }, { opacity: 1 }], {
      duration: DELIVER_BRIGHTEN_MS,
      easing: DELIVER_BRIGHTEN_EASING,
    });
  }, [pending, flying, ref]);
}
