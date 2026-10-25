// Phone pairing (K2 0.46.4 `companion-pairing-v1`; wiki "Plan - Phone
// Pairing"; final contract K2 m_5ClOC889BH): the phone gets its own device
// session from a one-time code instead of a password, so it also works on a
// server with web access off.
//
//   code   K2P-XXXXX-XXXXX-XXXXX-XXXXX (any case, dashes optional),
//          single use, 10 minutes; a daemon restart drops it
//   link   https://<label>.k2.dev/pair#<code>            (the QR)
//          k2companion://pair?server=<label>.k2.dev#<code> (the /pair page)
//          The code rides in the fragment: it never reaches a server.
//   check  POST /cli/auth/device/pair/check {code} → {user, host,
//          expiresInSecs}; does not use the code up (K2 m_RFURuuaXzV)
//   pair   POST /cli/auth/device/pair {code, device:{id, name}}, no auth,
//          through <label>.app.k2.dev (exempt from the web-off gate) or
//          direct → {token, username, role, expiresAt, maxExpiresAt, …}
//   ended  403 `device_session_ended` on any route (WS close 4003): "Pair
//          again". Slides 30 days with use, never past 180 days. A paired
//          server never falls back to a password sign-in.
//   switch POST /cli/auth/device/pair-code {password} with a password
//          session (the direct host), pair with that code, then log the
//          old session out; push re-registers on the token change.
//   errors {ok:false, error:{code, hint}}
//
// Security (K2's review): any page can fire a pair link at any server, so
// the phone always shows the host and the login and asks first, never
// silently replaces a saved server, and warns on a host outside *.k2.dev.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { withNetRetry } from "../lib/netRetry";
import { apiErrorText } from "../lib/apiError";
import { k2DevApexLabel } from "../lib/loginUrl";
import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";

export const FEATURE_COMPANION_PAIRING = "companion-pairing-v1";
export const PAIR_SCHEME = "k2companion";
const CODE_BODY = /^[A-Z0-9]{20}$/;

/** The code in its canonical form, or null when it isn't one. Spaces,
 *  dashes and case don't matter; the `K2P` prefix may be left off. */
export function normalizePairCode(input: string): string | null {
  let s = input.replace(/[\s-]+/g, "").toUpperCase();
  if (s.startsWith("K2P")) s = s.slice(3);
  if (!CODE_BODY.test(s)) return null;
  return `K2P-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

/** A server host from a link: `<label>.k2.dev` (an `app.` label maps back
 *  to the box), or any other host as given. */
function serverUrlFromHost(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\/+$/, "");
  if (!h || /[^a-z0-9.:-]/.test(h)) return null;
  const app = /^([a-z0-9-]+)\.app\.k2\.dev$/.exec(h);
  return `https://${app ? `${app[1]}.k2.dev` : h}`;
}

/** What a scanned or pasted text holds: the server (null for a bare code)
 *  and the code. Null when there is no valid code in it. */
export function parsePairText(text: string): { serverUrl: string | null; code: string } | null {
  const t = text.trim();
  const bare = normalizePairCode(t);
  if (bare) return { serverUrl: null, code: bare };
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  const code = normalizePairCode(decodeURIComponent(url.hash.replace(/^#/, "")));
  if (!code) return null;
  if (url.protocol === `${PAIR_SCHEME}:`) {
    const server = url.searchParams.get("server");
    return { serverUrl: server ? serverUrlFromHost(server) : null, code };
  }
  if (url.protocol === "https:" && url.pathname.replace(/\/+$/, "") === "/pair") {
    return { serverUrl: serverUrlFromHost(url.host), code };
  }
  return null;
}

/** Where to POST a pairing route (`/cli/auth/device/pair[/check]`):
 *  through the edge for a hosted apex `https://<label>.k2.dev`, else the
 *  server itself. */
export function pairUrlFor(serverUrl: string, path = "/cli/auth/device/pair"): string {
  const base = serverUrl.trim().replace(/\/+$/, "");
  const label = k2DevApexLabel(base);
  return label ? `https://${label}.app.k2.dev${path}` : `${base}${path}`;
}

/** A hosted K2 address (`<label>.k2.dev`). Anything else gets a warning
 *  before pairing. */
export function isK2DevServer(serverUrl: string): boolean {
  try {
    return /(^|\.)k2\.dev$/i.test(new URL(serverUrl).hostname);
  } catch {
    return false;
  }
}

/** A device session ended (lapsed or revoked): pair again. */
export function isDeviceSessionEnded(status: number, body: string): boolean {
  return status === 403 && /device_session_ended/i.test(body);
}

/** The daemon's error code (`{error:{code}}` or `{error:"code"}`), or "". */
export function pairErrorCode(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: unknown })?.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") {
      return (e as { code: string }).code;
    }
  } catch {
    /* not JSON */
  }
  return "";
}

const CODE_TEXT = "That code didn't work. Codes last 10 minutes and work once. Get a new one.";
const RATE_TEXT = "Too many tries. Wait a minute and try again.";
const OLD_SERVER_TEXT = "This server can't pair phones yet. It needs K2 0.46.4 or newer.";

