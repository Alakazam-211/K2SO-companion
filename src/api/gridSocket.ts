import { getBaseUrl, getToken } from "./client";
import { useServersStore } from "../stores/servers";
import { reviveServerSession } from "../lib/revive";

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
  private sessionId = "";
  /** The server this stream was opened against (revive target on close). */
  private serverId: string | null = null;
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
    this.sessionId = sessionId;
    this.serverId = useServersStore.getState().activeServerId;
    this.shouldReconnect = true;
    this.open();
  }

  /** Build the WS URL FRESH each open so a token revived between attempts
   *  is picked up (the daemon kicks stale tokens off the WS within 5s —
   *  reconnecting with the old one would just be kicked again). */
  private buildUrl(): string | null {
    const base = getBaseUrl().replace(/^http/, "ws");
    if (!base) return null;
    return (
      `${base}/cli/sessions/grid` +
      `?session=${encodeURIComponent(this.sessionId)}` +
      `&token=${encodeURIComponent(getToken())}`
    );
  }

  private open(): void {
    const url = this.buildUrl();
    if (!url) {
      // No active server — nothing to stream from; don't spin a reconnect
      // loop against nowhere.
      this.shouldReconnect = false;
      return;
    }
    try {
      this.ws = new WebSocket(url);
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
      if (this.shouldReconnect) void this.reviveThenReopen();
    }, 2000);
  }

  /** Consult the revive path BEFORE re-opening: a WS close after a daemon
   *  restart is a STALE-TOKEN kick indistinguishable from a network drop,
   *  and reconnect-forever on a dead token was the exact stranding bug.
   *  Revive whoami-probes (cheap when the token is fine → 'still-valid'),
   *  silently re-logs-in when it's dead and a password is remembered, and
   *  returns 'signin-required' when only the user can fix it — at which
   *  point this loop STOPS (the footer/Servers page surface the state). */
  private async reviveThenReopen(): Promise<void> {
    if (this.serverId) {
      const outcome = await reviveServerSession(this.serverId);
      if (!this.shouldReconnect) return;
      if (outcome === "signin-required" || outcome === "not-applicable") {
        this.shouldReconnect = false;
        return;
      }
      // revived / still-valid → reopen with the (possibly fresh) token;
      // unreachable / cooldown → reopen anyway and let the next close land
      // back here (network-down keeps its old retry cadence).
    }
    if (this.shouldReconnect) this.open();
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
