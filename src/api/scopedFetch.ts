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

import { netFetch as tauriFetch } from "../lib/netStats";
import { cliAuthHeaders } from "./cliAuth";
import { isPossibleAuthFailure, revive } from "../lib/revive";
import type { ServerScope } from "./scope";
import { withHttpSlot, type HttpPriority } from "./httpCap";

export interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
  /** `content-type`, for telling a K2 answer from something in front of
   *  the box (a portal, a proxy). Absent in tests' fakes. */
  contentType?: string;
  /** What served it, when it says: `server` and Cloudflare's `cf-ray`. */
  via?: string;
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
  /** Queue position under the per-server cap. Default: by route
   *  (`priorityOf`). */
  priority?: HttpPriority;
}

/** Routes the person is waiting on: the chat they opened (its read and
 *  delta), sends, card answers and confirms, file previews, terminal input.
 *  Everything else (lists, badges, sync, usage) is background. */
const USER_ROUTES = new Set([
  "/cli/thread",
  "/cli/thread/messages",
  "/cli/thread/post",
  "/cli/thread/answer",
  "/cli/thread/attachment",
  "/cli/thread/permission-undo",
  "/cli/thread/permission-note",
  "/cli/project-group/messages",
  "/cli/project-group/msg",
  "/cli/vault/confirm/start",
  "/cli/vault/confirm/finish",
  "/cli/terminal/write",
  "/cli/feedback/comment",
  "/cli/fs/read-file",
]);

export function priorityOf(path: string): HttpPriority {
  return USER_ROUTES.has(path.split("?")[0]) ? "user" : "background";
}

export const NOT_CONNECTED = "Not connected";
const TIMED_OUT = "Request timed out";

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

  // MS26: at most 4 requests in flight per server; the timeout starts
  // once this request holds a slot. A4: a timeout before the response's
  // headers aborts the request, so it gives its connection back instead of
  // running on past its slot. The body read is not timed (as before): a
  // slow but live download (a big attachment on cellular) finishes.
  const attempt = (): Promise<RawResponse> =>
    withHttpSlot(scope.id, async () => {
      const token = opts.auth === false ? "" : scope.token();
      const send = async (): Promise<Response> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const abort = typeof AbortController === "function" ? new AbortController() : null;
        try {
          return await Promise.race([
            tauriFetch(url, {
              method: opts.method || "GET",
              headers: cliAuthHeaders(token),
              body: opts.body || undefined,
              ...(abort ? { signal: abort.signal } : {}),
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                abort?.abort();
                reject(new Error(TIMED_OUT));
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      let res: Response;
      try {
        res = await send();
      } catch (e) {
        // A kept-alive connection the tunnel already closed (the phone
        // slept past its idle time) fails at once: a GET goes again, once,
        // on a fresh connection. Never a POST (it may have landed).
        const method = (opts.method || "GET").toUpperCase();
        if (method !== "GET" || (e instanceof Error && e.message === TIMED_OUT)) throw e;
        res = await send();
      }
      const header = (name: string) => res.headers?.get?.(name) ?? "";
      const via = [header("server"), header("cf-ray") ? "cloudflare" : ""].filter(Boolean).join(", ");
      return { status: res.status, ok: res.ok, text: await res.text(), contentType: header("content-type"), via };
    }, opts.priority ?? priorityOf(path));

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
