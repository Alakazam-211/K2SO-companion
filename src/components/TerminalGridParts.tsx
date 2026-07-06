// Presentational halves of the faithful terminal grid (T2) — NO
// sockets, stores or effects, so both render headlessly
// (scripts/test-terminal-render.mjs) and TerminalView stays the only
// stateful piece.
//
//   FixedRow       — one grid row at exactly `cols` columns (never
//                    wraps; wide/zero-width runs column-anchored).
//   TerminalCursor — the terminal's own cursor painted at its true
//                    cell (T4: Direct typing echoes THROUGH the PTY,
//                    so this cursor is the only caret the user sees).
//   TerminalChrome — the badge/pill strip above the grid ("Claim
//                    session", claimed/pinned badges, "viewing at
//                    C×R" pill, view-only pill).
//   SelectionOverlay / CopyAffordance / ToastPill /
//   ClipboardFallbackPill — the T6 touch-selection + clipboard UX
//                    (highlight rects, the post-release Copy button,
//                    the transient "Copied" pill, and the WKWebView
//                    manual-copy fallback).

import type { CSSProperties, ReactNode } from "react";
import {
  rowNeedsAnchoring,
  runCells,
  runColOffsets,
  runColSpan,
  type ColSpanRun,
} from "../api/gridConvert";
import {
  pinnedByOther,
  showClaimButton,
  type ClaimState,
} from "../lib/claimState";
import type { RowSegment } from "../lib/touchSelect";

// ── Shared paint constants (TerminalView imports these) ──

export const DEFAULT_FG = 0xe0e0e0;
export const DEFAULT_BG = 0x0a0a0a;

export const ATTR_BOLD = 1;
export const ATTR_ITALIC = 2;
export const ATTR_UNDERLINE = 4;
export const ATTR_STRIKETHROUGH = 8;
export const ATTR_INVERSE = 16;
export const ATTR_DIM = 32;
export const ATTR_HIDDEN = 64;

