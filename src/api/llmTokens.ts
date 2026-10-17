// LLM tokens (desktop Settings → LLMs → Tokens) over HTTP on one server's
// scope. Pure types + helpers live in llmTokensPure.ts (re-exported).
// Every route is a Member login floor (K2 `route_policy.rs`); a daemon
// older than 0.45.0 answers 404 `route_unclassified`.

import { apiErrorText } from "../lib/apiError";
import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";
import { failureKind, parseLlmTokensDoc, type LlmTokensDoc, type TokensFailureKind } from "./llmTokensPure";

export * from "./llmTokensPure";

export const LIST_PATH = "/cli/llm/accounts/list";
export const SWITCH_PATH = "/cli/llm/accounts/switch";
export const REFRESH_PATH = "/cli/llm/accounts/refresh";

export type TokensFailure = {
  ok: false;
  status?: number;
  error: string;
  kind: TokensFailureKind;
};

export type TokensResult<T> = ({ ok: true } & T) | TokensFailure;

async function call(
  scope: ServerScope,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | TokensFailure> {
  try {
    const res = await scopedFetch(scope, path, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const error = apiErrorText(res.text, `HTTP ${res.status}`);
      return { ok: false, status: res.status, error, kind: failureKind(res.status, error) };
    }
    let data: unknown = null;
    try {
      data = res.text ? JSON.parse(res.text) : null;
    } catch {
      data = null;
    }
    return { ok: true, data };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, error, kind: "error" };
  }
}

/** `GET /cli/llm/accounts/list` — every tool's tokens and server default. */
export async function getLlmTokens(scope: ServerScope): Promise<TokensResult<{ doc: LlmTokensDoc }>> {
  const r = await call(scope, LIST_PATH);
  if (!r.ok) return r;
  return { ok: true, doc: parseLlmTokensDoc(r.data) };
}

/** `POST /cli/llm/accounts/switch {id}` — make `id` its tool's server
 *  default. The daemon answers `{switch, account, warnings[], note}`. */
export async function switchLlmToken(
  scope: ServerScope,
  id: string
): Promise<TokensResult<{ warnings: string[] }>> {
  const r = await call(scope, SWITCH_PATH, { id });
  if (!r.ok) return r;
  const raw = (r.data && typeof r.data === "object" ? r.data : {}) as { warnings?: unknown };
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === "string" && w !== "")
    : [];
  return { ok: true, warnings };
}

/** `POST /cli/llm/accounts/refresh {usage:true}` — re-read every token's
 *  state and usage (the daemon reads all usage at most once a minute; a
 *  faster ask just rechecks sign-in state). Re-list afterwards. */
export async function refreshLlmTokenUsage(scope: ServerScope): Promise<TokensResult<object>> {
  const r = await call(scope, REFRESH_PATH, { usage: true });
  if (!r.ok) return r;
  return { ok: true };
}
