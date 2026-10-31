// ── Grid-WS reconnect backoff schedule (T5b) ───────────────────────
//
// Desktop Kessel parity (TerminalPane.tsx ws.onclose): exponential
// `500 · 2^min(n, 4)` capped at 5s — the first reconnect after a
// single-shot drop is fast (~500ms) so the user barely sees it, and a
// sustained outage never spins faster than every 5s. The attempt
// counter resets on a successful open (gridSocket.ts). Pure so the
// schedule is Node-testable (scripts/test-reconnect.mjs).

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 5000;

/** Delay before reconnect attempt `n` (0-based). */
export function reconnectDelayMs(attempt: number): number {
  const n = Math.min(Math.max(0, attempt), 4);
  return Math.min(RECONNECT_BASE_MS * 2 ** n, RECONNECT_CAP_MS);
}

/** Speed PRD A6: a delay spread over `[ms/2, ms]`, so sockets that dropped
 *  together (a network change, a daemon restart) don't redial together. */
export function jittered(ms: number, rand: () => number = Math.random): number {
  return Math.round(ms / 2 + rand() * (ms / 2));
}

/** Speed PRD A6: a socket counts as healthy again (its backoff starts
 *  over) only after staying open this long; a link that opens and drops
 *  at once keeps backing off instead of redialling every half second. */
export const STABLE_OPEN_MS = 30_000;
