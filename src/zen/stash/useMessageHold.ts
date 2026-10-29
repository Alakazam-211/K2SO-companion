import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { HOLD_MENU_MS, HOLD_SLOP_PX, rectOf, type HeldMenu } from "../useHoldMenu";

/** The attribute marking a message that opens the hold menu. */
export const MESSAGE_HOLD_ATTR = "data-message-hold";

/**
 * Press and hold an agent's message for its menu (Save to stash, Copy,
 * Select Text). One listener set on the message list, not per bubble, so
 * the memoised bubbles stay untouched: a press on an element carrying
 * MESSAGE_HOLD_ATTR held still for HOLD_MENU_MS opens the menu; moving
 * past HOLD_SLOP_PX, the list scrolling, or a cancel drops it, and the
 * release's click is eaten. Same feel as the agent rows (useHoldMenu).
 */
export function useMessageHold(area: RefObject<HTMLElement | null>, enabled: boolean) {
  const [menu, setMenu] = useState<HeldMenu | null>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const eatClick = useRef(false);

  useEffect(() => {
    const el = area.current;
    if (!el || !enabled) return;
    const clear = () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    };
    const down = (e: PointerEvent) => {
      eatClick.current = false;
      clear();
      if (e.button && e.button !== 0) return;
      const target = (e.target as Element | null)?.closest?.(`[${MESSAGE_HOLD_ATTR}]`);
      // Buttons and links inside a message keep their own press.
      if (!target || (e.target as Element).closest("button, a")) return;
      const id = target.getAttribute(MESSAGE_HOLD_ATTR) ?? "";
      if (!id) return;
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press.current = null;
          eatClick.current = true;
          setMenu({ id, rect: rectOf(target), armed: false });
        }, HOLD_MENU_MS),
      };
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_SLOP_PX) clear();
    };
    const click = (e: MouseEvent) => {
      if (!eatClick.current) return;
      eatClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const context = (e: MouseEvent) => {
      // iOS's own callout / Android's long-press menu on a holdable message.
      if ((e.target as Element | null)?.closest?.(`[${MESSAGE_HOLD_ATTR}]`)) e.preventDefault();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener("scroll", clear, { passive: true });
    el.addEventListener("click", click, true);
    el.addEventListener("contextmenu", context);
    return () => {
      clear();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", clear);
      el.removeEventListener("pointercancel", clear);
      el.removeEventListener("scroll", clear);
      el.removeEventListener("click", click, true);
      el.removeEventListener("contextmenu", context);
    };
  }, [area, enabled]);

  const close = useCallback(() => setMenu(null), []);
  return { menu, close };
}
