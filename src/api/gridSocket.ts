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

// Pure wire types + converter live in gridConvert.ts (Node-testable).
export * from "./gridConvert";

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