/** What this phone calls itself in the server's device list. */
export function phoneName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

const PAIR_TIMEOUT_MS = 10000;

async function postPairing(url: string, body: unknown): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await withNetRetry(() =>
    Promise.race([
      tauriFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Request timed out")), PAIR_TIMEOUT_MS)),
    ])
  );
  return { status: res.status, ok: res.ok, text: await res.text() };
}

function connectError(err: unknown): string {
  return `Could not connect: ${err instanceof Error ? err.message : "unknown error"}`;
}

export type PairCheck =
  | { ok: true; user: string; host: string | null; expiresInSecs: number | null }
  /** `unchecked`: the server has no check route (an early 0.46.4 build);
   *  the confirm shows the host only. */
  | { ok: false; kind: "code" | "unchecked" | "network" | "refused"; error: string };

/** Who a code pairs as, without using it up. */
export async function checkPairCode(serverUrl: string, code: string): Promise<PairCheck> {
  try {
    const r = await postPairing(pairUrlFor(serverUrl, "/cli/auth/device/pair/check"), { code });
    if (r.ok) {
      const j = JSON.parse(r.text) as Record<string, unknown>;
      const user = typeof j.user === "string" ? j.user : "";
      if (!user) return { ok: false, kind: "unchecked", error: "" };
      return {
        ok: true,
        user,
        host: typeof j.host === "string" && j.host ? j.host : null,
        expiresInSecs: typeof j.expiresInSecs === "number" ? j.expiresInSecs : null,
      };
    }
    if (r.status === 401) return { ok: false, kind: "code", error: CODE_TEXT };
    if (r.status === 429) return { ok: false, kind: "refused", error: RATE_TEXT };
    if (r.status === 404 || r.status === 405) return { ok: false, kind: "unchecked", error: "" };
    return { ok: false, kind: "network", error: apiErrorText(r.text, `Could not check the code (HTTP ${r.status})`) };
  } catch (err) {
    return { ok: false, kind: "network", error: connectError(err) };
  }
}

export type PairResult =
  | {
      ok: true;
      token: string;
      username: string;
      role: string | null;
      expiresAt: string | null;
      maxExpiresAt: string | null;
      sessionId: string | null;
    }
  | { ok: false; kind: "code" | "network" | "refused"; error: string };

/** Pair this phone with `code`. Does not touch the store. */
export async function pairDevice(
  serverUrl: string,
  code: string,
  device: { id: string; name: string }
): Promise<PairResult> {
  try {
    const r = await postPairing(pairUrlFor(serverUrl), { code, device: { id: device.id, name: device.name.slice(0, 80) } });
    if (!r.ok) {
      const code = pairErrorCode(r.text);
      if (r.status === 401 || code === "pair_code_invalid") return { ok: false, kind: "code", error: CODE_TEXT };
      if (r.status === 429) return { ok: false, kind: "refused", error: RATE_TEXT };
      if (r.status === 404) return { ok: false, kind: "refused", error: OLD_SERVER_TEXT };
      return { ok: false, kind: "network", error: apiErrorText(r.text, `Pairing failed (HTTP ${r.status})`) };
    }
    const j = JSON.parse(r.text) as Record<string, unknown>;
    const token = typeof j.token === "string" ? j.token : "";
    const username = typeof j.username === "string" ? j.username : "";
    if (!token || !username) return { ok: false, kind: "network", error: "The server's answer had no session." };
    const dev = (j.device ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      ok: true,
      token,
      username,
      role: str(j.role),
      expiresAt: str(j.expiresAt),
      maxExpiresAt: str(j.maxExpiresAt),
      sessionId: str(dev.sessionId),
    };
  } catch (err) {
    return { ok: false, kind: "network", error: connectError(err) };
  }
}

/** A one-time pairing code for this phone's own login (a password session
 *  switching to pairing): the login's password, once; the server's own
 *  host, no revive. */
export async function requestPairCode(
  scope: ServerScope,
  password: string
): Promise<{ ok: true; code: string } | { ok: false; kind: "password" | "other"; error: string }> {
  try {
    const r = await scopedFetch(scope, "/cli/auth/device/pair-code", {
      method: "POST",
      body: JSON.stringify({ password }),
      revive: false,
    });
    if (!r.ok) {
      const code = pairErrorCode(r.text);
      if (code === "password_invalid") return { ok: false, kind: "password", error: "That password isn't right." };
      if (r.status === 429) return { ok: false, kind: "other", error: RATE_TEXT };
      if (r.status === 404) return { ok: false, kind: "other", error: OLD_SERVER_TEXT };
      return { ok: false, kind: "other", error: apiErrorText(r.text, `Could not get a pairing code (HTTP ${r.status})`) };
    }
    const j = JSON.parse(r.text) as Record<string, unknown>;
    const code = typeof j.code === "string" ? normalizePairCode(j.code) : null;
    return code ? { ok: true, code } : { ok: false, kind: "other", error: "The server's answer had no pairing code." };
  } catch (err) {
    return { ok: false, kind: "other", error: connectError(err) };
  }
}
