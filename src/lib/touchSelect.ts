// ── Long-press touch selection geometry (T6) ───────────────────────
//
// The selection MODEL for the touch copy flow: long-press (≥500ms,
// still — sgrMouse.ts owns the disambiguation) anchors a selection at
// the pressed cell, dragging adjusts the focus cell, release shows the
// Copy affordance. Everything here is pure grid math — TerminalView's
// touch effect owns the DOM events, TerminalGridParts renders the
// highlight rects from `selectionRowSegments`, and lib/copyText.ts
// extracts the text. Node-tested in scripts/test-copy-select.mjs.
//
// Coordinates are 0-based: `abs` is the absolute strip row (scrollback
// stacked above the viewport — the same space the renderer's row keys
// and lib/copyText.ts use), `col` a terminal column. This differs from
// the 1-based SGR cell space on purpose: selections address the
// BUFFER, not the viewport.

export interface CellPos {
  /** Absolute strip row (0-based; scrollback + viewport). */
  abs: number;
  /** Terminal column (0-based). */
  col: number;
}

/** Live selection: where the long-press landed and where the finger
 *  is now. Focus may precede the anchor (upward/backward drags). */
export interface Selection {
  anchor: CellPos;
  focus: CellPos;
}

/** Normalized form: ordered rows, columns with an EXCLUSIVE end (the
 *  boundary convention the desktop's copySelectionText shares). A
 *  single-cell selection still covers that one cell. */
export interface NormalizedSelection {
  startAbs: number;
  startCol: number;
  endAbs: number;
  /** Exclusive. */
  endCol: number;
}

export function normalizeSelection(sel: Selection): NormalizedSelection {
  const a = sel.anchor;
  const f = sel.focus;
  const forward = a.abs < f.abs || (a.abs === f.abs && a.col <= f.col);
  const start = forward ? a : f;
  const end = forward ? f : a;
  return {
    startAbs: start.abs,
    startCol: start.col,
    endAbs: end.abs,
    endCol: end.col + 1,
  };
}

/** One row's highlighted column range (endCol exclusive). */
export interface RowSegment {
  abs: number;
  startCol: number;
  endCol: number;
}

/** Per-row highlight rects: head row from startCol, tail row to
 *  endCol, interior rows full-width. Rects never collapse to zero
 *  width (a selection you can't see isn't one). */
export function selectionRowSegments(
  n: NormalizedSelection,
  cols: number,
): RowSegment[] {
  const out: RowSegment[] = [];
  for (let abs = n.startAbs; abs <= n.endAbs; abs++) {
    const startCol = abs === n.startAbs ? n.startCol : 0;
    const endCol = abs === n.endAbs ? n.endCol : Math.max(cols, startCol + 1);
    out.push({ abs, startCol, endCol: Math.max(endCol, startCol + 1) });
  }
  return out;
}

// ── Touch point → 0-based absolute cell ────────────────────────────

export interface AbsCellInput {
  /** Touch point in the scroll container's CONTENT space
   *  (clientX/Y − container rect + scrollLeft/Top). */
  x: number;
  y: number;
  /** scaleLayout transform of the painted strip. */
  offsetX: number;
  scale: number;
  /** UNSCALED cell metrics + live grid dims. */
  cellW: number;
  cellH: number;
  cols: number;
  totalRows: number;
  /** Strip padding (TerminalView paints at left 8+offsetX / top 4). */
  padX?: number;
  padY?: number;
}

/** The finger's ABSOLUTE strip cell (0-based, scrollback included),
 *  clamped into the buffer — sgrWheel's cellFromPoint sibling, minus
 *  the viewport re-basing (selections address the buffer). Returns
 *  null when metrics aren't measurable yet (no grid to select in). */
export function absCellFromPoint(p: AbsCellInput): CellPos | null {
  if (p.cellW <= 0 || p.cellH <= 0 || p.cols <= 0 || p.totalRows <= 0) {
    return null;
  }
  const s = p.scale > 0 ? p.scale : 1;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  const col = clamp(
    Math.floor((p.x - (p.padX ?? 8) - p.offsetX) / (p.cellW * s)),
    0,
    p.cols - 1,
  );
  const abs = clamp(
    Math.floor((p.y - (p.padY ?? 4)) / (p.cellH * s)),
    0,
    p.totalRows - 1,
  );
  return { abs, col };
}
