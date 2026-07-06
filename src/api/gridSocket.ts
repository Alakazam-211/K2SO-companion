import { getBaseUrl, getToken } from "./client";
import { useServersStore } from "../stores/servers";
import { reviveServerSession } from "../lib/revive";
import { decodeGridFrame } from "./gridWire";

// Live terminal stream over the daemon's grid-WS (`/cli/sessions/grid`).
//
// Protocol (daemon `sessions_grid_ws.rs`):
//   connect: `<base>/cli/sessions/grid?session=<UUID>&token=<tok>&proto=k1`
//   server → snapshot/delta as k1 BINARY frames (gridWire.ts) when the
//            daemon honors the `proto=k1` opt-in; an older JSON-only
//            daemon ignores the param and keeps sending
//            `{"event":"snapshot"|"delta","payload":<GridUpdate>}` text
//            frames — BOTH decode paths stay live, and the callback
//            receives the identical frame shape either way.
//   server → every other event stays a JSON text frame regardless of
//            proto: title / bell / label_initial / label_changed /
//            pin_initial / pin_changed / mode / child_exit / error /
//            clipboard. All of them flow through the frame callback
//            (pin/mode consumed in T2).
//   client → `{"action":"input","text":...}` / `{"action":"resize",...}`
//   client → `{"action":"ack","version":N}` — k1 flow control, sent via
//            `ackApplied()` once per APPLIED frame batch (never per WS
//            message) and only after the daemon has proven it speaks k1
//            (first binary frame). The daemon bounds this connection's
//            unacked backlog with it: while we fall behind it stops
//            forwarding deltas and resyncs us with a fresh full snapshot
//            on our next ack.
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
  // | pin_initial | pin_changed | mode | clipboard
  // plus ONE client-synthesized event: `socket_open` (emitted locally
  // on every WS open so the consumer can reset per-connection state —
  // ephemeral pins die with their socket).
  event: string;
  payload: P;
}

// ── JSON side-channel payloads T2 consumes (typed here so the socket's
//    callback surface is complete from T1 on; shapes mirror the desktop
//    renderer's OutboundMsg in TerminalPane.tsx) ──

/** `pin_initial` — arrives right after attach on a pinned session
 *  (absence during the connect sequence = unpinned by design). */
export interface PinInitialPayload {
  cols: number;
  rows: number;
  set_by: string | null;
}

/** `pin_changed` — fires mid-session (cleared:true = unpinned). */
export interface PinChangedPayload {
  cols?: number;
  rows?: number;
  cleared: boolean;
}

/** `mode` — this connection's daemon-judged role. */
export interface ModePayload {
  mode: "viewer" | "claimer";
  capable: boolean;
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
  /** True once the CURRENT socket has delivered a binary (k1) frame —
   *  i.e. the daemon honored our `&proto=k1` opt-in. Gates `ackApplied`:
   *  an older JSON-only daemon never sees acks it would just log as
   *  malformed inbound. Reset on every (re)connect; the daemon's
   *  per-connection pacing state resets with the socket too. */
  private k1WireActive = false;

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
    // `proto=k1` opts into the binary grid wire (gridWire.ts); an older
    // daemon ignores the param and keeps sending JSON snapshot/delta.
    return (
      `${base}/cli/sessions/grid` +
      `?session=${encodeURIComponent(this.sessionId)}` +
      `&token=${encodeURIComponent(getToken())}` +
      `&proto=k1`
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
    // k1 snapshot/delta frames arrive as WS binary; without this they'd
    // surface as Blobs and need an async read before decode.
    this.ws.binaryType = "arraybuffer";
    // Fresh socket — the daemon's per-connection pacing state is new too,
    // so re-detect k1 from its first binary frame before resuming acks.
    this.k1WireActive = false;
    this.ws.onmessage = (e) => {
      let frame: GridFrame;
      if (e.data instanceof ArrayBuffer) {
        // k1 binary wire — snapshot/delta only; every other event still
        // arrives as JSON text below. The decoded payload is the exact
        // object shape JSON.parse of the equivalent text frame yields,
        // so everything downstream is transport-blind.
        let wire;
        try {
          wire = decodeGridFrame(e.data);
        } catch (err) {
          // A frame that fails to decode is a protocol violation —
          // surface it rather than silently desyncing the mirror.
          console.error("[gridSocket] k1 frame decode failed:", err);
          return;
        }
        this.k1WireActive = true;
        frame = { event: wire.kind, payload: wire.payload };
      } else {
        if (typeof e.data !== "string") return;
        try {
          frame = JSON.parse(e.data) as GridFrame;
        } catch {
          return; // non-JSON text frame — ignore
        }
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
      // Synthetic frame so the consumer sees connection boundaries:
      // an ephemeral claim_pin dies with its socket (the daemon
      // auto-clears + broadcasts to the SURVIVORS — we never see it),
      // so TerminalView resets its claim state here and lets the new
      // connection's pin_initial re-establish pin truth if any.
      try {
        this.onFrame({ event: "socket_open", payload: {} });
      } catch (err) {
        console.warn("[gridSocket] socket_open handler error:", err);
      }
      // S5 per-window mode: CONNECT-USER connections default to VIEWER
      // on the daemon until the client opts in (owner-token windows
      // default to claimer — desktop sends this opt-in from its
      // window-mode store). Request claimer on every (re)connect; the
      // daemon ACKs with `capable` and keeps true viewer-role users
      // read-only server-side regardless of what we request.
      this.send({ action: "set_mode", mode: "claimer" });
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

  /** k1 flow control: acknowledge the highest APPLIED frame version.
   *  Called by the render path once per applied batch (from the rAF
   *  flush, never per WS message — see frameCoalescer.ts), so ack
   *  volume tracks render cadence. Gated on the daemon actually
   *  speaking k1 on THIS socket; a JSON-only daemon gets no acks. */
  ackApplied(version: number): void {
    if (!this.k1WireActive || version <= 0) return;
    this.send({ action: "ack", version });
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

  /** Re-send the stored claim even when the dims are unchanged — the
   *  last-claim-wins re-take after ANOTHER client drove the size away
   *  (`claim()` dedupes same-dims, which would no-op exactly then). */
  reassertClaim(): void {
    this.sendClaim();
  }

  /** Viewer mode: drop the stored claim WITHOUT a wire send (the
   *  daemon ignores viewer size frames anyway) so reconnects stop
   *  re-asserting a claim this connection isn't allowed to hold. */
  suppressClaim(): void {
    this.claimDims = null;
  }

  /** T0 ephemeral "Claim session" pin: pin the PTY to cols×rows bound
   *  to THIS socket (auto-clears on disconnect; daemon bounds
   *  20..=500 × 5..=200). Also takes the active-subscriber slot.
   *  Re-sending new dims updates the pin in place (one pin_changed);
   *  SAME dims are a server-side silent no-op — safe to fire per
   *  keyboard transition. Deliberately NOT stored/re-asserted on
   *  reconnect: the daemon cleared the pin at disconnect and every
   *  other client saw it — silently re-pinning after a blip would
   *  contradict what they were told. TerminalView re-claims only on
   *  an explicit user tap. */
  claimPin(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.send({ action: "claim_pin", cols, rows });
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
