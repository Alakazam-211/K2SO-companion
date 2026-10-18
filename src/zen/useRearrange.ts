import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Rearrange mode (Agents list and Home, "Recent agents first" off): drag a
// row by its grip; the other rows slide out of the way (iOS edit-mode
// feel); the drop calls `onCommit` with the new order. Rows are found by
// `data-rearrange-key` under the scroll container.

/** The index the dragged row lands on: how many other rows' middles sit
 *  above its middle. Pure. */
export function rearrangeTarget(mids: number[], from: number, center: number): number {
  let t = 0;
  for (let i = 0; i < mids.length; i++) {
    if (i !== from && mids[i] < center) t += 1;
  }
  return t;
}

/** How far row `i` slides while row `from` hovers over slot `target`. */
export function rearrangeShift(i: number, from: number, target: number, height: number): number {
  if (from < target && i > from && i <= target) return -height;
  if (target < from && i >= target && i < from) return height;
  return 0;
}

/** `keys` with the item at `from` moved to `to`. */
export function moveIndex<T>(keys: T[], from: number, to: number): T[] {
  const next = [...keys];
  const [k] = next.splice(from, 1);
  next.splice(to, 0, k);
  return next;
}

/** Auto-scroll zone at the list's visible top / bottom edge, and speed. */
const EDGE_PX = 56;
const EDGE_SPEED = 10;

export function prefersReducedMotion(): boolean {
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

type Geo = { top: number; height: number };
type Live = {
  key: string;
  from: number;
  pointerId: number;
  startY: number;
  clientY: number;
  geo: Geo[];
  raf: number | null;
};

export function useRearrange({
  keys,
  scrollRef,
  enabled,
  onCommit,
}: {
  /** The draggable rows, in list order. */
  keys: string[];
  scrollRef: { current: HTMLElement | null };
  enabled: boolean;
  /** The drop: the new order (only when it changed). */
  onCommit: (order: string[], key: string) => void;
}) {
  const [drag, setDrag] = useState<{ key: string; from: number; target: number; dy: number } | null>(null);
  const live = useRef<Live | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const stopRaf = () => {
    const l = live.current;
    if (l?.raf != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(l.raf);
    if (l) l.raf = null;
  };

  // Mode off (Done, a tab switch): drop any drag in flight.
  useEffect(() => {
    if (enabled) return;
    stopRaf();
    live.current = null;
    setDrag(null);
  }, [enabled]);
  useEffect(() => () => stopRaf(), []);

  const contentY = (root: HTMLElement, clientY: number) =>
    clientY - root.getBoundingClientRect().top + root.scrollTop;

  const update = () => {
    const l = live.current;
    const root = scrollRef.current;
    if (!l || !root) return;
    const dy = contentY(root, l.clientY) - l.startY;
    const g = l.geo[l.from];
    const center = g.top + g.height / 2 + dy;
    const target = rearrangeTarget(
      l.geo.map((x) => x.top + x.height / 2),
      l.from,
      center
    );
    setDrag({ key: l.key, from: l.from, target, dy });
  };

  /** Near the visible top / bottom edge: scroll, then follow the finger. */
  const tick = () => {
    const l = live.current;
    const root = scrollRef.current;
    if (!l || !root) return;
    l.raf = null;
    const r = root.getBoundingClientRect();
    let padTop = 0;
    let padBottom = 0;
    try {
      const cs = getComputedStyle(root);
      padTop = parseFloat(cs.paddingTop) || 0;
      padBottom = parseFloat(cs.paddingBottom) || 0;
    } catch {
      /* jsdom / no layout */
    }
    let step = 0;
    if (l.clientY < r.top + padTop + EDGE_PX) step = -EDGE_SPEED;
    else if (l.clientY > r.bottom - padBottom - EDGE_PX + 40) step = EDGE_SPEED;
    if (step && r.height > 0) {
      const before = root.scrollTop;
      root.scrollTop = before + step;
      if (root.scrollTop !== before) update();
    }
    if (typeof requestAnimationFrame === "function") l.raf = requestAnimationFrame(tick);
  };

  const handleProps = (key: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || (e.button && e.button !== 0)) return;
      const root = scrollRef.current;
      const from = keysRef.current.indexOf(key);
      if (!root || from < 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* not capturable (jsdom) */
      }
      const rootTop = root.getBoundingClientRect().top;
      const nodes = new Map<string, HTMLElement>();
      root.querySelectorAll<HTMLElement>("[data-rearrange-key]").forEach((n) => {
        nodes.set(n.dataset.rearrangeKey ?? "", n);
      });
      const geo = keysRef.current.map((k) => {
        const r = nodes.get(k)?.getBoundingClientRect();
        return r ? { top: r.top - rootTop + root.scrollTop, height: r.height } : { top: 0, height: 0 };
      });
      stopRaf();
      live.current = {
        key,
        from,
        pointerId: e.pointerId,
        startY: contentY(root, e.clientY),
        clientY: e.clientY,
        geo,
        raf: null,
      };
      setDrag({ key, from, target: from, dy: 0 });
      if (typeof requestAnimationFrame === "function") live.current.raf = requestAnimationFrame(tick);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      l.clientY = e.clientY;
      update();
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const l = live.current;
      if (!l || l.pointerId !== e.pointerId) return;
      e.stopPropagation();
      stopRaf();
      const root = scrollRef.current;
      let target = l.from;
      if (root) {
        const dy = contentY(root, e.clientY) - l.startY;
        const g = l.geo[l.from];
        target = rearrangeTarget(
          l.geo.map((x) => x.top + x.height / 2),
          l.from,
          g.top + g.height / 2 + dy
        );
      }
      live.current = null;
      // Rows snap to their new places with no slide (the order changes
      // in the same render the offsets clear).
      setDrag(null);
      if (target !== l.from) onCommit(moveIndex(keysRef.current, l.from, target), l.key);
    },
    onPointerCancel: () => {
      stopRaf();
      live.current = null;
      setDrag(null);
    },
  });

  const ease = "cubic-bezier(.2,.9,.25,1)";
  /** A row's slide while another row is dragged (or its own drag). */
  const offsetFor = (key: string): { y: number; dragging: boolean; transition: string } => {
    if (!drag) return { y: 0, dragging: false, transition: "none" };
    if (drag.key === key) return { y: drag.dy, dragging: true, transition: "none" };
    const i = keysRef.current.indexOf(key);
    const h = live.current?.geo[drag.from]?.height ?? 0;
    const y = i < 0 ? 0 : rearrangeShift(i, drag.from, drag.target, h);
    return {
      y,
      dragging: false,
      transition: reduced ? "none" : `transform 200ms ${ease}`,
    };
  };

  return { drag, handleProps, offsetFor, reduced };
}
