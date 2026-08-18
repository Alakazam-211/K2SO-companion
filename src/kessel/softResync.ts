// Grid-only soft-resync policy (PRD §6.3 / PR5).
//
// Desktop inlines this in TerminalPane.tsx — do not import that pane.
// Companion owns a small heal: reopen the k1 grid socket, keep the last
// painted snapshot, leave /companion/ws (RPC) alone.

import { reconnectDelayMs } from "../lib/reconnect";

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/** OPEN + no inbound frame for this long while visible → heal. */
export const GRID_STALL_NO_FRAME_MS = 20_000;
/** How often we sample OPEN / last-frame age. */
export const GRID_STALL_POLL_MS = 5_000;
/** Cap on frames queued while the socket is not OPEN. */
export const OUTBOUND_BUFFER_CAP = 32;

export type GridSoftResyncReason =
  | "foreground"
  | "need-to-send"
  | "grid-stall-no-frame";

export function socketIsOpen(
  readyState: number | null | undefined,
): boolean {
  return readyState === WS_OPEN;
}

/** visibilitychange visible + socket not OPEN. CONNECTING is already a
 *  dial — do not abort it. Missing / CLOSING / CLOSED → resync. */
export function shouldResyncOnForeground(opts: {
  visible: boolean;
  readyState: number | null | undefined;
}): boolean {
  if (!opts.visible) return false;
  const rs = opts.readyState;
  if (rs === WS_OPEN || rs === WS_CONNECTING) return false;
  return true;
}

/** Need-to-send on a non-OPEN socket. Acks are ephemeral (new socket
 *  has its own k1 pacing) — never buffer or heal for those. */
export function shouldBufferAndResync(opts: {
  readyState: number | null | undefined;
  action: string;
}): boolean {
  if (opts.action === "ack") return false;
  return !socketIsOpen(opts.readyState);
}

export function isAckAction(obj: unknown): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    (obj as { action?: string }).action === "ack"
  );
}

/** OPEN + had a frame + ≥20s silence while visible. One heal per
 *  stall episode; a later frame clears `healedThisEpisode`. */
export function shouldHealOpenStall(opts: {
  visible: boolean;
  readyState: number | null | undefined;
  lastFrameAt: number;
  now: number;
  healedThisEpisode: boolean;
}): boolean {
  if (!opts.visible) return false;
  if (!socketIsOpen(opts.readyState)) return false;
  if (opts.healedThisEpisode) return false;
  if (opts.lastFrameAt <= 0) return false;
  return opts.now - opts.lastFrameAt >= GRID_STALL_NO_FRAME_MS;
}

/** Drop-oldest when the outbound buffer is full. */
export function enqueueOutbound<T>(queue: T[], item: T, cap = OUTBOUND_BUFFER_CAP): T[] {
  const next = queue.length >= cap ? queue.slice(queue.length - cap + 1) : queue.slice();
  next.push(item);
  return next;
}

/** Backoff is already 500·2^min(n,4) cap 5s — re-export so heal code
 *  does not invent a second schedule. */
export { reconnectDelayMs };
