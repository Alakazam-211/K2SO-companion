import { revive } from "../lib/revive";
import { onAppLifecycle } from "../lib/appLifecycle";
import type { ServerScope } from "./scope";
import { queueDial, type DialTicket } from "./dialQueue";
import { reconnectDelayMs } from "../lib/reconnect";
import { decodeGridFrame } from "./gridWire";
import {
  attachOpenActions,
  buildGridWsUrl,
  claimPinWireActions,
  releaseWireActions,
  type GridAttach,
  type GridRoute,
} from "../kessel/gridUrl";
import { sgrInputActions } from "../kessel/sgrWheel";
import { driveOpenFrames, driveResizeFrames } from "../kessel/driveMode";
import { ptyInputFrames } from "../kessel/ptyInput";
import {
  GRID_STALL_POLL_MS,
  enqueueOutbound,
  isAckAction,
  shouldBufferAndResync,
  shouldHealConnectingStall,
  shouldHealOpenStall,
  shouldProbeAck,
  shouldResyncOnForeground,
  shouldSkipConnectingResync,
  type GridSoftResyncReason,
} from "../kessel/softResync";

// Live k1 grid-WS. Two origins (do not smash tokens):
//   Connect/daemon (the socket's scope, `scope.httpBase()`):
//     `/cli/sessions/grid?token=<connect-token>&proto=k1`
//   Companion tunnel (capabilities k1 + companion token):
//     `/companion/sessions/grid?token=<companion-token>&proto=k1`
//   Never put the Connect `/cli/auth/login` token on the companion route.
//
// Query `token=` is the only JS path (WebSocket cannot set Authorization).
// HTTP `/cli/*` uses Bearer; this socket stays query.
// Server → snapshot/delta as k1 BINARY (gridWire.ts); other events stay
// JSON text. Client → `{action:"ack", version}` after a coalescer flush
// once the daemon has proven it speaks k1.
//
// Watch-default: attach sends set_mode:viewer (Connect `/cli` owner
// sockets start claimer). Drive later sends claimer + measured set_active.
// Reconnect backoff: `500 * 2^min(n,4)` cap 5s (`lib/reconnect.ts`).
//
// Grid-only heal (PRD §6.3): forceGridResync — last painted snapshot
// stays mounted. RPC `/companion/ws` is a different socket.
//
// Multi-server (MS6/MA5): the socket is CONSTRUCTED with the scope of the
// server the session lives on. Every (re)dial builds its URL from that
// scope and every revive targets it; it never reads the active server, so
// a switch while it is open never redials another server with this
// server's session id.

export type { GridAttach, GridRoute };

export interface GridSocketConnectOpts {
  /** Default: Connect `/cli` route. */
  route?: GridRoute;
  /** Default: Watch — set_mode:viewer on attach. */
  attach?: GridAttach;
  /** Companion-auth token. Required for `route: "companion"`. */
  token?: string;
  /** Explicit Drive. Default false: claim/resize/pin are no-ops. */
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
  /** The server this stream belongs to: URL, token and revive target. */
  private readonly scope: ServerScope;
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
  /** The last close code. Only 4003 (revoked) runs a whoami revive before
   *  the reopen (MA14): a plain drop never costs a whoami. */
  private lastCloseCode: number | null = null;
  /** A dial waiting in the queue (MS26). */
  private dial: DialTicket | null = null;
  /** Closed for the app's background (MS28, flag on). */
  private paused = false;
  private stopLifecycle: (() => void) | null = null;
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
  /** This socket has sent `set_mode:claimer` (Drive, or the first
   *  Direct/accessory keystroke). Watch reconnect resets it. */
  private ptyInputArmed = false;
  /** True once the current OPEN socket actually sent `claimDims`. */
  private claimSent = false;
  /** Outbound frames that arrived while the socket was not OPEN. */
  private outboundQueue: unknown[] = [];
  /** Date.now() of the last inbound WS frame; 0 = none yet. */
  private lastFrameAt = 0;
  /** Date.now() when the current dial entered CONNECTING; 0 = none. */
  private dialStartedAt = 0;
  /** Last k1 ack version sent on this socket; 0 = none. */
  private lastAckVersion = 0;
  private lastAckProbeAt = 0;
  /** One grid-stall-no-frame heal per silence episode. */
  private stallHealed = false;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Coalesce same-turn forceGridResync reasons into one dial. */
  private resyncGen = 0;

  constructor(scope: ServerScope, onFrame: FrameHandler) {
    this.scope = scope;
    this.onFrame = onFrame;
  }

