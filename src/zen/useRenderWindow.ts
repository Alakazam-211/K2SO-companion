import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import {
  measureRows,
  pinWindow,
  resolveWindow,
  spacerAbove,
  spacerBelow,
  WINDOW_EXTEND,
  WINDOW_IDLE_MS,
  WINDOW_KEEP_SCREENS,
  WINDOW_RESPAWN_SCREENS,
  WINDOW_ROWS,
  WINDOW_TRIM_MIN,
  type ThreadWindow,
  type WindowRange,
} from "./threadWindow";

// The Thread's render window (threadWindow.ts) as a hook, for a list that
// keeps every row in memory and has no "Load earlier" (the open ticket's
// comments). ThreadPane runs the same rules inline, woven into its
// progressive paint, earlier pages and push-tap targets.
//
// A fresh list is drawn from its FIRST row (a ticket is top-aligned: it
// opens on the brief, the oldest comments under it): the first WINDOW_ROWS,
// and arrivals draw at once while that is the whole list. Following the
// newest (after Send, "New comment ↓"), the window is the newest
// WINDOW_ROWS and the oldest drop off once scrolling is quiet. Anywhere
// else, rows come back (WINDOW_EXTEND at a time) before the reader reaches
// a drawn edge and rows far past the view leave once quiet. Rows that left
// are a spacer of their measured height (never measured: 0 above, an
// estimate below), and a window change holds the row under the reader's
// eye where it was.
//
// Rows in the window carry `data-win-row` and `data-row-key`.

export type RenderWindowOptions = {
  /** The list's identity (the ticket): a new one starts a fresh window. */
  room: string;
  /** Every row's key in memory, oldest first. */
  keys: string[];
  scroller: () => HTMLElement | null;
  /** The element holding the rows. */
  list: () => HTMLElement | null;
  /** The reader follows the newest. */
  following: () => boolean;
  /** Something is moving the list (a send flying in, a drag): wait. */
  busy: () => boolean;
  lastScrollAt: () => number;
  /** Pin the view to the newest (after the window moved back there). */
  stick: (el: HTMLElement) => void;
  /** The window wrote the scroller's scrollTop (holding a row still). */
  onScrollWrite?: (top: number) => void;
};

export type RenderWindow = WindowRange & {
  /** Height (px) the rows above / below the window stand in for. */
  above: number;
  below: number;
  /** The newest row is drawn. */
  drawsNewest: boolean;
  /** Draw through the newest; `stick`: and land the view there. */
  toNewest(stick: boolean): void;
  /** The scroller scrolled (its onScroll). */
  onScroll(): void;
};

