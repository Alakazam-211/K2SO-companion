import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PIN_LIFT_PX, PIN_MENU_MS, dropIsPins, pinBeforeId } from "./pinChats";
import { rectOf, type HeldMenu, type MenuRect } from "./useHoldMenu";
import { useZenStore } from "./zenStore";

type Drag = {
  id: string;
  x: number;
  y: number;
  lifted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Where the pressed pin sits, for placing its menu. */
  rect: MenuRect | null;
};

export type PinRect = MenuRect;

/**
 * The pin grid's gestures (Agents page). Press and hold a pinned avatar:
 *
 *   - still for PIN_MENU_MS: its menu (the same agent menu rows get);
 *   - move past PIN_LIFT_PX (before or after the menu opens): the pin
 *     lifts and drags; a drop inside the grid reorders the pins on the
 *     server (`movePin` → `projects/reorder`). A drop anywhere else puts
 *     it back (Unpin is in the menu).
 *
 * List rows no longer lift into the grid: Pin is in their menu.
 */
export function usePinDrag(
  pinsRef: { current: HTMLElement | null },
  /** Read at press time: false (Rearrange mode) = pins ignore presses. */
  enabled: () => boolean = () => true
) {
  const movePin = useZenStore((s) => s.movePin);
  const skipClick = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{
    id: string;
    title: string;
    initial: string;
    color: string | null;
    iconUrl: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [hot, setHot] = useState(false);
  const [menu, setMenu] = useState<HeldMenu | null>(null);

  const consumeSkipClick = () => {
    if (!skipClick.current) return false;
    skipClick.current = false;
    return true;
  };

  const cancel = () => {
    const d = dragRef.current;
    if (d?.timer) clearTimeout(d.timer);
    dragRef.current = null;
    setGhost(null);
    setHot(false);
  };

  const liftAt = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d || d.lifted) return;
    if (d.timer) clearTimeout(d.timer);
    d.lifted = true;
    d.timer = null;
    skipClick.current = true;
    const row = useZenStore.getState().agents.find((a) => a.id === d.id);
    setGhost({
      id: d.id,
      title: row?.name ?? d.id,
      initial: row?.initial ?? "?",
      color: row?.color ?? null,
      iconUrl: row?.iconUrl ?? null,
      x,
      y,
    });
    setHot(true);
  };

  /** A still hold: the pin's menu. The release's click is eaten. */
  const openMenu = () => {
    const d = dragRef.current;
    if (!d || d.lifted) return;
    d.timer = null;
    skipClick.current = true;
    setMenu({ id: d.id, rect: d.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0 }, armed: false });
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    skipClick.current = false;
    if (e.button && e.button !== 0) return;
    if (!enabled()) return;
    const target = e.target as HTMLElement;
    if (target.closest("input,textarea,[data-no-pin]")) return;
    const pin = target.closest("[data-pin-id][data-pin-from='pin']") as HTMLElement | null;
    if (!pin || pin.dataset.placeholder === "1") return;
    const id = pin.dataset.pinId;
    if (!id) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id,
      x: e.clientX,
      y: e.clientY,
      lifted: false,
      timer: setTimeout(openMenu, PIN_MENU_MS),
      rect: rectOf(pin),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.lifted) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > PIN_LIFT_PX) {
        // Hold then drag: moving off an open menu lifts the pin.
        setMenu(null);
        liftAt(e.clientX, e.clientY);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setGhost((g) => (g ? { ...g, x: e.clientX, y: e.clientY } : g));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.lifted) {
      const inPins = dropIsPins(e.clientX, e.clientY, pinsRef.current?.getBoundingClientRect() ?? null);
      if (inPins) void movePin(d.id, pinBeforeId(e.clientX, e.clientY, pinsRef.current));
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    cancel();
  };

  const onPinClick = (id: string) => {
    if (consumeSkipClick()) return;
    useZenStore.getState().setAgent(id);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    ghost,
    hot,
    consumeSkipClick,
    onPinClick,
    menu,
    /** Desktop right-click / Android long-press. A press in flight (the
     *  touch is still down) leaves the menu unarmed. */
    openMenuFor: (id: string, el: Element) => {
      const pressing = !!dragRef.current;
      if (dragRef.current?.timer) clearTimeout(dragRef.current.timer);
      if (dragRef.current) dragRef.current.timer = null;
      if (pressing) skipClick.current = true;
      setMenu({ id, rect: rectOf(el), armed: !pressing });
    },
    closeMenu,
  };
}
