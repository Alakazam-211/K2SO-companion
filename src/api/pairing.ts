// Phone pairing (K2 0.46.4 `companion-pairing-v1`; wiki "Plan - Phone
// Pairing"): the phone gets its own device session from a one-time code
// instead of a password, so it also works on a server with web access off.
//
//   code   K2P-XXXXX-XXXXX-XXXXX-XXXXX (any case, dashes optional),
//          single use, 10 minutes
//   link   https://<label>.k2.dev/pair#<code>            (the QR)
//          k2companion://pair?server=<label>.k2.dev#<code> (the /pair page)
//          The code rides in the fragment: it never reaches a server.
//   pair   POST /cli/auth/device/pair {code, device:{id, name}} through
//          <label>.app.k2.dev (exempt from the web-off gate) or direct
//   ended  403 `device_session_ended` on any route: "Pair again". A paired
//          server never falls back to a password sign-in.
//   switch POST /cli/auth/device/pair-code {} with a password session (the
//          direct host, a native request), then pair with that code.

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

/** Where to POST the pairing: through the edge for a hosted apex
 *  `https://<label>.k2.dev`, else the server itself. */
export function pairUrlFor(serverUrl: string): string {
  const base = serverUrl.trim().replace(/\/+$/, "");
  const label = k2DevApexLabel(base);
  return label ? `https://${label}.app.k2.dev/cli/auth/device/pair` : `${base}/cli/auth/device/pair`;
}

/** A device session ended (lapsed or revoked): pair again. */
export function isDeviceSessionEnded(status: number, body: string): boolean {
  return status === 403 && /device_session_ended/i.test(body);
}

export type PairResult =
  | { ok: true; token: string; username: string; role: string | null; expiresAt: number | null; sessionId: string | null }
  | { ok: false; kind: "code" | "network" | "refused"; error: string };

const PAIR_TIMEOUT_MS = 10000;

/** Pair this phone with `code`. Does not touch the store. */
export async function pairDevice(
  serverUrl: string,
  code: string,
  device: { id: string; name: string }
): Promise<PairResult> {
  const body = JSON.stringify({ code, device: { id: device.id, name: device.name.slice(0, 80) } });
  try {
    const res = await withNetRetry(() =>
      Promise.race([
        tauriFetch(pairUrlFor(serverUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Request timed out")), PAIR_TIMEOUT_MS)),
      ])
    );
    const text = await res.text();
    if (res.status === 401) {
      return { ok: false, kind: "code", error: "That code didn't work. Codes last 10 minutes and work once; get a new one." };
    }
    if (!res.ok) {
      return {
        ok: false,
        kind: res.status === 404 ? "refused" : "network",
        error:
          res.status === 404
            ? "This server can't pair phones yet. It needs K2 0.46.4 or newer."
            : apiErrorText(text, `Pairing failed (HTTP ${res.status})`),
      };
    }
    const j = JSON.parse(text) as Record<string, unknown>;
    const token = typeof j.token === "string" ? j.token : "";
    const username = typeof j.username === "string" ? j.username : "";
    if (!token || !username) return { ok: false, kind: "network", error: "The server's answer had no session." };
    const dev = (j.device ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      token,
      username,
      role: typeof j.role === "string" ? j.role : null,
      expiresAt: typeof j.expiresAt === "number" ? j.expiresAt : null,
      sessionId: typeof dev.sessionId === "string" ? dev.sessionId : null,
    };
  } catch (err) {
    return { ok: false, kind: "network", error: `Could not connect: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

/** A one-time pairing code for this phone's own login (a password session
 *  switching to pairing). Direct host, no revive. */
export async function requestPairCode(scope: ServerScope): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  try {
    const r = await scopedFetch(scope, "/cli/auth/device/pair-code", { method: "POST", body: "{}", revive: false });
    if (!r.ok) return { ok: false, error: apiErrorText(r.text, `Could not get a pairing code (HTTP ${r.status})`) };
    const j = JSON.parse(r.text) as Record<string, unknown>;
    const code = typeof j.code === "string" ? normalizePairCode(j.code) : null;
    return code ? { ok: true, code } : { ok: false, error: "The server's answer had no pairing code." };
  } catch (err) {
    return { ok: false, error: `Could not connect: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}