export function useRenderWindow(o: RenderWindowOptions): RenderWindow {
  const opts = useRef(o);
  opts.current = o;
  const winRef = useRef<{ room: string; win: ThreadWindow } | null>(null);
  const heights = useRef<{ room: string; px: Map<string, number> }>({ room: "", px: new Map() });
  const drawn = useRef<(WindowRange & { keys: string[] }) | null>(null);
  const anchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const stickNext = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const { room, keys } = o;
  if (heights.current.room !== room) heights.current = { room, px: new Map() };
  if (winRef.current && winRef.current.room !== room) winRef.current = null;
  // A fresh list (or one that just got its first rows): from the top.
  if (!winRef.current && keys.length) {
    winRef.current = {
      room,
      win: pinWindow(keys, { lo: 0, hi: Math.min(keys.length, WINDOW_ROWS) }),
    };
  }
  const range = resolveWindow(keys, winRef.current?.win ?? null);
  const above = spacerAbove(keys, range.lo, heights.current.px);
  const below = spacerBelow(keys, range.hi, heights.current.px);

  function rows(): HTMLElement[] {
    const list = opts.current.list();
    return list ? Array.from(list.querySelectorAll<HTMLElement>("[data-win-row]")) : [];
  }

  /** The first drawn row still (partly) on screen. */
  function captureAnchor(): { el: HTMLElement; top: number } | null {
    const el = opts.current.scroller();
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    for (const r of rows()) {
      if (r.getBoundingClientRect().bottom > top + 1) return { el: r, top: r.offsetTop };
    }
    return null;
  }

  function rememberHeights(leaving: HTMLElement[]) {
    const px = measureRows(leaving);
    leaving.forEach((r, i) => {
      const key = r.getAttribute("data-row-key");
      if (key) heights.current.px.set(key, px[i]);
    });
  }

  /** Draw another window. `hold`: keep the row under the reader's eye
   *  where it is. */
  function setWindow(win: ThreadWindow, hold: boolean) {
    winRef.current = { room: opts.current.room, win };
    anchor.current = hold ? captureAnchor() : null;
    bump();
  }

  function reconcile(idle: boolean): "busy" | "done" {
    const { scroller, following, busy } = opts.current;
    const el = scroller();
    const view = drawn.current;
    if (!el || !view || !view.keys.length) return "done";
    if (busy()) return "busy";
    const { keys: k, lo, hi } = view;
    const len = k.length;
    const shown = rows();
    if (!shown.length) return "done";
    const indexOf = (r: HTMLElement) => k.indexOf(r.getAttribute("data-row-key") ?? "");
    if (following()) {
      if (hi < len) {
        stickNext.current = true;
        setWindow(pinWindow(k, { lo, hi: len }), false);
        return "done";
      }
      if (hi - lo <= WINDOW_ROWS) return "done";
      if (!idle) return "busy";
      const start = Math.max(0, len - WINDOW_ROWS);
      rememberHeights(
        shown.filter((r) => {
          const at = indexOf(r);
          return at >= 0 && at < start;
        })
      );
      setWindow(pinWindow(k, { lo: start, hi: len }), true);
      return "done";
    }
    const ch = el.clientHeight;
    if (!(ch > 0)) return "done";
    const st = el.scrollTop;
    const scTop = el.getBoundingClientRect().top;
    const y = (r: HTMLElement) => r.getBoundingClientRect().top - scTop + st;
    const first = shown[0];
    const last = shown[shown.length - 1];
    if (lo > 0 && y(first) > st - WINDOW_RESPAWN_SCREENS * ch) {
      setWindow(pinWindow(k, { lo: Math.max(0, lo - WINDOW_EXTEND), hi }), true);
      return "done";
    }
    if (hi < len && y(last) + last.offsetHeight < st + ch + WINDOW_RESPAWN_SCREENS * ch) {
      setWindow(pinWindow(k, { lo, hi: Math.min(len, hi + WINDOW_EXTEND) }), true);
      return "done";
    }
    if (!idle) return "done";
    const keepFrom = st - WINDOW_KEEP_SCREENS * ch;
    const keepTo = st + ch + WINDOW_KEEP_SCREENS * ch;
    let up = 0;
    while (up < shown.length - 1 && y(shown[up]) + shown[up].offsetHeight < keepFrom) up++;
    let down = 0;
    while (down < shown.length - 1 - up && y(shown[shown.length - 1 - down]) > keepTo) down++;
    if (up < WINDOW_TRIM_MIN) up = 0;
    if (down < WINDOW_TRIM_MIN) down = 0;
    if (!up && !down) return "done";
    rememberHeights([...shown.slice(0, up), ...shown.slice(shown.length - down)]);
    const nextLo = up ? indexOf(shown[up]) : lo;
    const nextHi = down ? indexOf(shown[shown.length - 1 - down]) + 1 : hi;
    if (nextLo < 0 || nextHi <= nextLo) return "done";
    setWindow(pinWindow(k, { lo: nextLo, hi: nextHi }), true);
    return "done";
  }
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  /** Rows leave only once scrolling has been quiet a while; a pending
   *  check stays (frequent commits must not keep pushing it back). */
  const scheduleIdle = useRef((delay: number = WINDOW_IDLE_MS) => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const quiet = Date.now() - opts.current.lastScrollAt();
      if (quiet < WINDOW_IDLE_MS) {
        scheduleIdle.current(WINDOW_IDLE_MS - quiet + 10);
        return;
      }
      if (reconcileRef.current(true) === "busy") scheduleIdle.current();
    }, delay);
  });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (raf.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf.current);
    },
    []
  );

  // After every commit: what was drawn (pinned by key, so arrivals and a
  // refetch do not move it), the held row put back, the stick, the trim.
  useLayoutEffect(() => {
    const { keys: k, scroller, stick, following, onScrollWrite } = opts.current;
    drawn.current = { keys: k, lo: range.lo, hi: range.hi };
    if (k.length) winRef.current = { room: opts.current.room, win: pinWindow(k, range) };
    const a = anchor.current;
    anchor.current = null;
    const el = scroller();
    if (a && el && a.el.isConnected) {
      const dy = a.el.offsetTop - a.top;
      if (Math.abs(dy) >= 1) {
        el.scrollTop += dy;
        onScrollWrite?.(el.scrollTop);
      }
    }
    if (stickNext.current) {
      stickNext.current = false;
      if (el && following()) {
        stick(el);
        onScrollWrite?.(el.scrollTop);
      }
    }
    if (k.length > WINDOW_ROWS || range.lo > 0 || range.hi < k.length) scheduleIdle.current();
  });

  return {
    ...range,
    above,
    below,
    drawsNewest: range.hi >= keys.length,
    toNewest(stick: boolean) {
      // The rows leaving keep their height (a spacer, not a jump).
      const view = drawn.current;
      if (view && view.hi >= view.keys.length) return;
      rememberHeights(rows());
      stickNext.current = stick;
      const k = view?.keys ?? opts.current.keys;
      setWindow(pinWindow(k, { lo: Math.max(0, k.length - WINDOW_ROWS), hi: k.length }), false);
    },
    onScroll() {
      if (!raf.current && typeof requestAnimationFrame === "function") {
        raf.current = requestAnimationFrame(() => {
          raf.current = 0;
          reconcileRef.current(false);
        });
      }
      scheduleIdle.current();
    },
  };
}
