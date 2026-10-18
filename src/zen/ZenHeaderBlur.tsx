import { useCallback, useState, type CSSProperties, type Ref } from "react";

// Shared pieces of the Zen floating header (chat header c39c0ac, Agents
// 0a78ef6): the progressive-blur stack (`.zen-header-blur` in index.css)
// and the measured header height the scroller pads by. Used by the
// Servers and Tickets sheets. `ZenFooterBlur` is the same stack flipped,
// behind the bottom bars (thread composer, search bars).

/** Four masked backdrop-blur layers plus the dark tint. Fills its
 *  (absolute, top:0) header from y=0 and never takes touches.
 *  `variant="heavy"` (open ticket only): full strength through ~60% of a
 *  tall header, then a strip below it once the parent header carries
 *  `data-scrolled="1"` (`.zen-header-blur--heavy` in index.css). */
export function ZenHeaderBlur({
  testId,
  variant,
}: {
  testId?: string;
  variant?: "heavy";
}) {
  return (
    <div
      className={variant === "heavy" ? "zen-header-blur zen-header-blur--heavy" : "zen-header-blur"}
      data-testid={testId}
      aria-hidden
      style={{ pointerEvents: "none" }}
    >
      <span className="zen-header-blur-1" />
      <span className="zen-header-blur-2" />
      <span className="zen-header-blur-3" />
      <span className="zen-header-blur-4" />
      <span className="zen-header-tint" />
    </div>
  );
}

/** How far (px) the footer blur reaches above its bar: content softens
 *  across this band before it meets the bar's top edge. */
export const FOOTER_BLUR_FADE_PX = 24;

/** The header stack flipped (`.zen-footer-blur` in index.css): strongest
 *  at the bottom edge, gone at the top. The caller places the box (full
 *  width, from `FOOTER_BLUR_FADE_PX` above its bar to the pane bottom);
 *  it never takes touches. */
export function ZenFooterBlur({
  testId,
  style,
  elRef,
}: {
  testId?: string;
  style?: CSSProperties;
  elRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={elRef}
      className="zen-footer-blur"
      data-testid={testId}
      aria-hidden
      style={{ pointerEvents: "none", ...style }}
    >
      <span className="zen-footer-blur-1" />
      <span className="zen-footer-blur-2" />
      <span className="zen-footer-blur-3" />
      <span className="zen-footer-blur-4" />
      <span className="zen-footer-tint" />
    </div>
  );
}

/** Height (px, below the safe area) of a floating header's content box.
 *  A callback ref, so a header that unmounts and comes back (a sheet
 *  swapped for a form and back) is measured again. Keeps the last good
 *  height; `fallback` until the first real measure (and in jsdom). */
export function useMeasuredHeight(fallback: number) {
  const [px, setPx] = useState(fallback);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const read = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setPx(h);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, px] as const;
}

/** Scroller top padding: the status bar plus the floating header (+ air). */
export function underHeaderPadding(headerPx: number, gap = 0): string {
  return `calc(env(safe-area-inset-top) + ${Math.ceil(headerPx) + gap}px)`;
}
