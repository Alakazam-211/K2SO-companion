import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  PIN_HOLD_MS,
  PIN_LIFT_PX,
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
};

export function usePinDrag(pinsRef: { current: HTMLElement | null }) {
  const pinChat = useZenStore((s) => s.pinChat);
  const movePin = useZenStore((s) => s.movePin);
  const unpinChat = useZenStore((s) => s.unpinChat);
  const skipClick = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{
    id: string;
    title: string;
    initial: string;
    x: number;
    y: number;
  } | null>(null);
  const [hot, setHot] = useState(false);

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
      x,
      y,
    });
    setHot(true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
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
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id,
      from: pin ? "pin" : "list",
      x: e.clientX,
      y: e.clientY,
      lifted: false,
      timer: setTimeout(() => liftAt(e.clientX, e.clientY), PIN_HOLD_MS),
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
      if (from === "list" && zone === "pins") pinChat(id, before);
      if (from === "pin" && zone === "pins") movePin(id, before);
      if (from === "pin" && zone === "list") unpinChat(id);
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

  return { onPointerDown, onPointerMove, onPointerUp, ghost, hot, consumeSkipClick, onPinClick };
}
