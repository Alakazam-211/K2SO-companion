// Thread render window: a long chat keeps every message in memory (store,
// cache) but only a window of rows in the DOM. Two-ended:
//   - following at the newest: the newest WINDOW_ROWS; as messages come in,
//     the oldest drop off (at an idle moment, far above the view);
//   - scrolled up: rows far above or below the view drop off too, and come
//     back (WINDOW_EXTEND at a time) before the reader reaches them.
// Rows that left are replaced by a spacer of their measured height, so
// scrollHeight and what is on screen never move; a row never measured
// (above: older than anything drawn; below: an arrival while scrolled up)
// counts 0 above (the window's top is then a real edge, restored against a
// visible row when it grows) and an estimate below (out of view either way).
//
// The window is kept by row keys, not indices: messages arriving (end) or
// loaded earlier (start) do not move it. `lo: null` = from the first
// message in memory (a "Load earlier" page shows at once); `hi: null` =
// through the newest (arrivals show at once).

/** Rows drawn while following the newest. The one knob: the rest derive
 *  from it. */
export const WINDOW_ROWS = 30;
/** Rows brought back at a time as the reader nears an edge. */
export const WINDOW_EXTEND = WINDOW_ROWS;
/** A push-tap target outside the window: drawn with this many above… */
export const WINDOW_FOCUS_ABOVE = Math.round(WINDOW_ROWS / 3);
/** …and this many below. */
export const WINDOW_FOCUS_BELOW = WINDOW_ROWS - WINDOW_FOCUS_ABOVE - 1;
/** Bring rows back when the drawn edge is within this many screens. */
export const WINDOW_RESPAWN_SCREENS = 1.5;
/** Drop rows more than this many screens past the view… */
export const WINDOW_KEEP_SCREENS = 2;
/** …once that is at least this many rows (no churn for a few). */
export const WINDOW_TRIM_MIN = Math.max(1, Math.round(WINDOW_ROWS / 3));
/** Height (px) assumed for a row below the window never drawn. */
export const WINDOW_EST_ROW_PX = 72;
/** Quiet time (ms) after a scroll before rows are dropped. */
export const WINDOW_IDLE_MS = 300;

export type ThreadWindow = {
  /** Key of the first drawn message; null = the first in memory. */
  lo: string | null;
  /** Key of the last drawn message; null = the newest. */
  hi: string | null;
};

export type WindowRange = { lo: number; hi: number };

/** The drawn range [lo, hi) of `keys` for `win` (null: the newest `size`).
 *  A key no longer in memory falls back to the newest `size`. */
export function resolveWindow(
  keys: readonly string[],
  win: ThreadWindow | null,
  size = WINDOW_ROWS
): WindowRange {
  const len = keys.length;
  const newest = { lo: Math.max(0, len - size), hi: len };
  if (!win) return newest;
  const lo = win.lo == null ? 0 : keys.indexOf(win.lo);
  const hiAt = win.hi == null ? len - 1 : keys.indexOf(win.hi);
  if (lo < 0 || hiAt < 0 || hiAt < lo) return newest;
  return { lo, hi: hiAt + 1 };
}

/** The window for a drawn range (what `resolveWindow` turns back into it). */
export function pinWindow(keys: readonly string[], range: WindowRange): ThreadWindow {
  return {
    lo: range.lo <= 0 ? null : keys[range.lo] ?? null,
    hi: range.hi >= keys.length ? null : keys[range.hi - 1] ?? null,
  };
}

/** A window drawing message `idx` (a push-tap target) with some context. */
export function windowAround(keys: readonly string[], idx: number): ThreadWindow {
  return pinWindow(keys, {
    lo: Math.max(0, idx - WINDOW_FOCUS_ABOVE),
    hi: Math.min(keys.length, idx + 1 + WINDOW_FOCUS_BELOW),
  });
}

/** Top spacer: the measured rows above the window (never measured: 0). */
export function spacerAbove(
  keys: readonly string[],
  lo: number,
  heights: ReadonlyMap<string, number>
): number {
  let px = 0;
  for (let i = 0; i < lo; i++) px += heights.get(keys[i]) ?? 0;
  return px;
}

/** Bottom spacer: the rows below the window, measured or estimated. */
export function spacerBelow(
  keys: readonly string[],
  hi: number,
  heights: ReadonlyMap<string, number>,
  estimate = WINDOW_EST_ROW_PX
): number {
  let px = 0;
  for (let i = hi; i < keys.length; i++) px += heights.get(keys[i]) ?? estimate;
  return px;
}

/** Where a row starts in the list's flow: above its own top margin. */
function outerTop(el: HTMLElement): number {
  let margin = 0;
  try {
    margin = parseFloat(getComputedStyle(el).marginTop) || 0;
  } catch {
    margin = 0;
  }
  return el.offsetTop - margin;
}

/** What each of `rows` adds to the list's height (its margin, box and the
 *  gap after it): the distance to the next element's start. Layout
 *  offsets, so transforms (a glide, a fade-in rise) do not count. */
export function measureRows(rows: readonly HTMLElement[]): number[] {
  return rows.map((el) => {
    const next = el.nextElementSibling as HTMLElement | null;
    if (next) return Math.max(0, outerTop(next) - outerTop(el));
    let gap = 0;
    try {
      const parent = el.parentElement;
      gap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
    } catch {
      gap = 0;
    }
    return Math.max(0, el.offsetTop + el.offsetHeight - outerTop(el) + gap);
  });
}
