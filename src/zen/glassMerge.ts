// Merged header glass (Rosson 2026-10-22, prototype header-glass "Idea
// 1"): the chat header's glass pieces (back, the name pill, the right
// buttons) are drawn as ONE frosted layer whose outline is their union, so
// the name pill melts into a button it comes close to, like SwiftUI's
// glassEffectUnion. Each piece is a signed distance field (a rounded box);
// the pill joins the buttons with a smooth minimum (Inigo Quilez's smin,
// as LiquidGlassJS's metaballs do) within MERGE_K px, and the buttons keep
// their own outlines among themselves (a plain min).
//
// Output is two alpha masks for HeaderGlass.tsx: the fill (the frosted
// layer) and the rim, which redraws `.zen-glass`'s own edge along the
// merged outline: the 0.5px border at white 22% and the `inset 0 1px 0`
// light catch at white 28%. Pure apart from `renderGlassMasks` (canvas).

/** How far apart (px) the name pill starts to flow into a button. */
export const MERGE_K = 16;
const EDGE_ALPHA = 0.22;
const SHEEN_ALPHA = 0.28;

/** A rounded box in the layer's own px: centre, half size, corner radius. */
export type GlassShape = { cx: number; cy: number; hx: number; hy: number; r: number };

/** Signed distance to a rounded box (negative inside). */
export function sdBox(px: number, py: number, s: GlassShape): number {
  const r = Math.min(s.r, s.hx, s.hy);
  const qx = Math.abs(px - s.cx) - s.hx + r;
  const qy = Math.abs(py - s.cy) - s.hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Smooth minimum: within `k` of each other the two shapes join with a
 *  rounded neck; `k <= 0` is a plain union. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

/** The merged outline's distance at (x, y). */
export function mergedDistance(x: number, y: number, buttons: GlassShape[], pill: GlassShape | null, k = MERGE_K): number {
  let db = Infinity;
  for (const s of buttons) db = Math.min(db, sdBox(x, y, s));
  return pill ? smin(sdBox(x, y, pill), db, k) : db;
}

/** A shape from an element's box, relative to the layer's box. Pills and
 *  circles: the radius is half the short side. */
export function shapeFromRect(r: DOMRect, base: DOMRect): GlassShape {
  return {
    cx: r.left + r.width / 2 - base.left,
    cy: r.top + r.height / 2 - base.top,
    hx: r.width / 2,
    hy: r.height / 2,
    r: Math.min(r.width, r.height) / 2,
  };
}

/** Fill and rim masks as PNG data URLs (null where a canvas is missing,
 *  e.g. jsdom: the pieces then keep their own glass). */
export function renderGlassMasks(
  width: number,
  height: number,
  dpr: number,
  buttons: GlassShape[],
  pill: GlassShape | null,
  k = MERGE_K
): { fill: string; rim: string } | null {
  if (typeof document === "undefined" || width <= 0 || height <= 0) return null;
  const cw = Math.round(width * dpr);
  const ch = Math.round(height * dpr);
  const cf = document.createElement("canvas");
  const cr = document.createElement("canvas");
  cf.width = cr.width = cw;
  cf.height = cr.height = ch;
  let fctx: CanvasRenderingContext2D | null = null;
  let rctx: CanvasRenderingContext2D | null = null;
  try {
    fctx = cf.getContext("2d");
    rctx = cr.getContext("2d");
  } catch {
    return null;
  }
  if (!fctx || !rctx) return null;
  const fimg = fctx.createImageData(cw, ch);
  const rimg = rctx.createImageData(cw, ch);
  const fd = fimg.data;
  const rd = rimg.data;
  // Only rows and columns near a shape can be inside (k past the farthest
  // reach of the neck).
  const all = pill ? [...buttons, pill] : buttons;
  const pad = k + 2;
  const x0 = Math.max(0, Math.floor((Math.min(...all.map((s) => s.cx - s.hx)) - pad) * dpr));
  const x1 = Math.min(cw, Math.ceil((Math.max(...all.map((s) => s.cx + s.hx)) + pad) * dpr));
  const y0 = Math.max(0, Math.floor((Math.min(...all.map((s) => s.cy - s.hy)) - pad) * dpr));
  const y1 = Math.min(ch, Math.ceil((Math.max(...all.map((s) => s.cy + s.hy)) + pad) * dpr));
  const cov = (d: number) => Math.max(0, Math.min(1, 0.5 - d * dpr));
  for (let j = y0; j < y1; j++) {
    const y = (j + 0.5) / dpr;
    for (let i = x0; i < x1; i++) {
      const x = (i + 0.5) / dpr;
      const d = mergedDistance(x, y, buttons, pill, k);
      const a = cov(d);
      const o = (j * cw + i) * 4;
      fd[o + 3] = a * 255;
      if (d > 1.5 || d < -2.5) continue;
      const inner = cov(d + 0.5);
      const edge = (a - inner) * EDGE_ALPHA;
      const sheen = Math.max(0, inner - cov(mergedDistance(x, y - 1, buttons, pill, k) + 0.5)) * SHEEN_ALPHA;
      rd[o + 3] = Math.min(1, edge + sheen) * 255;
    }
  }
  fctx.putImageData(fimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  return { fill: cf.toDataURL(), rim: cr.toDataURL() };
}
