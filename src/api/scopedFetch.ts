// The one HTTP core under every phone stack (multi-server MS5/MS7, MA4):
// `api/client.ts` (`httpRequest`), `api/feedback.ts`, `api/projectGroups.ts`,
// `api/sendMessage.ts`, `lib/sessionAuthor.ts` and `lib/push.ts`.
//
// The scope is captured ONCE by the caller and passed in. The base URL is
// read from it once; the token is re-read from the same scope per attempt
// (a revive may mint a new one). A stale-session rejection (401, or 403 with
// the daemon's token-gate body) revives THAT scope's server and, only when a
// fresh token was minted, replays ONCE on the same scope. Nothing here reads
// the active server, so a request for server B never reaches server A —
// not on the first try, not on the replay.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { cliAuthHeaders } from "./cliAuth";
import { isPossibleAuthFailure, revive } from "../lib/revive";
import type { ServerScope } from "./scope";

export interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface ScopedFetchOptions {
  method?: string;
  /** Query params, appended with `&` when `path` already has a `?`. */
  query?: Record<string, string>;
  /** Raw body (already serialised). */
  body?: string;
  timeoutMs?: number;
  /** Revive + replay once on a stale-session rejection. Default true. */
  revive?: boolean;
  /** Send the Bearer token. Default true. */
  auth?: boolean;
}

export const NOT_CONNECTED = "Not connected";

/** Build `<base><path>?<query>`. */
export function buildScopedUrl(base: string, path: string, query?: Record<string, string>): string {
  let url = `${base}${path}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (parts.length > 0) url += (url.includes("?") ? "&" : "?") + parts.join("&");
  return url;
}

/** One request on `scope`, with revive + replay-once on the same scope.
 *  Throws on a network error, a timeout, `NOT_CONNECTED` (no server) and
 *  `ServerRemovedError` (the scope's server is gone). HTTP errors come back
 *  as a `RawResponse`. */
export async function scopedFetch(
  scope: ServerScope,
  path: string,
  opts: ScopedFetchOptions = {}
): Promise<RawResponse> {
  const base = scope.httpBase();
  if (!base) throw new Error(NOT_CONNECTED);
  const url = buildScopedUrl(base, path, opts.query);
  const timeoutMs = opts.timeoutMs ?? 15000;

  const attempt = async (): Promise<RawResponse> => {
    const token = opts.auth === false ? "" : scope.token();
    const res = await Promise.race([
      tauriFetch(url, {
        method: opts.method || "GET",
        headers: cliAuthHeaders(token),
        body: opts.body || undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs)
      ),
    ]);
    return { status: res.status, ok: res.ok, text: await res.text() };
  };

  let out = await attempt();
  if (opts.revive !== false && isPossibleAuthFailure(out.status, out.text)) {
    // 'revived' = this server's store entry carries a NEW token. Any other
    // outcome keeps the original response (a still-valid token that 403s
    // is a real role denial).
    const outcome = await revive(scope);
    if (outcome === "revived") out = await attempt();
  }
  return out;
}
