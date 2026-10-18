import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** A still press this long opens a row's menu (iOS context-menu feel). */
export const HOLD_MENU_MS = 500;
/** Moving further than this cancels the hold (a list pan, not a press). */
export const HOLD_SLOP_PX = 10;

export type MenuRect = { left: number; top: number; right: number; bottom: number; width: number };

export function rectOf(el: Element): MenuRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width };
}

/** The open menu: which row, where it was pressed, and whether the menu
 *  takes clicks yet (`armed` false until a fresh press, so the hold's own
 *  release / iOS's synthetic click cannot hit an item). */
export type HeldMenu<K extends string = string> = { id: K; rect: MenuRect; armed: boolean };

type Press<K> = { id: K; x: number; y: number; timer: ReturnType<typeof setTimeout> | null };

/**
 * Press and hold a row for its menu (the one row gesture left: no swipes,
 * no hold-drag). Per-row pointer handlers from `bind(id)`:
 *
 *   - a still press of HOLD_MENU_MS opens the menu; the release's click is
 *     eaten (`consumeSkipClick` in the row's onClick);
 *   - moving past HOLD_SLOP_PX, or the browser taking the touch for a pan
 *     (pointercancel), drops the hold, so the list still scrolls;
 *   - `contextmenu` (desktop right-click, Android long-press) opens it too.
 */
export function useHoldMenu<K extends string = string>() {
  const [menu, setMenu] = useState<HeldMenu<K> | null>(null);
  const press = useRef<Press<K> | null>(null);
  const skip = useRef(false);

  const clear = () => {
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    press.current = null;
  };
  useEffect(() => clear, []);

  const close = useCallback(() => setMenu(null), []);

  const consumeSkipClick = () => {
    if (!skip.current) return false;
    skip.current = false;
    return true;
  };

  const bind = (id: K, enabled = true) => {
    if (!enabled) return {};
    return {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        skip.current = false;
        if (e.button && e.button !== 0) return;
        clear();
        const el = e.currentTarget;
        const p: Press<K> = { id, x: e.clientX, y: e.clientY, timer: null };
        p.timer = setTimeout(() => {
          p.timer = null;
          if (press.current !== p) return;
          skip.current = true;
          setMenu({ id, rect: rectOf(el), armed: false });
        }, HOLD_MENU_MS);
        press.current = p;
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        const p = press.current;
        if (!p || !p.timer) return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > HOLD_SLOP_PX) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        e.preventDefault();
        // A touch long-press (Android) is still down: its release must not
        // hit the menu. A right-click has no press: the menu takes clicks.
        const touching = !!press.current;
        clear();
        skip.current = touching;
        setMenu({ id, rect: rectOf(e.currentTarget), armed: !touching });
      },
    };
  };

  return { menu, bind, close, consumeSkipClick, openFor: (id: K, el: Element) => setMenu({ id, rect: rectOf(el), armed: true }) };
}
