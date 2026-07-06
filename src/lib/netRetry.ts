// Retry-on-network-error helper for daemon fetches — the companion port of
// the desktop's `remote-retry.ts` (dead-pooled-socket eviction).
//
// THE BUG IT FIXES
// When a K2 server restarts/updates, WKWebView keeps DEAD pooled keep-alive
// sockets for that origin. Every *.k2.dev host shares one relay IP, so the
// webview pools a single connection per origin; after the remote churns, the
// next `fetch()` reuses the dead socket and throws at the NETWORK layer
// ("Load failed"). The throw itself EVICTS the dead socket from the pool, so
// an immediate retry opens a FRESH socket and recovers — no app relaunch.
// Header tricks (`Connection: close`, `keepalive:false`) do NOT work in
// WKWebView; retry-on-network-error is the only reliable lever.
//
// Pure + import-safe (no tauri/store imports) — future-vitest-ready.

/**
 * Detect connection-level errors (refused connection, DNS failure, network
 * down, dead pooled socket). Distinct from HTTP-level errors, which the fetch
 * wrappers surface as responses.
 *
 * WKWebView surfaces "Load failed"; other engines "Failed to fetch" /
 * "NetworkError"; the tauri plugin-http (reqwest) side reports
 * "error sending request" / "connection refused/reset".
 *
 * IMPORTANT: a 401/403 or any other non-2xx is NOT a connection error — those
 * are authoritative application errors and must surface immediately.
 */
export function isConnectionLevelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("load failed") ||
    m.includes("networkerror") ||
    m.includes("network error") ||
    m.includes("error sending request") ||
    m.includes("connection refused") ||
    m.includes("connection reset") ||
    m.includes("econnrefused") ||
    m.includes("network unreachable")
  );
}

/** Tuning knobs for {@link withNetRetry}. */
export interface NetRetryOptions {
  /**
   * The pause (ms) BEFORE each retry attempt that follows the first try.
   * `delaysMs.length` = number of RETRIES; total attempts = length + 1.
   * The default `[0, 400, 1200, 2000]` is 4 attempts over ~3.6s: the first
   * retry is IMMEDIATE (the throw evicted the dead socket — reopening
   * recovers at once), later retries ride out the restart window.
   */
  delaysMs?: number[];
  /** Called once between attempts (after the failed try, before the next). */
  onRetry?: () => void | Promise<void>;
}

/** Default backoff: immediate first retry (evict+reopen the dead socket),
 *  then widening pauses to ride out the remote restart/update window. */
export const DEFAULT_NET_RETRY_DELAYS_MS = [0, 400, 1200, 2000];

/**
 * Run `op`, retrying ONLY on a connection-level error (see
 * {@link isConnectionLevelError}). Any other error is authoritative and
 * rethrown IMMEDIATELY. After the final attempt the original error is
 * rethrown verbatim.
 */
export async function withNetRetry<T>(
  op: () => Promise<T>,
  opts?: NetRetryOptions
): Promise<T> {
  const delays = opts?.delaysMs ?? DEFAULT_NET_RETRY_DELAYS_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await opts?.onRetry?.();
      const pause = delays[attempt - 1];
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
    try {
      return await op();
    } catch (err) {
      if (!isConnectionLevelError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