  /** Open (and keep open, with backoff) a grid stream for `sessionId`. */
  connect(sessionId: string, opts?: GridSocketConnectOpts): void {
    this.sessionId = sessionId;
    this.route = opts?.route ?? "cli";
    this.attach = opts?.attach ?? "watch";
    this.companionToken = opts?.token ?? "";
    this.drive = opts?.drive ?? false;
    this.shouldReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Foreground recovery (orca terminal-foreground-recovery pattern):
    // iOS suspends timers AND drops sockets in the background, so a
    // return to the foreground must re-check the stream NOW instead of
    // waiting out whatever backoff timer survived the nap.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("focus", this.onForeground);
    }
    // MS28 (multi-server flag on): the background closes the socket; the
    // foreground recovery above reopens it through the dial queue.
    this.stopLifecycle?.();
    this.stopLifecycle = onAppLifecycle((phase) => {
      if (phase === "background") this.pauseForBackground();
      else if (this.paused) {
        this.paused = false;
        this.onForeground();
      }
    });
    this.startStallWatch();
    this.open();
  }

  private pauseForBackground(): void {
    if (!this.shouldReconnect) return;
    this.paused = true;
    this.dial?.cancel();
    this.dial = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      old.onopen = null;
      try {
        old.close();
      } catch {
        /* already dead */
      }
    }
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.onForeground();
  };

  /** App came to the foreground: not-OPEN → forceGridResync('foreground').
   *  OPEN zombies are the stall poll (and we sample immediately here).
   *  WebGL remount lives in TerminalView — this is grid-socket only. */
  private onForeground = (): void => {
    if (!this.shouldReconnect) return;
    const visible =
      typeof document === "undefined" || document.visibilityState === "visible";
    if (shouldResyncOnForeground({ visible, readyState: this.ws?.readyState })) {
      this.forceGridResync("foreground");
      return;
    }
    this.pollStall();
  };

  /**
   * Grid-only reattach. Cancels a pending backoff, reopens the k1
   * socket, does not touch `/companion/ws` or the last painted frame.
   */
  forceGridResync(reason: GridSoftResyncReason): void {
    if (!this.shouldReconnect) return;
    if (
      shouldSkipConnectingResync({
        readyState: this.ws?.readyState,
        dialStartedAt: this.dialStartedAt,
        now: Date.now(),
        reason,
      }) &&
      !this.reconnectTimer
    ) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Always-on breadcrumb — lock/unlock freezes are diagnosed from
    // release builds.
    console.warn(`[grid-resync] reason=${reason}`);
    const gen = ++this.resyncGen;
    queueMicrotask(() => {
      if (this.resyncGen !== gen || !this.shouldReconnect) return;
      void this.reviveThenReopen();
    });
  }

  /** Build the WS URL FRESH each open so a token revived between attempts
   *  is picked up (the daemon kicks stale tokens off the WS within 5s —
   *  reconnecting with the old one would just be kicked again). */
  private buildUrl(): string | null {
    let base: string;
    let token: string;
    try {
      base = this.scope.httpBase();
      token = this.scope.token();
    } catch {
      return null; // ServerRemovedError: the server is gone — stop.
    }
    if (!base) return null;
    if (this.route === "companion") {
      // Refuse to stamp the Connect token on the companion grid route.
      if (!this.companionToken) return null;
      return buildGridWsUrl(base, this.sessionId, this.companionToken, "companion");
    }
    return buildGridWsUrl(base, this.sessionId, token, "cli");
  }

  /** Dial through the queue (MS26: 2 per server, 4 overall, 4 s, burst
   *  backoff). With a free slot this dials synchronously, as before. */
  private open(): void {
    if (this.paused || this.dial) return;
    let started = false;
    const ticket = queueDial(
      this.scope,
      () => {
        started = true;
        this.dial = null;
        if (this.paused || !this.shouldReconnect) return null;
        return this.dialNow();
      },
      { failOnTimeout: true }
    );
    if (!started) this.dial = ticket;
  }

  private dialNow(): WebSocket | "failed" | null {
    const url = this.buildUrl();
    if (!url) {
      // No active server — nothing to stream from; don't spin a reconnect
      // loop against nowhere.
      this.shouldReconnect = false;
      return null;
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
      return "failed";
    }
    const dialled = this.ws;
    // k1 snapshot/delta frames arrive as WS binary; without this they'd
    // surface as Blobs and need an async read before decode.
    this.ws.binaryType = "arraybuffer";
    // Fresh socket — the daemon's per-connection pacing state is new too,
    // so re-detect k1 from its first binary frame before resuming acks.
    this.k1WireActive = false;
    this.lastAckVersion = 0;
    this.lastAckProbeAt = 0;
    this.dialStartedAt = Date.now();
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
      this.noteInboundFrame();
      // Don't swallow handler errors silently: an apply bug here (e.g. a
      // wire field-name mismatch) would otherwise look like a dead stream.
      try {
        this.onFrame(frame);
      } catch (err) {
        console.warn("[gridSocket] frame handler error:", err);
      }
    };
    this.ws.onclose = (e?: CloseEvent) => {
      this.lastCloseCode = typeof e?.code === "number" ? e.code : null;
      if (this.shouldReconnect) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
    this.ws.onopen = () => {
      // Successful open — the next drop starts the backoff ladder over
      // (desktop parity: a single-shot blip reconnects in ~500ms).
      this.reconnectAttempt = 0;
      this.dialStartedAt = 0;
      // Synthetic frame so the consumer sees connection boundaries:
      // an ephemeral claim_pin dies with its socket (the daemon
      // auto-clears + broadcasts to the SURVIVORS — we never see it),
      // so TerminalView resets its claim state here and lets the new
      // connection's pin_initial re-establish pin truth if any.
      // Watch: set_mode:viewer (Connect /cli must not stay claimer).
      // Drive: set_mode:claimer then flush stored measured dims — a
      // Drive tap before OPEN / reconnect must still send set_active.
      this.claimSent = false;
      if (this.drive) {
        this.ptyInputArmed = true;
        this.sendFrames(driveOpenFrames(true, this.claimDims));
        if (this.claimDims) this.claimSent = true;
      } else {
        this.ptyInputArmed = false;
        this.sendFrames(attachOpenActions(this.attach, null));
      }
      this.flushOutbound();
      try {
        this.onFrame({ event: "socket_open", payload: {} });
      } catch (err) {
        console.warn("[gridSocket] socket_open handler error:", err);
      }
    };
    return dialled;
  }

  private noteInboundFrame(): void {
    this.lastFrameAt = Date.now();
    if (this.stallHealed) {
      console.warn("[grid-stall] recovered");
    }
    this.stallHealed = false;
  }

  private startStallWatch(): void {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => this.pollStall(), GRID_STALL_POLL_MS);
  }

  private stopStallWatch(): void {
    if (!this.stallTimer) return;
    clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private pollStall(): void {
    if (!this.shouldReconnect) return;
    const visible =
      typeof document === "undefined" || document.visibilityState === "visible";
    const now = Date.now();
    const readyState = this.ws?.readyState;
    if (
      shouldHealConnectingStall({
        visible,
        readyState,
        dialStartedAt: this.dialStartedAt,
        now,
      })
    ) {
      this.forceGridResync("connecting-stall");
      return;
    }
    if (
      shouldProbeAck({
        visible,
        readyState,
        k1WireActive: this.k1WireActive,
        lastAckVersion: this.lastAckVersion,
        lastFrameAt: this.lastFrameAt,
        lastAckProbeAt: this.lastAckProbeAt,
        now,
      })
    ) {
      this.lastAckProbeAt = now;
      this.send({ action: "ack", version: this.lastAckVersion });
    }
    if (
      !shouldHealOpenStall({
        visible,
        readyState,
        lastFrameAt: this.lastFrameAt,
        now,
        healedThisEpisode: this.stallHealed,
      })
    ) {
      return;
    }
    this.stallHealed = true;
    console.warn("[grid-stall]", {
      reason: "no-frame",
      readyState: readyState ?? null,
      ageMs: Math.round(now - this.lastFrameAt),
    });
    this.forceGridResync("grid-stall-no-frame");
  }

  private flushOutbound(): void {
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    for (let i = 0; i < queued.length; i++) {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.outboundQueue.push(...queued.slice(i));
        return;
      }
      try {
        this.ws.send(JSON.stringify(queued[i]));
      } catch {
        for (const item of queued.slice(i)) {
          this.outboundQueue = enqueueOutbound(this.outboundQueue, item);
        }
        this.forceGridResync("need-to-send");
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.paused) return;
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) void this.reviveThenReopen();
    }, delay);
  }

  /** Reopen after a drop. The daemon closes a stale or revoked token's
   *  grid with 4003 (MA14): only then does this whoami-probe first
   *  (cheap when the token is fine → 'still-valid'); 'signin-required'
   *  STOPS the loop (the footer / Servers sheet / room banner surface it),
   *  and the token is kept — a background socket never deletes one
   *  (MA22). Any other close just reopens, so N servers never cost N
   *  whoami calls per drop. */
  private async reviveThenReopen(): Promise<void> {
    if (this.reviving) return;
    this.reviving = true;
    try {
      // MA14: only a 4003 (revoked) asks whoami first; a plain drop just
      // reopens. A background socket never deletes the token (MA22).
      const revoked = this.lastCloseCode === 4003;
      this.lastCloseCode = null;
      if (revoked && this.scope.id) {
        const outcome = await revive(this.scope, { background: true });
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

  /** Drive-only grid `{action:"input"}`. Watch is a no-op. Only CSI 64/65. */
  sendInput(text: string): void {
    for (const action of sgrInputActions(this.drive, text)) this.send(action);
  }

  /** Direct type + accessory keys (Esc, ⇧⏎, Ctrl+C, live text).
   *  First Watch keystroke sends `set_mode:claimer` so the daemon
   *  accepts input; never `set_active` (size stays). */
  sendPtyBytes(text: string): void {
    const frames = ptyInputFrames(text, this.drive || this.ptyInputArmed);
    if (frames.length === 0) return;
    if (!this.drive) this.ptyInputArmed = true;
    this.sendFrames(frames);
  }

  /** k1 flow control: acknowledge the highest APPLIED frame version.
   *  Called by the render path once per applied batch (from the rAF
   *  flush, never per WS message — see frameCoalescer.ts), so ack
   *  volume tracks render cadence. Gated on the daemon actually
   *  speaking k1 on THIS socket; a JSON-only daemon gets no acks. */
  ackApplied(version: number): void {
    if (!this.k1WireActive || version <= 0) return;
    this.lastAckVersion = version;
    this.send({ action: "ack", version });
  }

  /** Flip Drive without tearing down the socket. Watch stays the
   *  attach policy; claim/resize stay no-ops until this is true. */
  setDrive(on: boolean): void {
    this.drive = on;
    if (on) this.ptyInputArmed = true;
    if (!on) {
      this.claimDims = null;
      this.claimSent = false;
      this.ptyInputArmed = false;
    }
  }

  get driving(): boolean {
    return this.drive;
  }

  sendFrames(frames: readonly unknown[]): void {
    for (const frame of frames) this.send(frame);
  }

  /** Store a measured fit for the next OPEN flush. Does not send.
   *  Drive tap before OPEN / remount must plant dims here. */
  noteClaim(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    this.claimDims = { cols, rows };
    this.claimSent = false;
  }

  /** Claim this session as the active viewer and fit the shared PTY to THIS
   *  device's viewport (cols×rows). Watch (default): no-op. Stores dims
   *  even when the socket is not OPEN so onopen can flush them. */
  claim(cols: number, rows: number): void {
    if (!this.drive || cols <= 0 || rows <= 0) return;
    const prev = this.claimDims;
    if (
      prev &&
      prev.cols === cols &&
      prev.rows === rows &&
      this.claimSent &&
      this.isOpen
    ) {
      return;
    }
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
    this.claimSent = false;
    this.sendClaim();
  }

  /** Viewer mode: drop the stored claim WITHOUT a wire send (the
   *  daemon ignores viewer size frames anyway) so reconnects stop
   *  re-asserting a claim this connection isn't allowed to hold. */
  suppressClaim(): void {
    this.claimDims = null;
    this.claimSent = false;
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
    if (!this.isOpen) {
      this.forceGridResync("need-to-send");
      return;
    }
    const frames = driveResizeFrames(d);
    if (frames.length === 0) return;
    this.sendFrames(frames);
    this.claimSent = true;
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        if (!isAckAction(obj)) {
          this.outboundQueue = enqueueOutbound(this.outboundQueue, obj);
          this.forceGridResync("need-to-send");
        }
      }
      return;
    }
    const action =
      obj && typeof obj === "object"
        ? String((obj as { action?: string }).action ?? "")
        : "";
    if (!shouldBufferAndResync({ readyState: this.ws?.readyState, action })) {
      return;
    }
    this.outboundQueue = enqueueOutbound(this.outboundQueue, obj);
    this.forceGridResync("need-to-send");
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.shouldReconnect = false;
    this.paused = false;
    this.dial?.cancel();
    this.dial = null;
    this.stopLifecycle?.();
    this.stopLifecycle = null;
    this.stopStallWatch();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
      window.removeEventListener("focus", this.onForeground);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.outboundQueue = [];
    this.ws?.close();
    this.ws = null;
  }
}
