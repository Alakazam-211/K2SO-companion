// The LLM account a chat's session uses, and its usage (K2 0.46.4
// `llm-account-for-v1`; Rosson 2026-10-24): the chat header shows its
// highest percent next to the LLM icon, like the desktop's top-bar chip.
//
//   GET  /cli/llm/accounts/for?addr=<chat addr>        the cached reading
//   POST /cli/llm/accounts/for/refresh {addr}          a one-account nudge,
//        rate-limited per account (~1/min; else the cached reading with
//        `refreshed:false`), same body
//
// `addr` is the chat's own address (a sidecar `agent/2` too); the daemon
// resolves the account as the session spawn does. `maxPercent` is the
// desktop chip's number: the highest whole percent used across the tool's
// counted windows, a window past its reset counting 0. Read on chat open
// and on return to the foreground, never polled.

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

/** The account usage for `addr`: a refresh nudge (it answers with the
 *  cached reading when rate-limited), falling back to the plain read on a
 *  server that refuses the nudge. Null on any failure. */
export async function fetchAccountUsage(scope: ServerScope, addr: string): Promise<AccountUsage | null> {
  try {
    const r = await scopedFetch(scope, "/cli/llm/accounts/for/refresh", {
      method: "POST",
      body: JSON.stringify({ addr }),
      timeoutMs: 15000,
    });
    if (r.ok) return parseAccountUsage(JSON.parse(r.text));
    if (r.status !== 404 && r.status !== 405) return null;
    const g = await scopedFetch(scope, "/cli/llm/accounts/for", { query: { addr }, timeoutMs: 15000 });
    return g.ok ? parseAccountUsage(JSON.parse(g.text)) : null;
  } catch {
    return null;
  }
}
