import { useLayoutEffect, useRef, type RefObject } from "react";
import { renderGlassMasks, shapeFromRect, type GlassShape } from "./glassMerge";

/** Marks a glass piece of the chat header: `button` pieces keep their own
 *  outline among themselves; the `pill` (agent name) melts into them. */
export const GLASS_SHAPE_ATTR = "data-glass-shape";
/** Set on the header once the merged layer is drawn: the pieces drop their
 *  own glass (CSS `[data-glass-merged] [data-glass-shape]`). Until then,
 *  or without a canvas, each keeps its `.zen-glass`. */
export const GLASS_MERGED_ATTR = "data-glass-merged";

/**
 * The chat header's merged glass (glassMerge.ts): a frosted fill and a rim
 * layer under the header's pieces, masked to their merged outline. Redrawn
 * when a piece's size changes (another agent's name, the server line, the
 * back button's unread count) or the header resizes, never per frame: the
 * keyboard and swipe-back move the whole header.
 */
export function HeaderGlass({ hostRef }: { hostRef: RefObject<HTMLElement | null> }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const rimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const fill = fillRef.current;
    const rim = rimRef.current;
    if (!host || !fill || !rim || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let lastKey = "";
    const draw = () => {
      frame = 0;
      const base = host.getBoundingClientRect();
      const buttons: GlassShape[] = [];
      let pill: GlassShape | null = null;
      for (const el of host.querySelectorAll<HTMLElement>(`[${GLASS_SHAPE_ATTR}]`)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const s = shapeFromRect(r, base);
        if (el.getAttribute(GLASS_SHAPE_ATTR) === "pill") pill = s;
        else buttons.push(s);
      }
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const key = JSON.stringify([Math.round(base.width), Math.round(base.height), dpr, buttons, pill]);
      if (key === lastKey) return;
      lastKey = key;
      const masks = buttons.length || pill ? renderGlassMasks(base.width, base.height, dpr, buttons, pill) : null;
      if (!masks) {
        host.removeAttribute(GLASS_MERGED_ATTR);
        return;
      }
      fill.style.webkitMaskImage = fill.style.maskImage = `url(${masks.fill})`;
      rim.style.webkitMaskImage = rim.style.maskImage = `url(${masks.rim})`;
      host.setAttribute(GLASS_MERGED_ATTR, "1");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(schedule);
    const watch = () => {
      ro.disconnect();
      ro.observe(host);
      for (const el of host.querySelectorAll(`[${GLASS_SHAPE_ATTR}]`)) ro.observe(el);
    };
    watch();
    // Pieces come and go (Done vs back, a group chat's single button).
    const mo = new MutationObserver(() => {
      watch();
      schedule();
    });
    mo.observe(host, { childList: true, subtree: true });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      host.removeAttribute(GLASS_MERGED_ATTR);
    };
  }, [hostRef]);
  return (
    <>
      <div ref={fillRef} aria-hidden className="zen-glass-merged-fill" data-testid="header-glass-fill" />
      <div ref={rimRef} aria-hidden className="zen-glass-merged-rim" data-testid="header-glass-rim" />
    </>
  );
}
