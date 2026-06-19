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
  // Daemon wire field is `runs` (grid_snapshot.rs DamagedRow.runs). Using
  // `cells` made every delta throw in cellRowToCompact (undefined is not
  // iterable) and get swallowed by the WS onmessage try/catch — so deltas
  // never applied and the viewport only refreshed on (re)snapshots.
  runs: CellRun[];
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

// Two-buffer terminal model, mirrors the daemon's grid emitter:
//   - `scrollback` only GROWS (delta.scrollbackAppended = rows that
//     scrolled off the top of the viewport).
//   - `viewport` = the bottom `rows` rows; a snapshot replaces it
//     wholesale, a delta patches the rows named in `damagedRows`.
// Absolute row = scrollback index, then scrollback.length + viewport
// index. `lines()` flattens to absolute-row CompactLines for the
// renderer. Pure + deterministic, so it's unit-testable without a live
// daemon (see scripts/test-grid-convert.mjs).
export class GridModel {
  scrollback: CompactLineLite[] = [];
  viewport: CompactLineLite[] = [];
  cols = 0;
  cursorCol = 0;
  cursorVisible = true;
  /** viewport-relative cursor row from the latest frame */
  private cursorVpRow = 0;
  readonly maxScrollback = 1000;

  applySnapshot(p: TermGridSnapshot): void {
    this.scrollback = p.scrollback.map((r, i) => cellRowToCompact(r, i));
    this.viewport = p.grid.map((r, i) => cellRowToCompact(r, i));
    this.cols = p.cols;
    this.setCursor(p.cursor);
  }

  applyDelta(p: TermGridDelta): void {
    for (const row of p.scrollbackAppended) {
      this.scrollback.push(cellRowToCompact(row, this.scrollback.length));
    }
    for (const d of p.damagedRows) {
      if (d.row >= 0 && d.row < this.viewport.length) {
        this.viewport[d.row] = cellRowToCompact(d.runs, d.row);
      }
    }
    this.cols = p.cols;
    this.setCursor(p.cursor);
  }

  private setCursor(c: CursorSnapshot): void {
    this.cursorVpRow = c.row;
    this.cursorCol = c.col;
    this.cursorVisible = c.visible;
  }

  private trim(): void {
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - this.maxScrollback);
    }
  }

  /** Flattened absolute-row lines for the renderer. */
  lines(): CompactLineLite[] {
    this.trim();
    const sb = this.scrollback.length;
    const out: CompactLineLite[] = [];
    for (let i = 0; i < sb; i++) out.push({ ...this.scrollback[i], row: i });
    for (let i = 0; i < this.viewport.length; i++) {
      out.push({ ...this.viewport[i], row: sb + i });
    }
    return out;
  }

  /** Absolute cursor row (scrollback + viewport-relative). */
  cursorRow(): number {
    return this.scrollback.length + this.cursorVpRow;
  }

  totalRows(): number {
    return this.scrollback.length + this.viewport.length;
  }
}
