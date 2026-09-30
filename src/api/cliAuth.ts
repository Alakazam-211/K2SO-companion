/**
 * HTTP `/cli/*` auth header.
 *
 * Loopback owner GETs accept `Authorization: Bearer` (2026-09-29). Query
 * `?token=` stays only on JS transports that cannot set headers:
 *   - grid WS (`/cli/sessions/grid`, `/companion/sessions/grid`)
 *   - companion RPC WS (`/companion/ws`)
 *   - events WS (`/events`)
 * This client does not call `POST /cli/daemon/restart` (the one route the
 * CLI binary documents as query-only). Connect-tunnel Bearer is unproven.
 */
export function cliAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
