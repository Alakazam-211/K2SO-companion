import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { HOLD_MENU_MS, HOLD_SLOP_PX, rectOf, type HeldMenu } from "../useHoldMenu";

/** The attribute marking a message that opens the hold menu. */
export const MESSAGE_HOLD_ATTR = "data-message-hold";

/** The holdable message under `t`, unless its text is being selected. */
function holdTarget(t: EventTarget | null): Element | null {
  const el = (t as Element | null)?.closest?.(`[${MESSAGE_HOLD_ATTR}]`) ?? null;
  return el && el.getAttribute("data-selecting") !== "true" ? el : null;
}

/**
 * Press and hold an agent's message for its menu (Save to stash, Copy,
 * Select Text). One listener set on the message list, not per bubble, so
 * the memoised bubbles stay untouched: a press on an element carrying
 * MESSAGE_HOLD_ATTR held still for HOLD_MENU_MS opens the menu; moving
 * past HOLD_SLOP_PX, the list scrolling, or a cancel drops it, and the
 * release's click is eaten. Same feel as the agent rows (useHoldMenu).
 * `contextmenu` opens it too (iPad pointer right-click, Android long-press,
 * Shift+F10, VoiceOver's double-tap-and-hold). A message whose text is
 * being selected (Select Text) takes no hold: a finger resting on a
 * selection handle must not pop the menu over it.
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
      const target = holdTarget(e.target);
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
      const target = holdTarget(e.target);
      if (!target) return;
      e.preventDefault();
      const id = target.getAttribute(MESSAGE_HOLD_ATTR) ?? "";
      if (!id) return;
      // A touch long-press is still down: its release must not hit the
      // menu. A right-click or a key has no press: the menu takes clicks.
      const touching = !!press.current || eatClick.current;
      clear();
      eatClick.current = touching;
      setMenu({ id, rect: rectOf(target), armed: !touching });
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
