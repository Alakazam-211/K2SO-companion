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
  /** Soft-wrap continuation flag; key absent when false on both the
   *  JSON path (serde skip_serializing_if) and the k1 binary path. */
  wrapped?: boolean;
  /** Terminal-column span, present only when it differs from the run's
   *  char count (double-width CJK/emoji or zero-width combining chars).
   *  Absent ⇒ one column per char (grid_snapshot.rs::CellRun contract). */
  cols?: number;
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
  // ── k1-only extras (decoded by gridWire.ts; absent on the JSON path
  //    from older daemons — T2 consumes these, additive until then) ──
  paneId?: string;
  mouseReport?: boolean;
  sgrMouse?: boolean;
  altScreen?: boolean;
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
  /** k1-only (absent on the JSON path from older daemons). */
  paneId?: string;
}

// Style flag bits — mirror grid_types.rs ATTR_* (TerminalView reads `fl`).
export const FL_BOLD = 1;
export const FL_ITALIC = 2;
export const FL_UNDERLINE = 4;
export const FL_STRIKE = 8;
export const FL_INVERSE = 16;
export const FL_DIM = 32;

/** The run-boundary + column-span data a CompactLine keeps so the
 *  renderer can do faithful terminal-column math (wide CJK/emoji =
 *  2 columns, zero-width combiners = 0). Shape matches the desktop's
 *  `runCols.ts` ColRun so the column helpers port unchanged in T2. */
export interface ColSpanRun {
  text: string;
  /** Terminal-column span; absent ⇒ one column per char. */
  cols?: number;
}

export interface CompactLineLite {
  row: number;
  text: string;
  spans: { s: number; e: number; fg?: number; bg?: number; fl?: number }[];
  wrapped: boolean;
  /** Per-run column spans, preserved from the wire (T1: data model
   *  only; T2 renders with them). Additive — existing consumers keep
   *  reading text/spans. */
  runs: ColSpanRun[];
}

/** Convert one row of CellRuns into a CompactLine the renderer accepts. */
export function cellRowToCompact(runs: CellRun[], row: number): CompactLineLite {
  let text = "";
  const spans: CompactLineLite["spans"] = [];
  const colRuns: ColSpanRun[] = [];
  let wrapped = false;
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
    // Faithful data model: keep run boundaries + the wire's explicit
    // column span (key absent ⇒ one column per char, by contract).
    colRuns.push(r.cols !== undefined ? { text: r.text, cols: r.cols } : { text: r.text });
    if (r.wrapped) wrapped = true;
  }
  return { row, text, spans, wrapped, runs: colRuns };
}

// ── Terminal-column math (desktop runCols.ts port, T2 subset) ──────
//
// The daemon skips alacritty's WIDE_CHAR_SPACER cells when building
// runs, so a run's text has NO phantom columns — but a double-width
// char (CJK/emoji) still occupies TWO terminal columns while being ONE
// char, and zero-width chars (combining accents, ZWJ) occupy ZERO.
// Runs whose column span differs from their char count carry it
// explicitly as `cols`; runs without the field are one-column-per-char
// by contract. Pure, unit-tested in scripts/test-scale-claim.mjs.

/** Width classifiers — mirror Rust's unicode-width dominant ranges
 *  (what alacritty sets WIDE_CHAR from). Only consulted for runs that
 *  CARRY a `cols` annotation; a divergence on an exotic code point
 *  costs one column of placement bias inside that run, never a render
 *  break — the run's total span comes from the wire. */
export function isZeroWidthCp(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x0483 && cp <= 0x0489) || // Cyrillic combining
    (cp >= 0x0591 && cp <= 0x05bd) || // Hebrew points
    (cp >= 0x0610 && cp <= 0x061a) || // Arabic marks
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
    cp === 0x200b || // ZWSP
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff // BOM/ZWNBSP
  );
}

export function isWideCp(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana..CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo ext A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji: misc + emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // emoji: transport
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // emoji: supplemental
    (cp >= 0x1fa00 && cp <= 0x1faff) || // emoji: extended A
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  );
}

/** Char count of a run in code points (what the wire's `cols`
 *  contract compares against). */
function codePointCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Column span of one run: explicit wire `cols` when present, else
 *  its code-point count (the daemon omits the field iff equal). */
export function runColSpan(run: ColSpanRun): number {
  return run.cols ?? codePointCount(run.text);
}

/** Start column of each run in a row — prefix sums of the runs'
 *  column spans. Paired with `runColSpan` it pins each run to its
 *  true grid rect, so a wide/exotic glyph can never push the runs to
 *  its right off their columns. Empty row ⇒ empty array. */
export function runColOffsets(row: ColSpanRun[]): number[] {
  const out: number[] = new Array(row.length);
  let col = 0;
  for (let i = 0; i < row.length; i++) {
    out[i] = col;
    col += runColSpan(row[i]);
  }
  return out;
}

/** One per-character cell of a run: its text (a single code point
 *  plus any zero-width followers), its column offset WITHIN the run,
 *  and its column width. */
export interface RunCell {
  text: string;
  col: number;
  width: number;
}

/** Split one run into per-character cells for column-anchored
 *  rendering. Zero-width followers ride their base char's cell;
 *  unannotated runs are one column per code point by the wire
 *  contract. If the daemon's `cols` ever disagreed with the width
 *  table the divergence stays INSIDE this run — the next run's offset
 *  comes from the wire span (runColOffsets). */
export function runCells(run: ColSpanRun): RunCell[] {
  const annotated = run.cols !== undefined;
  const out: RunCell[] = [];
  let col = 0;
  for (const ch of run.text) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = annotated ? (isZeroWidthCp(cp) ? 0 : isWideCp(cp) ? 2 : 1) : 1;
    if (w === 0 && out.length > 0) {
      // Zero-width follower: render with its base char's cell.
      out[out.length - 1].text += ch;
      continue;
    }
    const width = Math.max(w, 1);
    out.push({ text: ch, col, width });
    col += width;
  }
  return out;
}

/** True when a row carries any run whose column span differs from its
 *  char count — the renderer switches that row from flowing spans to
 *  column-anchored cells (wide CJK/emoji, zero-width combiners). */
export function rowNeedsAnchoring(runs: ColSpanRun[]): boolean {
  for (const r of runs) if (r.cols !== undefined) return true;
  return false;
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

  /** True when the viewport has no visible content — the
   *  hold-and-scale park check (TerminalView): during a resize hold,
   *  a blank merge result (the daemon's cleared-grid intermediate)
   *  must not paint, or the reflow flashes black. */
  viewportBlank(): boolean {
    for (const l of this.viewport) {
      if (l.text.trim() !== "") return false;
    }
    return true;
  }

  /** Absolute cursor row (scrollback + viewport-relative). */
  cursorRow(): number {
    return this.scrollback.length + this.cursorVpRow;
  }

  totalRows(): number {
    return this.scrollback.length + this.viewport.length;
  }
}
