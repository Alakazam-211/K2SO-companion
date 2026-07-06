// ── Selection → clipboard text (T6, desktop copyText.ts port) ──────
//
// Rebuilds the copied text purely from the renderer's row model
// (CompactLine: joined text + ColSpanRun boundaries + the wrapped
// flag). Semantics are the desktop's, unchanged:
//   - per-line trailing whitespace is trimmed (the padded-row wire
//     format otherwise hands out phantom spaces),
//   - empty/missing rows contribute a bare newline,
//   - soft-wrapped rows join WITHOUT a newline and WITHOUT trim (the
//     break is mid-content; the converter latches the daemon's
//     `wrapped` run flag onto the line),
//   - column boundaries convert through cluster math so either half
//     of a double-width char selects the whole char (xterm's
//     wide-char end-inclusion).
//
// Pure — Node-tested in scripts/test-copy-select.mjs. The width
// tables live in api/gridConvert.ts (one classifier for rendering,
// hit-testing AND copying, so they can never disagree).

import { isWideCp, isZeroWidthCp, type ColSpanRun } from "../api/gridConvert";
import type { NormalizedSelection } from "./touchSelect";

/** The slice of a renderer row this module needs (CompactLine subset;
 *  HTTP-fallback rows carry bare text and no runs). */
export interface CopyRow {
  text: string;
  runs?: ColSpanRun[];
  wrapped?: boolean;
}

/** Row accessor — TerminalView passes `(abs) => linesRef.get(abs)`. */
export type RowAt = (abs: number) => CopyRow | undefined;

/** A row's runs, synthesizing a one-column-per-char run for bare-text
 *  rows (the HTTP fallback / legacy path) so the column math holds. */
function rowRuns(row: CopyRow | undefined): ColSpanRun[] {
  if (!row) return [];
  if (row.runs && row.runs.length > 0) return row.runs;
  return row.text.length > 0 ? [{ text: row.text }] : [];
}

// ── Cluster math (desktop runCols.ts::rowClusters port) ────────────

/** One code point's placement in a row: its UTF-16 range in the
 *  joined text and its column range. Zero-width chars fold into the
 *  preceding cluster (they render with it and can never be hit
 *  independently). */
export interface Cluster {
  utf16Start: number;
  utf16End: number;
  colStart: number;
  width: number;
}

export function rowClusters(runs: ColSpanRun[]): Cluster[] {
  const out: Cluster[] = [];
  let col = 0;
  let u16 = 0;
  for (const run of runs) {
    // Fast path: unannotated run ⇒ every code point is one column
    // (the wire contract — the daemon omits `cols` iff equal).
    const annotated = run.cols !== undefined;
    for (const ch of run.text) {
      const cp = ch.codePointAt(0) ?? 0;
      const w = annotated ? (isZeroWidthCp(cp) ? 0 : isWideCp(cp) ? 2 : 1) : 1;
      if (w === 0 && out.length > 0) {
        out[out.length - 1].utf16End += ch.length;
        u16 += ch.length;
        continue;
      }
      out.push({
        utf16Start: u16,
        utf16End: u16 + ch.length,
        colStart: col,
        width: Math.max(w, 1),
      });
      u16 += ch.length;
      col += Math.max(w, 1);
    }
  }
  return out;
}

/** UTF-16 start boundary for a terminal-column start boundary: the
 *  first cluster any of whose columns is ≥ `col` (a start landing on
 *  the second half of a wide char includes the whole char). Columns
 *  past the row's content map to the text length (empty segment). */
export function colToTextStart(runs: ColSpanRun[], col: number): number {
  const clusters = rowClusters(runs);
  for (const c of clusters) {
    if (c.colStart + c.width > col) return c.utf16Start;
  }
  const last = clusters[clusters.length - 1];
  return last ? last.utf16End : 0;
}

/** UTF-16 end boundary for an EXCLUSIVE terminal-column end boundary:
 *  past the last cluster that starts before `col` (an end landing
 *  inside a wide char includes it). */
export function colToTextEnd(runs: ColSpanRun[], col: number): number {
  const clusters = rowClusters(runs);
  let end = 0;
  for (const c of clusters) {
    if (c.colStart < col) end = c.utf16End;
    else break;
  }
  return end;
}

// ── Text assembly ──────────────────────────────────────────────────

/** Build the copied text for an inclusive row range with UTF-16 TEXT
 *  offsets at the boundaries. */
export function buildCopyText(
  rowAt: RowAt,
  startAbs: number,
  startOffset: number,
  endAbs: number,
  endOffset: number,
): string {
  let out = "";
  for (let abs = startAbs; abs <= endAbs; abs++) {
    const row = rowAt(abs);
    const text = row?.text ?? "";
    const from = abs === startAbs ? startOffset : 0;
    const to = abs === endAbs ? endOffset : text.length;
    const seg = text.slice(from, Math.max(from, to));
    if (abs < endAbs && row?.wrapped === true) {
      // Soft-wrap continuation — no newline, no trim (the break is
      // mid-content).
      out += seg;
    } else {
      out += seg.replace(/\s+$/, "");
      if (abs < endAbs) out += "\n";
    }
  }
  return out;
}

/** Copy text for a normalized grid-coordinate selection: convert the
 *  head/tail rows' column boundaries to text offsets through the
 *  cluster math, then assemble via buildCopyText. */
export function copySelectionText(
  rowAt: RowAt,
  sel: NormalizedSelection,
): string {
  const start = colToTextStart(rowRuns(rowAt(sel.startAbs)), sel.startCol);
  const end = colToTextEnd(rowRuns(rowAt(sel.endAbs)), sel.endCol);
  return buildCopyText(rowAt, sel.startAbs, start, sel.endAbs, end);
}
