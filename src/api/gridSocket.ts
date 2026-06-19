import { getBaseUrl, getToken } from "./client";

// Live terminal stream over the daemon's grid-WS (`/cli/sessions/grid`).
//
// Protocol (daemon `sessions_grid_ws.rs`):
//   connect: `<base>/cli/sessions/grid?session=<UUID>&token=<tok>`
//   server → `{"event":"snapshot"|"delta","payload":<GridUpdate>}`
//            (snapshot = full read-only grid on attach; deltas after)
//   client → `{"action":"input","text":...}` / `{"action":"resize",...}`
//
// The shared PTY is a single size across all viewers (it can't render
// different dimensions per device), so the companion uses the daemon's
// active-subscriber claim: while a session is open on the phone it claims
// "active" and resizes the PTY to the phone's viewport, so the terminal
// fits THIS device. This intentionally shrinks the desktop's view — by
// design, the active device drives the size, and the desktop reclaims it
// the moment it's used (most-recent-claim-wins). Keystrokes go via `input`.
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
  /** Active-viewer claim (this device's dims) to (re)send on every
   *  connect; null = not claimed. */
  private claimDims: { cols: number; rows: number } | null = null;

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
      let frame: GridFrame;
      try {
        frame = JSON.parse(e.data as string) as GridFrame;
      } catch {
        return; // non-JSON frame — ignore
      }
      // Don't swallow handler errors silently: an apply bug here (e.g. a
      // wire field-name mismatch) would otherwise look like a dead stream.
      try {
        this.onFrame(frame);
      } catch (err) {
        console.warn("[gridSocket] frame handler error:", err);
      }
    };
    this.ws.onclose = () => {
      if (this.shouldReconnect) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
    this.ws.onopen = () => {
      // Re-assert the active claim + PTY size on every (re)connect so the
      // shared terminal keeps fitting THIS device.
      this.sendClaim();
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

  /** Claim this session as the active viewer and fit the shared PTY to THIS
   *  device's viewport (cols×rows). Stored + re-asserted on every reconnect. */
  claim(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const prev = this.claimDims;
    if (prev && prev.cols === cols && prev.rows === rows && this.isOpen) return;
    this.claimDims = { cols, rows };
    this.sendClaim();
  }

  /** Release the active claim so another device (e.g. the desktop) drives the size. */
  release(): void {
    this.claimDims = null;
    this.send({ action: "set_active", active: false });
  }

  private sendClaim(): void {
    const d = this.claimDims;
    if (!d) return;
    // set_active(true, dims) claims + resizes on a FRESH claim; the explicit
    // resize covers the already-active case (rotation / size change), which
    // the daemon only honors from the active subscriber.
    this.send({ action: "set_active", active: true, cols: d.cols, rows: d.rows });
    this.send({ action: "resize", cols: d.cols, rows: d.rows });
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
