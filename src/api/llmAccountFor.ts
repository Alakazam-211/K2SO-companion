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
// While the chat is open, `subscription_usage_changed` re-reads the GET
// only (K2 usage single source, C1).

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
  /** Unix seconds of the reading, or null. On a K2 with the single usage
   *  record this equals `usage.asOf`, when the driving window was measured. */
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

/** A `subscription_usage_changed` frame that concerns this reading: its
 *  own token, or one that names no token for this tool. A frame naming no
 *  tool either is an older server's probe of every tool. */
export function isUsageChangedFor(frame: unknown, usage: Pick<AccountUsage, "tool" | "accountId"> | null): boolean {
  if (!usage || !frame || typeof frame !== "object") return false;
  const f = frame as { kind?: unknown; tool?: unknown; account_id?: unknown };
  if (f.kind !== "subscription_usage_changed") return false;
  if (typeof f.account_id === "string" && f.account_id) return f.account_id === usage.accountId;
  return f.tool == null || f.tool === usage.tool;
}

/** From this age a reading says how old it is. */
export const USAGE_AGE_SHOW_MIN = 20;

/** Whole minutes since the reading, or null while it's recent or has no
 *  time. */
export function usageAgeMinutes(updatedAt: number | null, nowMs: number): number | null {
  if (updatedAt == null) return null;
  const min = Math.floor((nowMs / 1000 - updatedAt) / 60);
  return min >= USAGE_AGE_SHOW_MIN ? min : null;
}

/** "21m" after the percent, "21 minutes ago" for the label. */
export function usageAgeText(min: number): { short: string; spoken: string } {
  const [n, letter, unit] =
    min < 60 ? [min, "m", "minute"] : min < 1440 ? [Math.floor(min / 60), "h", "hour"] : [Math.floor(min / 1440), "d", "day"];
  return { short: `${n}${letter}`, spoken: `${n} ${unit}${n === 1 ? "" : "s"} ago` };
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
