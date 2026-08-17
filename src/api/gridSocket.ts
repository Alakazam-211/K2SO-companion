import { getBaseUrl, getToken } from "./client";
import { useServersStore } from "../stores/servers";
import { reviveServerSession } from "../lib/revive";
import { reconnectDelayMs } from "../lib/reconnect";
import { decodeGridFrame } from "./gridWire";
import {
  attachOpenActions,
  buildGridWsUrl,
  claimPinWireActions,
  claimWireActions,
  releaseWireActions,
  type GridAttach,
  type GridRoute,
} from "../kessel/gridUrl";

// Live k1 grid-WS. Two origins (do not smash tokens):
//   Connect/daemon (this app's `getBaseUrl()`):
//     `/cli/sessions/grid?token=<connect-token>&proto=k1`
//   Companion tunnel (capabilities k1 + companion token):
//     `/companion/sessions/grid?token=<companion-token>&proto=k1`
//   Never put the Connect `/cli/auth/login` token on the companion route.
//
// Query `token=` is the only JS path (WebSocket cannot set Authorization).
// Server → snapshot/delta as k1 BINARY (gridWire.ts); other events stay
// JSON text. Client → `{action:"ack", version}` after a coalescer flush
// once the daemon has proven it speaks k1.
//
// Watch-default: attach sends nothing that claims. Capabilities miss
// is Connect `/cli` Watch — not claimer-on-open.
// Reconnect backoff: `500 * 2^min(n,4)` cap 5s (`lib/reconnect.ts`).

export type { GridAttach, GridRoute };

