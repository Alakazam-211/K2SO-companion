// Press spring (Rosson 2026-10-23, prototype header-glass "Grow"): while a
// finger is down a button grows to PRESS_SCALE on a stiff spring; on
// release it springs back on a looser one, overshooting a touch and
// settling. The constants are LiquidGlassJS's (physics/controller.ts:
// press 550/30, release 300 with damping 8 + (1 − wobble 0.6) × 20 = 16).
// A transform only: no layout, so HeaderGlass's merged outline is not
// redrawn per frame; a merged header button shows its own glass while it
// moves (`PRESSING_CLASS`, index.css) and hands back to the merged layer
// once it rests. Reduced motion: nothing.

import { useCallback, useEffect, useRef } from "react";

export const PRESS_SCALE = 1.045;
const DOWN = { k: 550, c: 30 };
const UP = { k: 300, c: 16 };
/** On the element while it is pressed or still springing back. */
export const PRESSING_CLASS = "k2-pressing";

type Spring = { value: number; velocity: number; target: number; k: number; c: number };

/** One integration step (unit mass); false once settled on the target. */
export function stepSpring(s: Spring, dt: number): boolean {
  const force = -s.k * (s.value - s.target) - s.c * s.velocity;
  s.velocity += force * dt;
  s.value += s.velocity * dt;
  if (Math.abs(s.value - s.target) < 0.0005 && Math.abs(s.velocity) < 0.005) {
    s.value = s.target;
    s.velocity = 0;
    return false;
  }
  return true;
}

function reducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A ref callback that gives the element the press spring. Listens on its
 *  own (passive) pointer events, so the button's handlers are untouched. */
export function usePressSpring<T extends HTMLElement>(): (el: T | null) => void {
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);
  return useCallback((el: T | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    const s: Spring = { value: 1, velocity: 0, target: 1, ...DOWN };
    let frame = 0;
    let last = 0;
    let down = false;
    const paint = () => {
      el.style.transform = s.value === 1 ? "" : `scale(${s.value.toFixed(4)})`;
    };
    const tick = (t: number) => {
      const dt = Math.min(0.032, last ? (t - last) / 1000 : 1 / 60);
      last = t;
      const moving = stepSpring(s, dt);
      paint();
      if (moving) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
        last = 0;
        if (!down) el.classList.remove(PRESSING_CLASS);
      }
    };
    const wake = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onDown = () => {
      if (reducedMotion() || (el as unknown as HTMLButtonElement).disabled) return;
      down = true;
      Object.assign(s, { target: PRESS_SCALE }, DOWN);
      el.classList.add(PRESSING_CLASS);
      wake();
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      Object.assign(s, { target: 1 }, UP);
      wake();
    };
    el.addEventListener("pointerdown", onDown, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    el.addEventListener("pointercancel", onUp, { passive: true });
    el.addEventListener("pointerleave", onUp, { passive: true });
    detach.current = () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onUp);
      el.style.transform = "";
      el.classList.remove(PRESSING_CLASS);
    };
  }, []);
}
