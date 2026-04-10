import { useEffect, useRef, useState, useCallback } from "react";
import { ws } from "../api/websocket";
import * as api from "../api/client";

// ─── Types ───

interface StyleSpan {
  s: number;
  e: number;
  fg?: number;
  bg?: number;
  fl?: number;
}

interface CompactLine {
  row: number;
  text: string;
  spans?: StyleSpan[];
}

interface GridUpdate {
  cols: number;
  rows: number;
  cursor_col: number;
  cursor_row: number;
  cursor_visible: boolean;
  cursor_shape: string;
  lines: CompactLine[];
  full: boolean;
  display_offset?: number;
}

// ─── Constants ───

const DEFAULT_FG = 0xe0e0e0;
const DEFAULT_BG = 0x0a0a0a;
// Scale font to fit ~120 cols on a mobile screen
// iPhone width ~390px minus padding = ~374px usable
// 374px / 120 cols ≈ 3.1px per char — too small to read
// Better: use a readable size with horizontal scroll
const FONT_SIZE = 10;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.35);
const FONT_FAMILY = "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace";

const ATTR_BOLD = 1;
const ATTR_ITALIC = 2;
const ATTR_UNDERLINE = 4;
const ATTR_STRIKETHROUGH = 8;
const ATTR_INVERSE = 16;
const ATTR_DIM = 32;
const ATTR_HIDDEN = 64;

function colorToCSS(c: number): string {
  return `rgb(${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff})`;
}

// ─── Line Renderer ───

function renderLineSpans(line: CompactLine): React.ReactNode[] {
  const chars = [...line.text];
  const spans = line.spans || [];
  const elements: React.ReactNode[] = [];
  let pos = 0;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];

    // Unstyled text before this span
    if (span.s > pos) {
      elements.push(
        <span key={`t-${line.row}-${pos}`}>{chars.slice(pos, span.s).join("")}</span>
      );
    }

    // Styled span
    const style: React.CSSProperties = {};
    const flags = span.fl ?? 0;
    let fg = span.fg ?? DEFAULT_FG;
    let bg = span.bg ?? DEFAULT_BG;

    if (flags & ATTR_INVERSE) {
      const tmp = fg; fg = bg; bg = tmp;
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

    const text = chars.slice(span.s, span.e + 1).join("");
    elements.push(
      <span key={`s-${line.row}-${i}`} style={style}>{text}</span>
    );

    pos = span.e + 1;
  }

  // Remaining unstyled text
  if (pos < chars.length) {
    elements.push(
      <span key={`r-${line.row}`}>{chars.slice(pos).join("")}</span>
    );
  }

  return elements.length > 0 ? elements : ["\u00A0"];
}

// ─── Component ───

interface Props {
  terminalId: string;
  projectPath: string;
}

