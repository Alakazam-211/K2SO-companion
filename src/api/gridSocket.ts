import { getBaseUrl, getToken } from "./client";

// Live terminal stream over the daemon's grid-WS (`/cli/sessions/grid`).
//
// Protocol (daemon `sessions_grid_ws.rs`):
//   connect: `<base>/cli/sessions/grid?session=<UUID>&token=<tok>`
//   server → `{"event":"snapshot"|"delta","payload":<GridUpdate>}`
//            (snapshot = full read-only grid on attach; deltas after)
//   client → `{"action":"input","text":...}` / `{"action":"resize",...}`
//
// The mobile companion is a READ-ONLY viewer: it renders whatever size
// the host terminal is and does NOT send `resize` (the PTY is shared —
// one kernel size across all viewers, so a mobile resize would shrink
// the host's terminal). Keystroke input may still be sent via `input`.
//
// `GridUpdate`/`CompactLine`/`StyleSpan` on the wire are field-identical
// to the renderer's interfaces in TerminalView, so `payload` feeds
// straight into `applyGridUpdate`.

export interface GridFrame<P = unknown> {
  // daemon `Outbound` (sessions_grid_ws.rs): snapshot | delta | child_exit
  // | title | label_initial | label_changed | bell | error
  event: string;
  payload: P;
}

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
const FL_BOLD = 1, FL_ITALIC = 2, FL_UNDERLINE = 4, FL_STRIKE = 8, FL_INVERSE = 16, FL_DIM = 32;

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

type FrameHandler = (frame: GridFrame) => void;

export class GridSocket {
  private ws: WebSocket | null = null;
  private url = "";
  private onFrame: FrameHandler;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(onFrame: FrameHandler) {
    this.onFrame = onFrame;
  }

  /** Open (and keep open, with backoff) a grid stream for `sessionId`. */
  connect(sessionId: string): void {
    const base = getBaseUrl().replace(/^http/, "ws");
    if (!base) return;
    const token = getToken();
    this.url =
      `${base}/cli/sessions/grid` +
      `?session=${encodeURIComponent(sessionId)}` +
      `&token=${encodeURIComponent(token)}`;
    this.shouldReconnect = true;
    this.open();
  }

  private open(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onmessage = (e) => {
      try {
        this.onFrame(JSON.parse(e.data as string) as GridFrame);
      } catch {
        /* ignore non-JSON frames */
      }
    };
    this.ws.onclose = () => {
      if (this.shouldReconnect) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.open();
    }, 2000);
  }

  /** Send a keystroke / text input to the host PTY (optional). */
  sendInput(text: string): void {
    this.send({ action: "input", text });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
