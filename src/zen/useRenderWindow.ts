import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import {
  measureRows,
  pinWindow,
  resolveWindow,
  spacerAbove,
  spacerBelow,
  WINDOW_IDLE_MS,
  WINDOW_RESPAWN_SCREENS,
  WINDOW_ROWS,
  type ThreadWindow,
  type WindowRange,
} from "./threadWindow";

// The Thread's render window (threadWindow.ts) as a hook, for a list that
// keeps every row in memory and has no "Load earlier" (the open ticket's
// comments). ThreadPane runs the same rules inline, woven into its
// progressive paint, earlier pages and push-tap targets.
//
// Sizes (Rosson, 2026-10-18): a list opens with RENDER_WINDOW_OPEN_ROWS
// (30) drawn; reading on, rows are drawn RENDER_WINDOW_STEP at a time
// before the reader reaches a drawn edge, and the window grows to at most
// RENDER_WINDOW_MAX_ROWS (50). Past that, each step drops as many rows at
// the far end (the end the reader is reading away from), a spacer of their
// measured height standing in; reading back draws them again and drops
// from the other end. Leaving the list and coming back: 30 again.
//
// A fresh list is drawn from its FIRST row (a ticket is top-aligned: it
// opens on the brief, the oldest comments under it), and arrivals draw at
// once while that is the whole list. Following the newest (after Send,
// "New comment ↓"), the window is the newest 30 and the oldest drop off
// once scrolling is quiet. Rows never measured count 0 above and an
// estimate below; a window change holds the row under the reader's eye
// where it was. Only the edge the reader is scrolling toward grows (a
// window at the cap would otherwise see-saw between its two edges), and a
// row still on screen never drops, even if that leaves the window a
// little over 50 (rows shorter than a screen / 50).
//
// Rows in the window carry `data-win-row` and `data-row-key`.

/** Rows drawn when a list opens (and while following the newest). */
export const RENDER_WINDOW_OPEN_ROWS = WINDOW_ROWS;
/** The most rows drawn at once while reading through a list. */
export const RENDER_WINDOW_MAX_ROWS = 50;
/** Rows drawn (and, at the cap, dropped at the far end) per step. */
export const RENDER_WINDOW_STEP = RENDER_WINDOW_MAX_ROWS - RENDER_WINDOW_OPEN_ROWS;

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
  /** Which way the reader last scrolled: -1 up, 1 down, 0 not yet. */
  const dir = useRef(0);
  const lastTop = useRef(0);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const { room, keys } = o;
  if (heights.current.room !== room) heights.current = { room, px: new Map() };
  if (winRef.current && winRef.current.room !== room) winRef.current = null;
  // A fresh list (or one that just got its first rows): from the top.
  if (!winRef.current && keys.length) {
    winRef.current = {
      room,
      win: pinWindow(keys, { lo: 0, hi: Math.min(keys.length, RENDER_WINDOW_OPEN_ROWS) }),
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
      if (hi - lo <= RENDER_WINDOW_OPEN_ROWS) return "done";
      if (!idle) return "busy";
      const start = Math.max(0, len - RENDER_WINDOW_OPEN_ROWS);
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
    // Rows that may drop: wholly off screen.
    const clearAbove = (r: HTMLElement) => y(r) + r.offsetHeight <= st;
    const clearBelow = (r: HTMLElement) => y(r) >= st + ch;
    const up = dir.current <= 0;
    const down = dir.current >= 0;
    if (up && lo > 0 && y(first) > st - WINDOW_RESPAWN_SCREENS * ch) {
      // Reading up: draw a step above; at the cap, drop as many below.
      const nextLo = Math.max(0, lo - RENDER_WINDOW_STEP);
      let nextHi = hi;
      const leaving: HTMLElement[] = [];
      for (let i = shown.length - 1; i > 0 && nextHi - nextLo > RENDER_WINDOW_MAX_ROWS; i--) {
        if (!clearBelow(shown[i]) || indexOf(shown[i]) !== nextHi - 1) break;
        leaving.push(shown[i]);
        nextHi--;
      }
      rememberHeights(leaving);
      setWindow(pinWindow(k, { lo: nextLo, hi: nextHi }), true);
      return "done";
    }
    if (down && hi < len && y(last) + last.offsetHeight < st + ch + WINDOW_RESPAWN_SCREENS * ch) {
      // Reading down: draw a step below; at the cap, drop as many above.
      const nextHi = Math.min(len, hi + RENDER_WINDOW_STEP);
      let nextLo = lo;
      const leaving: HTMLElement[] = [];
      for (let i = 0; i < shown.length - 1 && nextHi - nextLo > RENDER_WINDOW_MAX_ROWS; i++) {
        if (!clearAbove(shown[i]) || indexOf(shown[i]) !== nextLo) break;
        leaving.push(shown[i]);
        nextLo++;
      }
      rememberHeights(leaving);
      setWindow(pinWindow(k, { lo: nextLo, hi: nextHi }), true);
      return "done";
    }
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
    if (k.length > RENDER_WINDOW_OPEN_ROWS || range.lo > 0 || range.hi < k.length) scheduleIdle.current();
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
      setWindow(pinWindow(k, { lo: Math.max(0, k.length - RENDER_WINDOW_OPEN_ROWS), hi: k.length }), false);
    },
    onScroll() {
      const el = opts.current.scroller();
      if (el) {
        const top = el.scrollTop;
        if (top !== lastTop.current) dir.current = top < lastTop.current ? -1 : 1;
        lastTop.current = top;
      }
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
