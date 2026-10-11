import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PIN_HOLD_MS, PIN_LIFT_PX, PIN_MENU_MS } from "./pinChats";
import { useFileDrag } from "./fileDrag";

/** A Files-drawer row, read from its `data-file-*` attributes. */
export type FileRowTarget = {
  path: string;
  name: string;
  isDirectory: boolean;
  /** A pinned resource gone from disk: menu only, no drag. */
  missing: boolean;
  section: "resources" | "tree";
};

export type FileMenu = FileRowTarget & {
  rect: { left: number; top: number; right: number; bottom: number } | null;
};

type Hold = {
  target: FileRowTarget;
  pointerId: number;
  x: number;
  y: number;
  /** The short hold passed: moving now drags instead of scrolling. */
  armed: boolean;
  lifted: boolean;
  menuOpen: boolean;
  armTimer: ReturnType<typeof setTimeout> | null;
  menuTimer: ReturnType<typeof setTimeout> | null;
  rect: FileMenu["rect"];
};

function rowTarget(el: Element | null): { node: HTMLElement; target: FileRowTarget } | null {
  const node = el?.closest?.("[data-file-path]") as HTMLElement | null;
  const path = node?.dataset.filePath;
  if (!node || !path) return null;
  return {
    node,
    target: {
      path,
      name: node.dataset.fileName || path.split("/").pop() || path,
      isDirectory: node.dataset.fileDir === "1",
      missing: node.dataset.fileMissing === "1",
      section: node.dataset.fileSection === "resources" ? "resources" : "tree",
    },
  };
}

/**
 * Press-and-hold on a Files row, the pin grid's split (`usePinDrag`):
 * - move before the hold arms (PIN_HOLD_MS): a scroll, the hold drops;
 * - hold still to PIN_MENU_MS: the row's menu opens;
 * - hold, then move past PIN_LIFT_PX: a file lifts into a drag (an open
 *   menu closes). A folder does not drag.
 * The release after a menu or a drag does not click the row.
 */
export function useFileHold(opts: { refFor: (path: string) => string }) {
  const holdRef = useRef<Hold | null>(null);
  const skipClick = useRef(false);
  const [menu, setMenu] = useState<FileMenu | null>(null);
  const refFor = useRef(opts.refFor);
  refFor.current = opts.refFor;
  const scroller = useRef<HTMLElement | null>(null);

  const stopScroll = useRef((ev: TouchEvent) => {
    const h = holdRef.current;
    if (h && (h.armed || h.lifted) && ev.cancelable) ev.preventDefault();
  }).current;

  const clearTimers = (h: Hold | null) => {
    if (!h) return;
    if (h.armTimer) clearTimeout(h.armTimer);
    if (h.menuTimer) clearTimeout(h.menuTimer);
    h.armTimer = null;
    h.menuTimer = null;
  };

  const drop = () => {
    clearTimers(holdRef.current);
    holdRef.current = null;
  };

  useEffect(() => () => drop(), []);

  const lift = (h: Hold, x: number, y: number, el: HTMLElement | null) => {
    clearTimers(h);
    h.lifted = true;
    skipClick.current = true;
    setMenu(null);
    try {
      el?.setPointerCapture?.(h.pointerId);
    } catch {
      /* jsdom / a released pointer */
    }
    useFileDrag.getState().begin({
      path: h.target.path,
      name: h.target.name,
      ref: refFor.current(h.target.path),
      x,
      y,
    });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    skipClick.current = false;
    if (e.button && e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("input,textarea,[data-no-hold]")) return;
    const hit = rowTarget(t);
    if (!hit) return;
    drop();
    const r = hit.node.getBoundingClientRect();
    const h: Hold = {
      target: hit.target,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      armed: false,
      lifted: false,
      menuOpen: false,
      armTimer: null,
      menuTimer: null,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
    h.armTimer = setTimeout(() => {
      h.armed = true;
      h.armTimer = null;
    }, PIN_HOLD_MS);
    h.menuTimer = setTimeout(() => {
      h.menuTimer = null;
      if (holdRef.current !== h || h.lifted) return;
      h.armed = true;
      h.menuOpen = true;
      skipClick.current = true;
      setMenu({ ...h.target, rect: h.rect });
    }, PIN_MENU_MS);
    holdRef.current = h;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const h = holdRef.current;
    if (!h || e.pointerId !== h.pointerId) return;
    if (h.lifted) {
      e.preventDefault();
      useFileDrag.getState().move(e.clientX, e.clientY);
      return;
    }
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) <= PIN_LIFT_PX) return;
    if (!h.armed) {
      // Moved before the hold armed: the list is scrolling.
      drop();
      return;
    }
    if (h.target.isDirectory || h.target.missing) {
      // Nothing to carry. An open menu stays; the hold ends.
      drop();
      return;
    }
    lift(h, e.clientX, e.clientY, e.currentTarget);
  };

  const finish = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const h = holdRef.current;
    if (!h || e.pointerId !== h.pointerId) return;
    if (h.lifted) {
      if (cancelled) useFileDrag.getState().cancel();
      else useFileDrag.getState().end(e.clientX, e.clientY);
      try {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* already released */
      }
    }
    drop();
  };

  /** True once: the release after a menu or a drag. */
  const consumeSkipClick = () => {
    if (!skipClick.current) return false;
    skipClick.current = false;
    return true;
  };

  /** While the hold is armed or dragging, a touch move must not scroll
   *  the drawer (a non-passive listener; React's are passive). */
  const scrollerRef = useCallback((el: HTMLElement | null) => {
    if (scroller.current) scroller.current.removeEventListener("touchmove", stopScroll);
    scroller.current = el;
    el?.addEventListener("touchmove", stopScroll, { passive: false });
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    consumeSkipClick,
    menu,
    closeMenu: useCallback(() => setMenu(null), []),
    scrollerRef,
  };
}
