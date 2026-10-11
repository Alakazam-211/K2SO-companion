import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  PIN_HOLD_MS,
  PIN_LIFT_PX,
  PIN_MENU_MS,
  dropIsPins,
  isListPan,
  pinBeforeId,
} from "./pinChats";
import { useZenStore } from "./zenStore";

type Drag = {
  id: string;
  from: "pin" | "list";
  x: number;
  y: number;
  lifted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Where the pressed pin sits, for placing its menu. */
  rect: PinRect | null;
};

export type PinRect = { left: number; top: number; right: number; bottom: number; width: number };

/** The long-press menu on a pin avatar (Open / Unpin). */
export type PinMenu = { id: string; rect: PinRect | null };

export function usePinDrag(
  pinsRef: { current: HTMLElement | null },
  /** Server pins are per workspace: a sidecar / group row cannot lift. */
  canPin: (id: string) => boolean = () => true
) {
  const pinChat = useZenStore((s) => s.pinChat);
  const movePin = useZenStore((s) => s.movePin);
  const unpinChat = useZenStore((s) => s.unpinChat);
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
  const [menu, setMenu] = useState<PinMenu | null>(null);

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

  /** A still hold on a pin: open its menu. The release's click is eaten. */
  const openMenu = () => {
    const d = dragRef.current;
    if (!d || d.lifted || d.from !== "pin") return;
    d.timer = null;
    skipClick.current = true;
    setMenu({ id: d.id, rect: d.rect });
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    skipClick.current = false;
    if (e.button && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("input,textarea,[data-no-pin]")) return;
    const pin = target.closest("[data-pin-id][data-pin-from='pin']") as HTMLElement | null;
    const row = target.closest("[data-pin-id][data-pin-from='list']") as HTMLElement | null;
    const node = pin || row;
    if (!node) return;
    if (pin?.dataset.placeholder === "1") return;
    const id = node.dataset.pinId;
    if (!id) return;
    if (!pin && !canPin(id)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    let rect: PinRect | null = null;
    if (pin) {
      const r = pin.getBoundingClientRect();
      rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width };
    }
    // A list row lifts on a short hold (the swipe and the pan need the
    // move). A pin lifts on movement only, so a still hold is its menu.
    dragRef.current = {
      id,
      from: pin ? "pin" : "list",
      x: e.clientX,
      y: e.clientY,
      lifted: false,
      timer: pin
        ? setTimeout(openMenu, PIN_MENU_MS)
        : setTimeout(() => liftAt(e.clientX, e.clientY), PIN_HOLD_MS),
      rect,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.lifted) {
      if (Math.hypot(dx, dy) > PIN_LIFT_PX) {
        if (d.from === "list" && isListPan(dx, dy)) {
          cancel();
          return;
        }
        // Hold then drag still works: moving off an open menu lifts the pin.
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
    const wasLifted = d.lifted;
    const { id, from } = d;
    if (wasLifted) {
      const zone = dropIsPins(
        e.clientX,
        e.clientY,
        pinsRef.current?.getBoundingClientRect() ?? null
      )
        ? "pins"
        : "list";
      const before = pinBeforeId(e.clientX, e.clientY, pinsRef.current);
      if (from === "list" && zone === "pins") void pinChat(id, before);
      if (from === "pin" && zone === "pins") void movePin(id, before);
      if (from === "pin" && zone === "list") void unpinChat(id);
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

  /** True once the hold has lifted a ghost (a swipe must not start then). */
  const isLifted = () => !!dragRef.current?.lifted;

  /** Drop a not-yet-lifted hold (a row swipe took the gesture). */
  const abort = () => {
    if (dragRef.current && !dragRef.current.lifted) cancel();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    ghost,
    hot,
    consumeSkipClick,
    onPinClick,
    isLifted,
    abort,
    menu,
    openMenuFor: (id: string, rect: PinRect | null) => setMenu({ id, rect }),
    closeMenu,
  };
}