export function colorToCSS(c: number): string {
  return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`;
}

export interface StyleSpan {
  s: number;
  e: number;
  fg?: number;
  bg?: number;
  fl?: number;
}

/** Row data FixedRow accepts — the WS path's CompactLineLite shape
 *  (runs from gridConvert) or the HTTP fallback's bare text. */
export interface RowLine {
  text: string;
  spans?: StyleSpan[];
  runs?: ColSpanRun[];
}

function styleFor(span: StyleSpan | undefined): CSSProperties | undefined {
  if (!span) return undefined;
  const style: CSSProperties = {};
  const flags = span.fl ?? 0;
  let fg = span.fg ?? DEFAULT_FG;
  let bg = span.bg ?? DEFAULT_BG;
  if (flags & ATTR_INVERSE) {
    const tmp = fg;
    fg = bg;
    bg = tmp;
  }
  if (fg !== DEFAULT_FG) style.color = colorToCSS(fg);
  if (bg !== DEFAULT_BG) style.backgroundColor = colorToCSS(bg);
  if (flags & ATTR_BOLD) style.fontWeight = "bold";
  if (flags & ATTR_ITALIC) style.fontStyle = "italic";
  if (flags & ATTR_DIM) style.opacity = 0.7;
  if (flags & ATTR_HIDDEN) style.color = "transparent";
  if (flags & ATTR_UNDERLINE) style.textDecoration = "underline";
  if (flags & ATTR_STRIKETHROUGH) {
    style.textDecoration = style.textDecoration
      ? `${style.textDecoration} line-through`
      : "line-through";
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/** Zip a row's runs with its style spans. The converter
 *  (cellRowToCompact) emits AT MOST one span per run, starting exactly
 *  at the run's text offset and only when the run is styled — so a
 *  linear walk matches spans to runs without any slicing. */
function runStyles(line: RowLine): (CSSProperties | undefined)[] {
  const runs = line.runs ?? [];
  const spans = line.spans ?? [];
  const out: (CSSProperties | undefined)[] = new Array(runs.length);
  let off = 0;
  let si = 0;
  for (let i = 0; i < runs.length; i++) {
    while (si < spans.length && spans[si].s < off) si++;
    out[i] =
      si < spans.length && spans[si].s === off
        ? styleFor(spans[si])
        : undefined;
    off += runs[i].text.length;
  }
  return out;
}

/** Column-anchored painting for rows carrying wide/zero-width runs:
 *  every run is absolutely positioned at its true column rect, and
 *  ANNOTATED runs additionally pin each character to its own cell so
 *  a fallback-font advance can never smear the columns. */
function renderAnchored(line: RowLine, cellW: number): ReactNode[] {
  const runs = line.runs ?? [];
  const offsets = runColOffsets(runs);
  const styles = runStyles(line);
  const out: ReactNode[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const base: CSSProperties = {
      position: "absolute",
      top: 0,
      overflow: "hidden",
      whiteSpace: "pre",
      ...styles[i],
    };
    if (run.cols !== undefined) {
      for (const cell of runCells(run)) {
        out.push(
          <span
            key={`${i}-${cell.col}`}
            style={{
              ...base,
              left: (offsets[i] + cell.col) * cellW,
              width: cell.width * cellW,
            }}
          >
            {cell.text}
          </span>
        );
      }
    } else {
      out.push(
        <span
          key={i}
          style={{
            ...base,
            left: offsets[i] * cellW,
            width: runColSpan(run) * cellW,
          }}
        >
          {run.text}
        </span>
      );
    }
  }
  return out;
}

/** Flowing painting for pure single-width rows (the common case):
 *  one span per run in document order inside a `pre` row — uniform
 *  monospace advances keep the columns exact without anchoring. */
function renderFlowing(line: RowLine): ReactNode[] {
  const runs = line.runs ?? [];
  const styles = runStyles(line);
  return runs.map((run, i) => (
    <span key={i} style={styles[i]}>
      {run.text}
    </span>
  ));
}

interface FixedRowProps {
  line: RowLine | undefined;
  /** Terminal columns — the row's fixed width is cols × cellW. */
  cols: number;
  cellW: number;
  lineHeight: number;
}

/** One faithful grid row: exactly `cols` columns wide, one grid row =
 *  one display row, overflow hidden — line wrapping NEVER happens
 *  (an oversized grid is the scale-to-fit layer's job, not wrap's). */
export function FixedRow({ line, cols, cellW, lineHeight }: FixedRowProps) {
  const style: CSSProperties = {
    position: "relative",
    height: lineHeight,
    lineHeight: `${lineHeight}px`,
    width: cols * cellW,
    overflow: "hidden",
    whiteSpace: "pre",
  };
  if (!line || line.text.length === 0) {
    return <div style={style}>{" "}</div>;
  }
  if (line.runs && line.runs.length > 0) {
    return (
      <div style={style} data-k2-row="fixed">
        {rowNeedsAnchoring(line.runs)
          ? renderAnchored(line, cellW)
          : renderFlowing(line)}
      </div>
    );
  }
  // HTTP-fallback rows (bare text, no runs): plain text in the fixed
  // box — still never wraps.
  return <div style={style}>{line.text}</div>;
}

// ── Cursor: the PTY's own cursor at its true grid cell ──

export interface TerminalCursorProps {
  /** Absolute row (scrollback + viewport-relative, the snapshot's
   *  cursor position as TerminalView tracks it). */
  row: number;
  col: number;
  cellW: number;
  lineHeight: number;
  /** Snapshot cursor shape (`block` | `bar`/`beam` | `underline`). */
  shape: string;
  visible: boolean;
}

/** The terminal session's cursor, absolutely positioned over the fixed
 *  grid at exactly its cell rect. Static (no blink) V1: a translucent
 *  fg-colored block so the glyph underneath stays legible — always on
 *  while the stream reports it visible, which is what makes Direct
 *  typing read as "I am typing IN the terminal". */
export function TerminalCursor({
  row,
  col,
  cellW,
  lineHeight,
  shape,
  visible,
}: TerminalCursorProps) {
  if (!visible || cellW <= 0 || row < 0 || col < 0) return null;
  const base: CSSProperties = {
    position: "absolute",
    left: col * cellW,
    top: row * lineHeight,
    pointerEvents: "none",
    background: colorToCSS(DEFAULT_FG),
  };
  if (shape === "bar" || shape === "beam") {
    return (
      <div
        data-k2="cursor"
        data-k2-cursor-shape="bar"
        style={{ ...base, width: 2, height: lineHeight }}
      />
    );
  }
  if (shape === "underline") {
    return (
      <div
        data-k2="cursor"
        data-k2-cursor-shape="underline"
        style={{ ...base, top: row * lineHeight + lineHeight - 2, width: cellW, height: 2 }}
      />
    );
  }
  return (
    <div
      data-k2="cursor"
      data-k2-cursor-shape="block"
      style={{ ...base, width: cellW, height: lineHeight, opacity: 0.55 }}
    />
  );
}

// ── Chrome: badges / pills / the "Claim session" affordance ──

const PILL_BASE: CSSProperties = {
  pointerEvents: "auto",
  fontFamily: "inherit",
  fontSize: 10,
  lineHeight: "16px",
  padding: "3px 8px",
  borderRadius: 4,
  whiteSpace: "nowrap",
};

export interface TerminalChromeProps {
  claim: ClaimState;
  /** Scale layout says we're viewing someone else's dims (unpinned). */
  passive: boolean;
  /** Current grid dims (the pill's C×R). */
  gridCols: number;
  gridRows: number;
  onClaim: () => void;
  onRelease: () => void;
}

/** The compact status strip rendered over the grid's top edge inside
 *  TerminalView. The container ignores pointer events (scroll/touch
 *  pass through to the terminal); only the buttons are targets. */
export function TerminalChrome({
  claim,
  passive,
  gridCols,
  gridRows,
  onClaim,
  onRelease,
}: TerminalChromeProps) {
  const bits: ReactNode[] = [];

  if (claim.claimedByMe) {
    // Loud: this phone owns the size; tap = release (POST clear).
    bits.push(
      <button
        key="claimed"
        data-k2="claimed-badge"
        onClick={onRelease}
        style={{
          ...PILL_BASE,
          background: "var(--accent, #f59e0b)",
          color: "#0a0a0a",
          fontWeight: 700,
          border: "none",
        }}
      >
        ● Claimed — this phone owns the size
      </button>
    );
  } else if (pinnedByOther(claim) && claim.pin) {
    bits.push(
      <span
        key="pinned"
        data-k2="pin-badge"
        style={{
          ...PILL_BASE,
          background: "rgba(245,158,11,0.15)",
          color: "var(--accent, #f59e0b)",
          border: "1px solid var(--accent-dim, rgba(245,158,11,0.4))",
        }}
      >
        ⌖ Pinned {claim.pin.cols}×{claim.pin.rows}
        {claim.pin.setBy ? ` by ${claim.pin.setBy}` : ""}
      </span>
    );
  } else if (claim.mode === "viewer") {
    bits.push(
      <span
        key="viewer"
        data-k2="viewer-pill"
        style={{
          ...PILL_BASE,
          background: "rgba(255,255,255,0.08)",
          color: "rgba(224,224,224,0.7)",
          border: "1px solid rgba(255,255,255,0.15)",
        }}
      >
        View only
      </span>
    );
  }

  if (showClaimButton(claim)) {
    bits.push(
      <button
        key="claim"
        data-k2="claim-button"
        onClick={onClaim}
        style={{
          ...PILL_BASE,
          background: "rgba(10,10,10,0.75)",
          color: "var(--accent, #f59e0b)",
          border: "1px solid var(--accent-dim, rgba(245,158,11,0.4))",
        }}
      >
        Claim session
      </button>
    );
  }

  // Someone else's dims, scaled to fit (never shown while pinned —
  // the pin badge is that state's affordance).
  if (passive && gridCols > 0 && gridRows > 0) {
    bits.push(
      <span
        key="viewing"
        data-k2="viewing-pill"
        style={{
          ...PILL_BASE,
          background: "rgba(10,10,10,0.75)",
          color: "rgba(224,224,224,0.7)",
          border: "1px solid rgba(255,255,255,0.15)",
        }}
      >
        viewing at {gridCols}×{gridRows}
      </span>
    );
  }

  if (bits.length === 0) return null;
  return (
    <div
      data-k2="terminal-chrome"
      style={{
        position: "absolute",
        top: 4,
        right: 8,
        zIndex: 5,
        display: "flex",
        gap: 6,
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      {bits}
    </div>
  );
}

// ── T6: touch selection + clipboard UX ──────────────────────────────

export interface SelectionOverlayProps {
  /** Per-row highlight column ranges (touchSelect.selectionRowSegments). */
  segments: RowSegment[];
  cellW: number;
  lineHeight: number;
}

/** Highlight rects painted in GRID space — rendered inside the same
 *  relative box as the rows + cursor, so the scale transform and the
 *  cursor's coordinate math apply unchanged. Pointer-transparent: the
 *  gesture layer (TerminalView's touch effect) owns all input. */
export function SelectionOverlay({
  segments,
  cellW,
  lineHeight,
}: SelectionOverlayProps) {
  if (cellW <= 0 || segments.length === 0) return null;
  return (
    <div data-k2="selection-overlay" style={{ pointerEvents: "none" }}>
      {segments.map((seg) => (
        <div
          key={seg.abs}
          data-k2="selection-rect"
          style={{
            position: "absolute",
            left: seg.startCol * cellW,
            top: seg.abs * lineHeight,
            width: (seg.endCol - seg.startCol) * cellW,
            height: lineHeight,
            background: "rgba(96,165,250,0.35)",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

export interface CopyAffordanceProps {
  /** Scaled strip coordinates (TerminalView computes them from the
   *  selection tail + scale layout) — px within the sizing shell. */
  left: number;
  top: number;
  onCopy: () => void;
}

/** The post-release "Copy" button, floated near the selection's tail.
 *  Unscaled (rendered OUTSIDE the transformed strip) so it stays
 *  finger-sized however far the grid is shrunk. Marked
 *  `data-k2-copy-ui` so the gesture layer ignores touches on it. */
export function CopyAffordance({ left, top, onCopy }: CopyAffordanceProps) {
  return (
    <button
      data-k2="copy-button"
      data-k2-copy-ui="true"
      onClick={onCopy}
      style={{
        ...PILL_BASE,
        position: "absolute",
        left,
        top,
        zIndex: 6,
        fontSize: 12,
        padding: "6px 14px",
        background: "var(--accent, #f59e0b)",
        color: "#0a0a0a",
        fontWeight: 700,
        border: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
      }}
    >
      Copy
    </button>
  );
}

/** Transient confirmation pill ("Copied") — bottom-centered over the
 *  grid; TerminalView owns the timeout. */
export function ToastPill({ text }: { text: string }) {
  return (
    <div
      data-k2="toast"
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 7,
        pointerEvents: "none",
        ...PILL_BASE,
        fontSize: 11,
        background: "rgba(10,10,10,0.85)",
        color: "var(--text, #e0e0e0)",
        border: "1px solid rgba(255,255,255,0.2)",
      }}
    >
      {text}
    </div>
  );
}

export interface ClipboardFallbackPillProps {
  /** The text that failed to reach the OS clipboard. */
  text: string;
  /** Manual retry — a button tap is a fresh user gesture, so the
   *  WKWebView writeText that just rejected usually succeeds here. */
  onCopy: () => void;
  onDismiss: () => void;
}

/** WKWebView clipboard fallback: writeText can reject outside a
 *  user-gesture-adjacent context (OSC 52 arrives on the wire, not from
 *  a tap). Surface the text with a manual Copy instead of failing
 *  silently. */
export function ClipboardFallbackPill({
  text,
  onCopy,
  onDismiss,
}: ClipboardFallbackPillProps) {
  return (
    <div
      data-k2="clipboard-fallback"
      style={{
        position: "absolute",
        bottom: 12,
        left: 8,
        right: 8,
        zIndex: 7,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        background: "rgba(10,10,10,0.92)",
        border: "1px solid var(--accent-dim, rgba(245,158,11,0.4))",
        borderRadius: 4,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 11,
          color: "var(--text, #e0e0e0)",
        }}
      >
        {text}
      </span>
      <button
        data-k2="clipboard-fallback-copy"
        onClick={onCopy}
        style={{
          ...PILL_BASE,
          background: "var(--accent, #f59e0b)",
          color: "#0a0a0a",
          fontWeight: 700,
          border: "none",
        }}
      >
        Copy
      </button>
      <button
        data-k2="clipboard-fallback-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{
          ...PILL_BASE,
          background: "transparent",
          color: "rgba(224,224,224,0.7)",
          border: "1px solid rgba(255,255,255,0.15)",
        }}
      >
        ✕
      </button>
    </div>
  );
}