export interface GridSocketConnectOpts {
  /** Default: Connect `/cli` route. */
  route?: GridRoute;
  /** Default: Watch — send nothing on attach. */
  attach?: GridAttach;
  /** Companion-auth token. Required for `route: "companion"`. */
  token?: string;
  /** Drive (later PR). Default false: claim/resize/pin are no-ops. */
  drive?: boolean;
}

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
  /** Consecutive failed (re)connects since the last successful open —
   *  drives the exponential backoff (lib/reconnect.ts, desktop Kessel
   *  parity: 500·2^min(n,4) capped at 5s). Reset on every open. */
  private reconnectAttempt = 0;
  /** Reentrancy guard: revive+reopen may be triggered by the backoff
   *  timer AND foreground recovery — never run both at once. */
  private reviving = false;
  /** Active-viewer claim (this device's dims) to (re)send on every
   *  connect; null = not claimed. */
  private claimDims: { cols: number; rows: number } | null = null;
  /** True once the CURRENT socket has delivered a binary (k1) frame —
   *  i.e. the daemon honored our `&proto=k1` opt-in. Gates `ackApplied`:
   *  an older JSON-only daemon never sees acks it would just log as
   *  malformed inbound. Reset on every (re)connect; the daemon's
   *  per-connection pacing state resets with the socket too. */
  private k1WireActive = false;
  private route: GridRoute = "cli";
  private attach: GridAttach = "watch";
  /** Companion-auth token only. Never the Connect login token. */
  private companionToken = "";
  /** Explicit Drive. Watch (default) never emits set_active / resize. */
  private drive = false;

  constructor(onFrame: FrameHandler) {
    this.onFrame = onFrame;
  }

  /** Open (and keep open, with backoff) a grid stream for `sessionId`. */
  connect(sessionId: string, opts?: GridSocketConnectOpts): void {
    this.sessionId = sessionId;
    this.route = opts?.route ?? "cli";
    this.attach = opts?.attach ?? "watch";
    this.companionToken = opts?.token ?? "";
    this.drive = opts?.drive ?? false;
    this.serverId = useServersStore.getState().activeServerId;
    this.shouldReconnect = true;
    // Foreground recovery (orca terminal-foreground-recovery pattern):
    // iOS suspends timers AND drops sockets in the background, so a
    // return to the foreground must re-check the stream NOW instead of
    // waiting out whatever backoff timer survived the nap.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("focus", this.onForeground);
    }
    this.open();
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.onForeground();
  };

  /** App came to the foreground: if a reconnect is pending, fire it
   *  immediately (through the revive path); if the socket died silently
   *  while backgrounded (no close event delivered → no timer), reopen.
   *  A healthy open socket makes this a no-op. */
  private onForeground = (): void => {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      void this.reviveThenReopen();
      return;
    }
    const state = this.ws?.readyState;
    if (state === undefined || state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
      void this.reviveThenReopen();
    }
  };

  /** Build the WS URL FRESH each open so a token revived between attempts
   *  is picked up (the daemon kicks stale tokens off the WS within 5s —
   *  reconnecting with the old one would just be kicked again). */
  private buildUrl(): string | null {
    const base = getBaseUrl();
    if (!base) return null;
    if (this.route === "companion") {
      // Refuse to stamp the Connect token on the companion grid route.
      if (!this.companionToken) return null;
      return buildGridWsUrl(base, this.sessionId, this.companionToken, "companion");
    }
    return buildGridWsUrl(base, this.sessionId, getToken(), "cli");
  }

  private open(): void {
    const url = this.buildUrl();
    if (!url) {
      // No active server — nothing to stream from; don't spin a reconnect
      // loop against nowhere.
      this.shouldReconnect = false;
      return;
    }
    // Supersede any previous socket SILENTLY: strip its handlers first
    // so its close can't schedule a duplicate reconnect against the
    // fresh one (foreground recovery may reopen while a zombie socket
    // is still winding down).
    if (this.ws) {
      const old = this.ws;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      old.onopen = null;
      try {
        old.close();
      } catch {
        // already dead — fine
      }
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
      // The child EXITED — the session is dead, so the close that
      // follows must never reconnect-resurrect it (desktop's
      // phaseRef-synchronous fix: the daemon closes the WS in the same
      // task as sending child_exit, so latch BEFORE dispatching). The
      // consumer shows the dead state; its own close() is belt+braces.
      if (frame.event === "child_exit") this.shouldReconnect = false;
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
      // Successful open — the next drop starts the backoff ladder over
      // (desktop parity: a single-shot blip reconnects in ~500ms).
      this.reconnectAttempt = 0;
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
      // Watch-default: send nothing that claims.
      for (const action of attachOpenActions(this.attach, this.claimDims)) {
        this.send(action);
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) void this.reviveThenReopen();
    }, delay);
  }

  /** Consult the revive path BEFORE re-opening: a WS close after a daemon
   *  restart is a STALE-TOKEN kick indistinguishable from a network drop,
   *  and reconnect-forever on a dead token was the exact stranding bug.
   *  Revive whoami-probes (cheap when the token is fine → 'still-valid'),
   *  silently re-logs-in when it's dead and a password is remembered, and
   *  returns 'signin-required' when only the user can fix it — at which
   *  point this loop STOPS (the footer/Servers page surface the state). */
  private async reviveThenReopen(): Promise<void> {
    if (this.reviving) return;
    this.reviving = true;
    try {
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
    } finally {
      this.reviving = false;
    }
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
   *  device's viewport (cols×rows). Watch (default): no-op. */
  claim(cols: number, rows: number): void {
    if (!this.drive || cols <= 0 || rows <= 0) return;
    const prev = this.claimDims;
    if (prev && prev.cols === cols && prev.rows === rows && this.isOpen) return;
    this.claimDims = { cols, rows };
    this.sendClaim();
  }

  /** Release the active claim so another device (e.g. the desktop) drives the size. */
  release(): void {
    this.claimDims = null;
    for (const action of releaseWireActions(this.drive)) this.send(action);
  }

  /** Re-send the stored claim even when the dims are unchanged — the
   *  last-claim-wins re-take after ANOTHER client drove the size away
   *  (`claim()` dedupes same-dims, which would no-op exactly then). */
  reassertClaim(): void {
    if (!this.drive) return;
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
    for (const action of claimPinWireActions(this.drive, cols, rows)) {
      this.send(action);
    }
  }

  private sendClaim(): void {
    const d = this.claimDims;
    if (!d) return;
    for (const action of claimWireActions(this.drive, d.cols, d.rows)) {
      this.send(action);
    }
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
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      window.removeEventListener("focus", this.onForeground);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
