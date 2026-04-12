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
  wrapped?: boolean;
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
const FONT_SIZE = 10;
const LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.35);
const FONT_FAMILY = "'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace";
const RESIZE_DEBOUNCE_MS = 200;

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

    if (span.s > pos) {
      elements.push(
        <span key={`t-${line.row}-${pos}`}>{chars.slice(pos, span.s).join("")}</span>
      );
    }

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
  const cellWRef = useRef(0);
  const subscribedDimsRef = useRef<{ cols: number; rows: number } | null>(null);

  // Measure cell width once
  useEffect(() => {
    const span = document.createElement("span");
    span.style.cssText = `font-family: ${FONT_FAMILY}; font-size: ${FONT_SIZE}px; position: absolute; visibility: hidden; white-space: pre;`;
    span.textContent = "W";
    document.body.appendChild(span);
    cellWRef.current = span.getBoundingClientRect().width;
    document.body.removeChild(span);
  }, []);

  // Calculate terminal dimensions from container
  const calculateDims = useCallback(() => {
    if (!containerRef.current || cellWRef.current === 0) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const cols = Math.max(10, Math.floor((rect.width - 16) / cellWRef.current)); // minus padding
    const rows = Math.max(5, Math.floor(rect.height / LINE_HEIGHT));
    return { cols, rows };
  }, []);

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

  // Subscribe with mobile dimensions + handle resize
  useEffect(() => {
    let polling: ReturnType<typeof setInterval> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastText = "";

    // HTTP fallback for initial load
    const loadContent = async () => {
      const r = await api.readTerminal(projectPath, terminalId, 200);
      if (r.ok && r.data?.lines) {
        const text = r.data.lines.join("\n");
        if (text !== lastText) {
          lastText = text;
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

    // Subscribe via WebSocket with screen dimensions
    const subscribe = () => {
      if (!ws.isConnected) return;
      const dims = calculateDims();
      if (dims) {
        subscribedDimsRef.current = dims;
        ws.request("terminal.subscribe", {
          terminalId,
          cols: dims.cols,
          rows: dims.rows,
        }).catch(() => {});
      } else {
        ws.subscribeTerminal(terminalId);
      }
    };

    // Handle resize (rotation, etc.) — debounced
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!ws.isConnected) return;
        const dims = calculateDims();
        if (dims && subscribedDimsRef.current) {
          const prev = subscribedDimsRef.current;
          if (dims.cols !== prev.cols || dims.rows !== prev.rows) {
            subscribedDimsRef.current = dims;
            ws.request("terminal.resize", {
              terminalId,
              cols: dims.cols,
              rows: dims.rows,
            }).catch(() => {});
          }
        }
      }, RESIZE_DEBOUNCE_MS);
    };

    loadContent();

    // Small delay to let container measure, then subscribe with dims
    setTimeout(subscribe, 100);

    const unsub = ws.on("terminal:grid", (event) => {
      const data = event.payload as { terminalId: string; grid: GridUpdate };
      if (data.terminalId === terminalId) {
        scheduleRender(data.grid);
      }
    });

    // HTTP polling fallback
    if (!ws.isConnected) {
      polling = setInterval(loadContent, 2000);
    }

    // Listen for resize/orientation changes
    window.addEventListener("resize", handleResize);
    const observer = containerRef.current
      ? new ResizeObserver(handleResize)
      : null;
    if (observer && containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      unsub();
      if (ws.isConnected) ws.unsubscribeTerminal(terminalId);
      if (polling) clearInterval(polling);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", handleResize);
      observer?.disconnect();
      subscribedDimsRef.current = null;
    };
  }, [terminalId, projectPath, scheduleRender, applyGridUpdate, calculateDims]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current && grid.displayOffset === 0) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [grid.version]);

  // Build row elements
  const rowElements: React.ReactNode[] = [];
  const totalRows = grid.rows || linesRef.current.size;
  for (let r = 0; r < totalRows; r++) {
    const line = linesRef.current.get(r);
    rowElements.push(
      <div
        key={r}
        style={{
          minHeight: LINE_HEIGHT,
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
