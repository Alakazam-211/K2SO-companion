// Pure converter: daemon grid-WS wire frames (alacritty-v2, CellRun rows)
// → the renderer's CompactLine format. No Tauri/runtime imports, so it's
// unit-testable in plain Node (see scripts/test-grid-convert.mjs).

// ── Wire payload shapes (daemon grid_snapshot.rs, camelCase) ──

export interface CellRun {
  text: string;
  fg?: number | null;
  bg?: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  strikeout: boolean;
}
export interface CursorSnapshot {
  row: number;
  col: number;
  visible: boolean;
}
export interface TermGridSnapshot {
  cols: number;
  rows: number;
  grid: CellRun[][];
  scrollback: CellRun[][];
  cursor: CursorSnapshot;
  version: number;
  displayOffset: number;
}
export interface DamagedRow {
  row: number;
  cells: CellRun[];
}
export interface TermGridDelta {
  cols: number;
  rows: number;
  damagedRows: DamagedRow[];
  scrollbackAppended: CellRun[][];
  cursor: CursorSnapshot;
  version: number;
  displayOffset: number;
}

// Style flag bits — mirror grid_types.rs ATTR_* (TerminalView reads `fl`).
export const FL_BOLD = 1;
export const FL_ITALIC = 2;
export const FL_UNDERLINE = 4;
export const FL_STRIKE = 8;
export const FL_INVERSE = 16;
export const FL_DIM = 32;

export interface CompactLineLite {
  row: number;
  text: string;
  spans: { s: number; e: number; fg?: number; bg?: number; fl?: number }[];
  wrapped: boolean;
}

/** Convert one row of CellRuns into a CompactLine the renderer accepts. */
export function cellRowToCompact(runs: CellRun[], row: number): CompactLineLite {
  let text = "";
  const spans: CompactLineLite["spans"] = [];
  for (const r of runs) {
    const s = text.length;
    text += r.text;
    const e = text.length;
    let fl = 0;
    if (r.bold) fl |= FL_BOLD;
    if (r.italic) fl |= FL_ITALIC;
    if (r.underline) fl |= FL_UNDERLINE;
    if (r.strikeout) fl |= FL_STRIKE;
    if (r.inverse) fl |= FL_INVERSE;
    if (r.dim) fl |= FL_DIM;
    const fg = r.fg ?? undefined;
    const bg = r.bg ?? undefined;
    if (fg !== undefined || bg !== undefined || fl) {
      spans.push({ s, e, fg, bg, fl: fl || undefined });
    }
  }
  return { row, text, spans, wrapped: false };
}
