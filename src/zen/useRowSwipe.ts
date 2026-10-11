import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Leading (swipe-right) row action, iOS Mail / Messages style. */
export const SWIPE_ACTION_W = 76;
/** Release past this and the row snaps open on the action. */
export const SWIPE_OPEN_PX = 60;
/** Release past this share of the row width runs the action at once. */
export const SWIPE_FULL_RATIO = 0.5;
/** Axis lock: horizontal only when |dx| > this and |dx| > |dy| × 1.5. */
export const SWIPE_SLOP_PX = 10;

export type SwipeRelease = "full" | "open" | "close";

export function swipeRelease(x: number, width: number): SwipeRelease {
  if (width > 0 && x >= width * SWIPE_FULL_RATIO) return "full";
  if (x >= SWIPE_OPEN_PX) return "open";
  return "close";
}

/** True once a move is clearly horizontal (not a vertical list pan). */
export function isHorizontalSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.5;
}

type Track = {
  id: string;
  x0: number;
  y0: number;
  /** Offset when the gesture began (the action width if this row was open). */
  base: number;
  width: number;
  committed: boolean;
  x: number;
};

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/**
 * Swipe a list row right to reveal one action. The handlers run from the
 * same container as usePinDrag (which holds pointer capture there), so the
 * caller decides the order: swipe first, and if it claims the move, abort
 * the hold-drag.
 */
export function useRowSwipe(onFull: (id: string) => void) {
  const track = useRef<Track | null>(null);
  const skipClick = useRef(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; width: number } | null>(null);
  const openRef = useRef<string | null>(null);
  openRef.current = openId;
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const close = () => {
    if (openRef.current) setOpenId(null);
    setDrag(null);
  };

  const consumeSkipClick = () => {
    if (!skipClick.current) return false;
    skipClick.current = false;
    return true;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    skipClick.current = false;
    if (e.button && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-swipe-action]")) return;
    const row = target.closest("[data-pin-id][data-pin-from='list']") as HTMLElement | null;
    const id = row?.dataset.pinId || null;
    const open = openRef.current;
    if (open && id !== open) {
      // Tap elsewhere closes the open row; on another row it is only a close.
      setOpenId(null);
      if (row) skipClick.current = true;
    }
    if (!row || !id) return;
    // A tap on the open row closes it rather than opening the chat.
    if (open === id) skipClick.current = true;
    const wrap = (row.closest("[data-swipe-row]") as HTMLElement | null) ?? row;
    const width =
      wrap.getBoundingClientRect().width ||
      (typeof window !== "undefined" ? window.innerWidth : 0);
    const base = open === id ? SWIPE_ACTION_W : 0;
    track.current = {
      id,
      x0: e.clientX,
      y0: e.clientY,
      base,
      width,
      committed: false,
      x: base,
    };
  };

  /** Returns true when the swipe owns this move (caller aborts the hold-drag). */
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>, holdArmed: boolean): boolean => {
    const t = track.current;
    if (!t) return false;
    if (holdArmed && !t.committed) {
      track.current = null;
      return false;
    }
    const dx = e.clientX - t.x0;
    const dy = e.clientY - t.y0;
    if (!t.committed) {
      if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
        // Vertical list pan: let it scroll, and close any open row.
        track.current = null;
        close();
        return false;
      }
      if (!isHorizontalSwipe(dx, dy)) return false;
      // Leading action only: a left drag on a closed row is not a swipe.
      if (dx < 0 && t.base === 0) {
        track.current = null;
        return false;
      }
      t.committed = true;
      skipClick.current = true;
      if (openRef.current && openRef.current !== t.id) setOpenId(null);
    }
    e.preventDefault();
    t.x = Math.max(0, Math.min(t.width || Infinity, t.base + dx));
    setDrag({ id: t.id, x: t.x, width: t.width });
    return true;
  };

  const onPointerUp = () => {
    const t = track.current;
    track.current = null;
    if (!t) return;
    if (!t.committed) {
      if (t.base > 0) close();
      return;
    }
    const outcome = swipeRelease(t.x, t.width);
    setDrag(null);
    if (outcome === "full") {
      setOpenId(null);
      onFull(t.id);
    } else if (outcome === "open") {
      setOpenId(t.id);
    } else {
      setOpenId(null);
    }
  };

  const onPointerCancel = () => {
    const t = track.current;
    track.current = null;
    if (t?.committed) setDrag(null);
  };

  /** Current offset of a row, and whether it is under the finger. */
  const offsetFor = (id: string) => {
    if (drag?.id === id) {
      return {
        x: drag.x,
        dragging: true,
        full: drag.width > 0 && drag.x >= drag.width * SWIPE_FULL_RATIO,
      };
    }
    return { x: openId === id ? SWIPE_ACTION_W : 0, dragging: false, full: false };
  };

  const transition = (dragging: boolean, props: string[]) =>
    dragging
      ? "none"
      : props
          .map((p) =>
            reduced ? `${p} 80ms linear` : `${p} 320ms cubic-bezier(.2,.9,.25,1)`
          )
          .join(", ");

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSkipClick,
    offsetFor,
    transition,
    reduced,
    openId,
    close,
  };
}
