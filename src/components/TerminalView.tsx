import { useEffect, useRef, useState, useCallback } from "react";
import * as api from "../api/client";
import {
  GridSocket,
  GridModel,
  type GridFrame,
  type TermGridSnapshot,
  type TermGridDelta,
} from "../api/gridSocket";

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
// @ts-expect-error Vite injects import.meta.env
const DEV_MODE: boolean = import.meta.env?.DEV ?? false;

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
  const debugRef = useRef("");

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

  const scrollbackLoadedRef = useRef(false);
  const MAX_ROWS = 1000;

  const applyGridUpdate = useCallback((update: GridUpdate, isScrollback = false) => {
    if (update.full && !scrollbackLoadedRef.current) {
      linesRef.current.clear();
    }

    if (isScrollback) {
      // HTTP scrollback — rows map directly by index
      for (const line of update.lines) {
        linesRef.current.set(line.row, line);
      }
    } else {
      // WS grid event — use display_offset for absolute row positioning
      const offset = update.display_offset ?? 0;
      for (const line of update.lines) {
        const absRow = offset + line.row;
        linesRef.current.set(absRow, { ...line, row: absRow });
      }
    }

    // Roll off oldest rows if buffer exceeds max
    if (linesRef.current.size > MAX_ROWS) {
      const keys = Array.from(linesRef.current.keys()).sort((a, b) => a - b);
      const toRemove = keys.length - MAX_ROWS;
      for (let i = 0; i < toRemove; i++) {
        linesRef.current.delete(keys[i]);
      }
    }

    const maxKey = linesRef.current.size > 0
      ? Math.max(...Array.from(linesRef.current.keys())) + 1
      : update.rows;

    setGrid({
      rows: maxKey,
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

  // Live grid stream via the daemon grid-WS (read-only viewer).
  useEffect(() => {
    let polling: ReturnType<typeof setInterval> | null = null;
    let lastText = "";
    let loadingContent = false;

    // HTTP scrollback fallback — used only when the grid-WS can't open
    // (e.g. iOS-device WKWebView WS limitation). Renders text-by-row.
    const loadContent = async () => {
      if (loadingContent) return;
      loadingContent = true;
      let lines: string[] | null = null;
      const r = await api.readTerminal(projectPath, terminalId, 500);
      if (r.ok && r.data?.lines) lines = r.data.lines;
      loadingContent = false;
      if (!lines) return;

      const text = lines.join("\n");
      debugRef.current = `http-lines=${lines.length}`;
      if (text !== lastText) {
        lastText = text;
        scrollbackLoadedRef.current = true;
        linesRef.current.clear();
        for (let i = 0; i < lines.length; i++) {
          linesRef.current.set(i, { row: i, text: lines[i] });
        }
        setGrid((prev) => ({
          ...prev,
          rows: lines!.length,
          cursorRow: lines!.length - 1,
          version: Date.now(),
        }));
      }
    };

    // Two-buffer terminal model (GridModel): snapshot replaces the
    // viewport + scrollback; delta patches damaged viewport rows and
    // appends scrollback. `lines()` flattens to absolute-row CompactLines
    // which feed the existing renderer via applyGridUpdate.
    const model = new GridModel();
    const render = () => {
      const gu: GridUpdate = {
        cols: model.cols,
        rows: model.totalRows(),
        cursor_col: model.cursorCol,
        cursor_row: model.cursorRow(),
        cursor_visible: model.cursorVisible,
        cursor_shape: "block",
        lines: model.lines() as CompactLine[],
        full: true,
        display_offset: 0,
      };
      linesRef.current.clear();
      scrollbackLoadedRef.current = true; // we own the clear above
      applyGridUpdate(gu, true);
    };

    const onFrame = (frame: GridFrame) => {
      if (frame.event === "snapshot") {
        model.applySnapshot(frame.payload as TermGridSnapshot);
        debugRef.current = `ws-snapshot sb=${model.scrollback.length} vp=${model.viewport.length}`;
        render();
      } else if (frame.event === "delta") {
        const p = frame.payload as TermGridDelta;
        model.applyDelta(p);
        debugRef.current = `ws-delta dmg=${p.damagedRows.length}`;
        render();
      } else if (frame.event === "child_exit") {
        gridSock.close();
      }
      // title / label_* / bell / error: ignored for now (Phase 4+).
    };

    const gridSock = new GridSocket(onFrame);
    gridSock.connect(terminalId);

    // If the WS hasn't produced a frame shortly after connect, fall back
    // to HTTP polling so the user still sees content on WS-restricted
    // platforms. Cleared automatically once a frame arrives.
    const fallbackTimer = setTimeout(() => {
      if (!gridSock.isOpen && !scrollbackLoadedRef.current) {
        loadContent();
        polling = setInterval(loadContent, 2000);
      }
    }, 1500);

    return () => {
      clearTimeout(fallbackTimer);
      gridSock.close();
      if (polling) clearInterval(polling);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [terminalId, projectPath, scheduleRender]);

  // Auto-scroll to bottom — only if user hasn't scrolled up
  const userScrolledRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
      userScrolledRef.current = !atBottom;
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (containerRef.current && !userScrolledRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [grid.version]);

  // Build row elements — render all buffered lines for scrollback
  const rowElements: React.ReactNode[] = [];
  const maxRow = Math.max(grid.rows, linesRef.current.size, ...Array.from(linesRef.current.keys()).map(k => k + 1));
  for (let r = 0; r < maxRow; r++) {
    const line = linesRef.current.get(r);
    rowElements.push(
      <div
        key={r}
        style={{
          minHeight: LINE_HEIGHT,
          lineHeight: `${LINE_HEIGHT}px`,
        }}
      >
        {line ? renderLineSpans(line) : "\u00A0"}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: "auto",
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
          wordBreak: "break-all",
          whiteSpace: "pre-wrap",
        }}
      >
        {/* Debug: line count (dev mode only) */}
        {DEV_MODE && (
          <div style={{ color: "#22d3ee", fontSize: "9px", padding: "2px 0", opacity: 0.7 }}>
            {maxRow} lines | buf={linesRef.current.size} | {grid.rows}r | {debugRef.current}
          </div>
        )}
        {rowElements}
      </div>
    </div>
  );
}