export function TerminalView({ terminalId, projectPath }: Props) {
  const linesRef = useRef<Map<number, CompactLine>>(new Map());
  const [grid, setGrid] = useState<{
    rows: number;
    cols: number;
    cursorRow: number;
    cursorCol: number;
    cursorVisible: boolean;
    cursorShape: string;
    displayOffset: number;
    version: number;
  }>({
    rows: 0, cols: 0,
    cursorRow: 0, cursorCol: 0,
    cursorVisible: true, cursorShape: "block",
    displayOffset: 0, version: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<GridUpdate | null>(null);

  const applyGridUpdate = useCallback((update: GridUpdate) => {
    if (update.full) {
      linesRef.current.clear();
    }

    for (const line of update.lines) {
      linesRef.current.set(line.row, line);
    }

    setGrid({
      rows: update.rows,
      cols: update.cols,
      cursorRow: update.cursor_row,
      cursorCol: update.cursor_col,
      cursorVisible: update.cursor_visible,
      cursorShape: update.cursor_shape?.toLowerCase() || "block",
      displayOffset: update.display_offset ?? 0,
      version: Date.now(),
    });
  }, []);

  // rAF batching — same pattern as K2SO
  const scheduleRender = useCallback((update: GridUpdate) => {
    pendingRef.current = update;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const frame = pendingRef.current;
      if (frame) {
        pendingRef.current = null;
        applyGridUpdate(frame);
      }
    });
  }, [applyGridUpdate]);

  // Load terminal content and subscribe for updates
  useEffect(() => {
    let polling: ReturnType<typeof setInterval> | null = null;
    let lastText = "";

    // Load initial content via HTTP fallback
    const loadContent = async () => {
      const r = await api.readTerminal(projectPath, terminalId, 200);
      if (r.ok && r.data?.lines) {
        const text = r.data.lines.join("\n");
        if (text !== lastText) {
          lastText = text;
          // Convert plain text lines to CompactLine format
          const lines: CompactLine[] = r.data.lines.map((line, i) => ({
            row: i,
            text: line,
          }));
          applyGridUpdate({
            cols: 120,
            rows: r.data.lines.length,
            cursor_col: 0,
            cursor_row: r.data.lines.length - 1,
            cursor_visible: true,
            cursor_shape: "block",
            lines,
            full: true,
          });
        }
      }
    };

    loadContent();

    // Try WebSocket subscription for real-time grid updates
    if (ws.isConnected) {
      ws.subscribeTerminal(terminalId);
    }

    const unsub = ws.on("terminal:grid", (event) => {
      const data = event.payload as { terminalId: string; grid: GridUpdate };
      if (data.terminalId === terminalId) {
        scheduleRender(data.grid);
      }
    });

    // If WebSocket isn't connected, poll via HTTP
    if (!ws.isConnected) {
      polling = setInterval(loadContent, 2000);
    }

    return () => {
      unsub();
      if (ws.isConnected) ws.unsubscribeTerminal(terminalId);
      if (polling) clearInterval(polling);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [terminalId, projectPath, scheduleRender, applyGridUpdate]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current && grid.displayOffset === 0) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [grid.version]);

  // Measure cell width for cursor positioning
  const cellWRef = useRef(0);
  useEffect(() => {
    const span = document.createElement("span");
    span.style.cssText = `font-family: ${FONT_FAMILY}; font-size: ${FONT_SIZE}px; position: absolute; visibility: hidden; white-space: pre;`;
    span.textContent = "W";
    document.body.appendChild(span);
    cellWRef.current = span.getBoundingClientRect().width;
    document.body.removeChild(span);
  }, []);

  // Build row elements
  const rowElements: React.ReactNode[] = [];
  const totalRows = grid.rows || linesRef.current.size;
  for (let r = 0; r < totalRows; r++) {
    const line = linesRef.current.get(r);
    rowElements.push(
      <div
        key={r}
        style={{
          height: LINE_HEIGHT,
          lineHeight: `${LINE_HEIGHT}px`,
          whiteSpace: "pre",
          overflow: "hidden",
        }}
      >
        {line ? renderLineSpans(line) : "\u00A0"}
      </div>
    );
  }

  const showCursor = grid.cursorVisible && grid.displayOffset === 0;
  const cellW = cellWRef.current;

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-auto"
      style={{
        background: colorToCSS(DEFAULT_BG),
        WebkitOverflowScrolling: "touch",
      }}
    >
      <div
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: `${FONT_SIZE}px`,
          color: colorToCSS(DEFAULT_FG),
          fontVariantLigatures: "none",
          padding: "4px 8px",
          position: "relative",
          minHeight: "100%",
          minWidth: "fit-content",
        }}
      >
        {rowElements}

        {/* Cursor */}
        {showCursor && cellW > 0 && (
          <div
            style={{
              position: "absolute",
              left: 8 + grid.cursorCol * cellW,
              top: 4 + grid.cursorRow * LINE_HEIGHT,
              width: grid.cursorShape === "bar" ? 2.5 : cellW,
              height: grid.cursorShape === "underline" ? 3 : LINE_HEIGHT,
              marginTop: grid.cursorShape === "underline" ? LINE_HEIGHT - 3 : 0,
              background: "rgba(240, 240, 240, 0.85)",
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
        )}
      </div>
    </div>
  );
}
