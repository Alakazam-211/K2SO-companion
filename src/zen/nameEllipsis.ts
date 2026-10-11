/** One ellipsis character (U+2026), never three dots. */
export const ELLIPSIS = "…";

/** Characters always kept at the end of a cut name (owner's ask, was 6:
 *  `very-long-fi…-header.ts`). */
export const MIDDLE_TAIL_CHARS = 10;

/**
 * Shorten `name` to fit `maxWidthPx` by cutting the middle: the last
 * `tail` characters stay, the head keeps as much as fits, and one `…`
 * joins them. A name that fits comes back unchanged. `measure` must grow
 * with string length (canvas `measureText`, or a per-char estimate).
 * Only when `…` plus the tail cannot fit does the tail itself shrink.
 */
export function middleEllipsis(
  name: string,
  maxWidthPx: number,
  measure: (text: string) => number,
  tail = MIDDLE_TAIL_CHARS
): string {
  if (!name || !Number.isFinite(maxWidthPx)) return name;
  if (measure(name) <= maxWidthPx) return name;
  const keep = Math.max(0, Math.min(tail, name.length - 1));
  const end = name.slice(name.length - keep);
  if (keep > 0 && measure(ELLIPSIS + end) <= maxWidthPx) {
    // Largest head that still fits: binary search on its length.
    let lo = 0;
    let hi = name.length - keep - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(name.slice(0, mid) + ELLIPSIS + end) <= maxWidthPx) lo = mid;
      else hi = mid - 1;
    }
    return name.slice(0, lo) + ELLIPSIS + end;
  }
  // Too narrow for the full tail: keep as much of the end as fits.
  for (let k = keep - 1; k >= 1; k--) {
    const t = ELLIPSIS + name.slice(name.length - k);
    if (measure(t) <= maxWidthPx) return t;
  }
  return measure(ELLIPSIS) <= maxWidthPx ? ELLIPSIS : "";
}

let canvasCtx: CanvasRenderingContext2D | null | undefined;

/** Text width in `font` (a CSS font shorthand). Canvas `measureText`
 *  when there is a canvas; otherwise ~0.58em a character. */
export function measureTextPx(text: string, font: string, fontPx: number): number {
  if (canvasCtx === undefined) {
    try {
      // jsdom has no canvas (and logs "not implemented" when asked).
      const jsdom =
        typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "");
      const c =
        typeof document !== "undefined" && !jsdom ? document.createElement("canvas") : null;
      canvasCtx = c && typeof c.getContext === "function" ? c.getContext("2d") : null;
    } catch {
      canvasCtx = null;
    }
  }
  if (canvasCtx) {
    canvasCtx.font = font;
    const w = canvasCtx.measureText(text).width;
    if (Number.isFinite(w) && w > 0) return w;
  }
  return text.length * fontPx * 0.58;
}
