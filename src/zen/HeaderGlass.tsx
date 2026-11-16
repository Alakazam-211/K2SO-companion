import { useLayoutEffect, useRef } from "react";
import { renderGlassMasks, shapeFromRect, type GlassShape } from "./glassMerge";
import { PRESSING_CLASS } from "../lib/usePressSpring";

/** Decode a mask image before it is shown: a new data URL set straight
 *  onto mask-image is decoded asynchronously by WebKit, and the merged
 *  glass shows unmasked for that frame (the flash on Back from Chatter,
 *  Riley 2026-11-16). Resolves even when decoding isn't available. */
function decoded(url: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  const img = new Image();
  img.src = url;
  return typeof img.decode === "function" ? img.decode().catch(() => undefined) : Promise.resolve();
}

/** Marks a glass piece of the chat header: `button` pieces keep their own
 *  outline among themselves; the `pill` (agent name) melts into them. */
export const GLASS_SHAPE_ATTR = "data-glass-shape";
/** Set on the header once the merged layer is drawn: the pieces drop their
 *  own glass (CSS `[data-glass-merged] [data-glass-shape]`). Until then,
 *  or without a canvas, each keeps its `.zen-glass`. */
export const GLASS_MERGED_ATTR = "data-glass-merged";
/** On a header part that is hidden for now (search open): its pieces are
 *  left out of the merged outline until it comes back. */
export const GLASS_HIDDEN_ATTR = "data-glass-hidden";

/**
 * The chat header's merged glass (glassMerge.ts): a frosted fill and a rim
 * layer under the header's pieces, masked to their merged outline. Redrawn
 * when a piece's size changes (another agent's name, the server line, the
 * back button's unread count) or the header resizes, never per frame: the
 * keyboard and swipe-back move the whole header.
 *
 * The host is this layer's own parent (the header grid), read from the
 * fill's DOM node: a parent's React ref is attached only AFTER its
 * children's layout effects run, so a ref passed down is still null here
 * on first mount (4.1.0 build 202610221908 never merged because of it).
 */
export function HeaderGlass() {
  const fillRef = useRef<HTMLDivElement>(null);
  const rimRef = useRef<HTMLDivElement>(null);
  // Veil's two shadows under the merged outline (LiquidGlassJS's CSS
  // material: an ambient lift and a 1px contact), each masked to the fill.
  const ambientRef = useRef<HTMLSpanElement>(null);
  const contactRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const fill = fillRef.current;
    const rim = rimRef.current;
    const host = fill?.parentElement ?? null;
    if (!host || !fill || !rim || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let lastKey = "";
    let retry = 0;
    let generation = 0;
    const draw = () => {
      frame = 0;
      // A piece mid-press is scaled by its spring (a transform), so its rect
      // isn't its real outline: measuring it would redraw the masks twice
      // around every tap. Wait until the spring settles.
      if (host.querySelector(`[${GLASS_SHAPE_ATTR}].${PRESSING_CLASS}`)) {
        if (!retry) retry = window.setTimeout(() => {
          retry = 0;
          schedule();
        }, 120);
        return;
      }
      const base = host.getBoundingClientRect();
      const buttons: GlassShape[] = [];
      let pill: GlassShape | null = null;
      for (const el of host.querySelectorAll<HTMLElement>(`[${GLASS_SHAPE_ATTR}]`)) {
        if (el.closest(`[${GLASS_HIDDEN_ATTR}]`)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const s = shapeFromRect(r, base);
        if (el.getAttribute(GLASS_SHAPE_ATTR) === "pill") pill = s;
        else buttons.push(s);
      }
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      // Veil draws iOS's light edge in the rim (glassMerge.ts).
      const style = document.documentElement.getAttribute("data-scheme") === "light" ? "light" : "dark";
      const key = JSON.stringify([Math.round(base.width), Math.round(base.height), dpr, buttons, pill, style]);
      if (key === lastKey) return;
      lastKey = key;
      const masks = buttons.length || pill ? renderGlassMasks(base.width, base.height, dpr, buttons, pill, undefined, style) : null;
      if (!masks) {
        host.removeAttribute(GLASS_MERGED_ATTR);
        return;
      }
      const apply = () => {
        fill.style.webkitMaskImage = fill.style.maskImage = `url(${masks.fill})`;
        for (const drop of [ambientRef.current, contactRef.current]) {
          if (drop) drop.style.webkitMaskImage = drop.style.maskImage = `url(${masks.fill})`;
        }
        rim.style.webkitMaskImage = rim.style.maskImage = `url(${masks.rim})`;
        host.setAttribute(GLASS_MERGED_ATTR, "1");
      };
      // The first draw shows at once (nothing to flash from); later ones
      // swap only once both images are decoded, and only if still current.
      if (!host.hasAttribute(GLASS_MERGED_ATTR)) {
        apply();
        return;
      }
      const mine = ++generation;
      void Promise.all([decoded(masks.fill), decoded(masks.rim)]).then(() => {
        if (mine === generation) apply();
      });
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
    // Pieces come and go (Done vs back, a group chat's single button, the
    // parts search hides).
    const mo = new MutationObserver(() => {
      watch();
      schedule();
    });
    mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: [GLASS_HIDDEN_ATTR] });
    // Light <-> dark palette: the rim is drawn differently (glassMerge.ts).
    const scheme = new MutationObserver(schedule);
    scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
    schedule();
    return () => {
      generation += 1;
      if (retry) window.clearTimeout(retry);
      scheme.disconnect();
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      host.removeAttribute(GLASS_MERGED_ATTR);
    };
  }, []);
  return (
    <>
      <div aria-hidden className="zen-glass-merged-drop zen-glass-merged-drop--ambient">
        <span ref={ambientRef} />
      </div>
      <div aria-hidden className="zen-glass-merged-drop zen-glass-merged-drop--contact">
        <span ref={contactRef} />
      </div>
      <div ref={fillRef} aria-hidden className="zen-glass-merged-fill" data-testid="header-glass-fill" />
      <div ref={rimRef} aria-hidden className="zen-glass-merged-rim" data-testid="header-glass-rim" />
    </>
  );
}
