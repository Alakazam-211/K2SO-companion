// The LLM account a chat's session uses, and its usage (K2 0.46.4
// `llm-account-for-v1`, K2 main 2b10a4a3a; Rosson 2026-10-24): the chat
// header shows its highest percent next to the LLM icon, the same number
// the desktop's top-bar chip shows (the daemon computes `maxPercent`).
//
//   GET  /cli/llm/accounts/for?addr=<chat addr>   the cached reading
//   POST /cli/llm/accounts/for/refresh {addr}     re-reads that one token;
//        people only (agent passports 403 owner_only), at most once a minute
//        per token, else the cached reading with `refreshed:false`,
//        `reason:"rate_limited"`, `retryAfterSecs`; same body
//
// `addr` takes what `k2 msg` takes (a sidecar `agent/2` resolves to that
// sidecar's own session). Not an LLM session: 200 with `tool: null`. No
// reading (API token, air-gap, never read): `maxPercent: null`. Both hide
// the bubble. Bad addr 404, none 400. Read on chat open and on return to
// the foreground: the cached reading first, then a refresh; never polled.

import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";

export const FEATURE_LLM_ACCOUNT_FOR = "llm-account-for-v1";

export type AccountUsage = {
  tool: string;
  accountId: string;
  label: string;
  source: string;
  /** 0–100, whole. */
  maxPercent: number;
  /** Unix seconds of the reading, or null. */
  updatedAt: number | null;
};

/** The body, or null when it names no account or no usable percent. */
export function parseAccountUsage(data: unknown): AccountUsage | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const pct = o.maxPercent;
  if (typeof o.tool !== "string" || !o.tool) return null;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const up = o.updatedAt;
  return {
    tool: s(o.tool),
    accountId: s(o.accountId),
    label: s(o.label),
    source: s(o.source),
    maxPercent: Math.max(0, Math.min(100, Math.round(pct))),
    updatedAt: typeof up === "number" && Number.isFinite(up) ? up : typeof up === "string" && up ? Math.floor(Date.parse(up) / 1000) || null : null,
  };
}

function readBody(r: { ok: boolean; text: string }): AccountUsage | null {
  return r.ok ? parseAccountUsage(JSON.parse(r.text)) : null;
}

/** The cached reading for `addr`. Null on any failure. */
export async function readAccountUsage(scope: ServerScope, addr: string): Promise<AccountUsage | null> {
  try {
    return readBody(await scopedFetch(scope, "/cli/llm/accounts/for", { query: { addr }, timeoutMs: 15000 }));
  } catch {
    return null;
  }
}

/** A fresh reading for `addr` (the cached one when rate-limited). Null on
 *  any failure; the caller keeps what it has. */
export async function refreshAccountUsage(scope: ServerScope, addr: string): Promise<AccountUsage | null> {
  try {
    return readBody(
      await scopedFetch(scope, "/cli/llm/accounts/for/refresh", {
        method: "POST",
        body: JSON.stringify({ addr }),
        timeoutMs: 15000,
      })
    );
  } catch {
    return null;
  }
}
