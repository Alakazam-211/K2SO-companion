// ── "Claim session" (ephemeral pin) client state machine ──────────
//
// Pure reducer over the grid-WS side-channel events (mode /
// pin_initial / pin_changed, gridSocket.ts) plus the local user
// actions, so the whole claim lifecycle is unit-testable without a
// socket (scripts/test-scale-claim.mjs). TerminalView drives it and
// mirrors the result into `stores/terminalMeta.ts` for T3.
//
// Daemon contract (T0, sessions_grid_ws.rs):
//   - `{"action":"claim_pin","cols":N,"rows":N}` — claimer-mode only;
//     also takes the active-subscriber slot; re-send with new dims =
//     in-place update; SAME dims = silent no-op.
//   - Ack = the `pin_changed {cols,rows,cleared:false}` broadcast that
//     EVERYONE (including the setter) receives. The broadcast carries
//     no setter identity, so ownership is inferred locally: a
//     non-cleared pin_changed whose dims equal the last claim WE sent
//     is our ack; any other dims means another client pinned
//     (last-write-wins — normal pins replace ephemeral ones).
//   - Setter disconnect → daemon auto-clears (`pin_changed
//     {cleared:true}`) + election restores survivor dims. So a socket
//     (re)open RESETS local ownership — if the session is still/again
//     pinned, `pin_initial` follows on the new connection.

export interface ClaimState {
  /** This connection's daemon-judged role (mode event). Defaults to
   *  "claimer" — older daemons never send the event, and today's
   *  claim-on-open behavior is the claimer path. */
  mode: "viewer" | "claimer";
  /** Claimer-capable per the daemon (mode event). */
  capable: boolean;
  /** We believe THIS device owns the ephemeral pin. */
  claimedByMe: boolean;
  /** Current pin as broadcast by the daemon; null = unpinned. */
  pin: { cols: number; rows: number; setBy: string | null } | null;
  /** Dims of the last claim_pin WE sent — matches ack broadcasts. */
  lastClaimSent: { cols: number; rows: number } | null;
}

export const initialClaimState: ClaimState = {
  mode: "claimer",
  capable: true,
  claimedByMe: false,
  pin: null,
  lastClaimSent: null,
};

export type ClaimEvent =
  /** Grid-WS (re)opened — ephemeral pins die with their socket, so
   *  ownership resets; pin_initial re-establishes pin state if any. */
  | { type: "socket_open" }
  | { type: "mode"; mode: "viewer" | "claimer"; capable: boolean }
  | { type: "pin_initial"; cols: number; rows: number; setBy: string | null }
  | { type: "pin_changed"; cols?: number; rows?: number; cleared: boolean }
  /** We sent `claim_pin` at these dims (tap or keyboard/rotation
   *  re-claim while claimed). Optimistic — the pin_changed ack
   *  confirms. */
  | { type: "claim_sent"; cols: number; rows: number }
  /** We POSTed pin-size {clear:true} (tap-to-release). Optimistic. */
  | { type: "release_sent" };

export function reduceClaim(s: ClaimState, e: ClaimEvent): ClaimState {
  switch (e.type) {
    case "socket_open":
      return { ...s, claimedByMe: false, pin: null, lastClaimSent: null };
    case "mode": {
      const next = { ...s, mode: e.mode, capable: e.capable };
      if (e.mode === "viewer") {
        next.claimedByMe = false;
        next.lastClaimSent = null;
      }
      return next;
    }
    case "pin_initial":
      // Fresh connection: someone's pin predates us — never ours.
      return {
        ...s,
        pin: { cols: e.cols, rows: e.rows, setBy: e.setBy },
        claimedByMe: false,
      };
    case "pin_changed": {
      if (e.cleared) {
        // Our release ack, the setter's disconnect auto-clear, or a
        // manual unpin from the other end — all end the pin.
        return { ...s, pin: null, claimedByMe: false, lastClaimSent: null };
      }
      const cols = e.cols ?? 0;
      const rows = e.rows ?? 0;
      const isOurAck =
        s.claimedByMe &&
        s.lastClaimSent !== null &&
        s.lastClaimSent.cols === cols &&
        s.lastClaimSent.rows === rows;
      return {
        ...s,
        pin: { cols, rows, setBy: isOurAck ? (s.pin?.setBy ?? null) : null },
        // Dims we never asked for = another client pinned over us
        // (last-write-wins) → drop to scale-to-fit + pin badge.
        claimedByMe: isOurAck,
      };
    }
    case "claim_sent":
      return {
        ...s,
        claimedByMe: true,
        pin: { cols: e.cols, rows: e.rows, setBy: s.pin?.setBy ?? null },
        lastClaimSent: { cols: e.cols, rows: e.rows },
      };
    case "release_sent":
      return { ...s, claimedByMe: false, pin: null, lastClaimSent: null };
  }
}

// ── Derived predicates (single source for TerminalView + tests) ────

/** Pinned by ANOTHER client → scale-to-fit + pin badge, no emissions. */
export function pinnedByOther(s: ClaimState): boolean {
  return s.pin !== null && !s.claimedByMe;
}

/** May this device emit size at all (claim / resize / claim_pin)?
 *  Viewers never emit; while pinned by others the daemon clamps
 *  anyway, so we don't bother it. */
export function canEmitSize(s: ClaimState): boolean {
  return s.mode === "claimer" && !pinnedByOther(s);
}

/** Show the "Claim session" affordance (claimed state shows the
 *  release badge instead). */
export function showClaimButton(s: ClaimState): boolean {
  return s.mode === "claimer" && s.capable && !pinnedByOther(s) && !s.claimedByMe;
}
