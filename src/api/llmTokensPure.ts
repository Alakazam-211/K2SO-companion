// LLM tokens (desktop Settings → LLMs → Tokens, "Subs / Tokens") — pure
// wire types + helpers, Node-testable with zero imports (the
// feedbackPure.ts idiom). The fetch layer lives in llmTokens.ts.
//
// Source of truth: desktop K2 `stores/llm-accounts.ts` (parseAccountsDoc,
// tokenName, checkedAgoText, exhaustedWarnings), `lib/subscription-usage.ts`
// (HarnessUsage, formatResetsIn) and the daemon's
// `llm_accounts_routes.rs` (`list_doc`, `account_json`). Internally the
// daemon still says "accounts" / "login"; people read "tokens" and
// "subscriptions".
//
// Routes (K2 0.45.0+, every one a Member login floor in route_policy.rs):
//   GET  /cli/llm/accounts/list                    — this doc
//   POST /cli/llm/accounts/switch   {id}           — make `id` the server default
//   POST /cli/llm/accounts/refresh  {usage:true}   — re-read every token's usage

/** One usage window of a subscription: 0–1 used; `resetsAt` ISO or "". */
export interface TokenUsageWindow {
  label: string;
  used: number;
  resetsAt: string;
}

/** A token's own last usage reading (`HarnessUsage` on the daemon). */
export interface TokenUsage {
  harness: string;
  plan: string;
  windows: TokenUsageWindow[];
  /** ISO time of that reading, or "". */
  checkedAt: string;
  /** "" when signed in with windows; otherwise an empty-state sentence. */
  status: string;
  /** The last check failed (why); the windows are the last good reading. */
  error?: string;
}

/** Where a token is set for one workspace or chat (it can't then be the
 *  server default: a subscription can't be live in two places). */
export interface TokenPin {
  scopeKind: string;
  label: string;
}

export interface LlmToken {
  id: string;
  tool: string;
  label: string;
  /** `subscription` (a CLI sign-in) or `api_key` (billed per token). */
  kind: string;
  /** This token is the tool's server default. */
  active: boolean;
  /** signed_in | needs_login | signing_in | not_set_up | unknown | … */
  state: string;
  detail: string | null;
  email: string | null;
  org: string | null;
  plan: string | null;
  pinnedTo: TokenPin[];
  inUse: boolean;
  usage: TokenUsage | null;
  /** Unix seconds of the last successful usage read, or null. */
  usageCheckedAt: number | null;
}

export interface LlmTokenTool {
  tool: string;
  display: string;
  supported: boolean;
  /** Sign-in (subscription) tokens supported; false = API tokens only. */
  subscription: boolean;
  activeId: string | null;
  /** Unix seconds the current server default was set, or null. */
  switchedAt: number | null;
  accounts: LlmToken[];
}

export interface LlmTokensDoc {
  tools: LlmTokenTool[];
  /** Account ids with a sign-in still running (this login's own). */
  signingInIds: string[];
  airgap: boolean;
  /** The daemon's one-line note on what a switch changes. */
  switchNote: string;
}

/** The desktop page's tool order (`LOGIN_TOOL_ROWS`). */
export const TOOL_ORDER = ["claude", "codex", "grok", "gemini", "cursor", "hermes", "pi"] as const;

export const STATE_LABELS: Record<string, string> = {
  signed_in: "Signed in",
  needs_login: "Needs sign-in",
  signing_in: "Signing in…",
  not_set_up: "Not set up",
  unknown: "Unknown",
};

export const STATE_COLORS: Record<string, string> = {
  signed_in: "#22c55e",
  needs_login: "#ef4444",
  signing_in: "#eab308",
  not_set_up: "#6b7280",
  unknown: "#6b7280",
};

/** The page's standing note (Rosson, 2026-10-17). */
export const ADD_ON_DESKTOP_NOTE =
  "To add a subscription, use K2 on your desktop. From here you can only switch between subscriptions that are already active on your device(s).";

export const API_TOKEN_SUFFIX = "billed per token";

// ─── Parsing ───

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function arr(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function strOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

function numOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseWindow(raw: unknown): TokenUsageWindow | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.label !== "string") return null;
  if (typeof raw.used !== "number" || !Number.isFinite(raw.used)) return null;
  return { label: raw.label, used: raw.used, resetsAt: str(raw.resetsAt) };
}

/** A token's `usage` (null, or the daemon's HarnessUsage). Bad windows
 *  are dropped; anything that isn't an object is no reading. */
export function parseTokenUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null;
  const windows: TokenUsageWindow[] = [];
  for (const w of arr(raw.windows)) {
    const win = parseWindow(w);
    if (win) windows.push(win);
  }
  return {
    harness: str(raw.harness),
    plan: str(raw.plan),
    windows,
    checkedAt: str(raw.checkedAt),
    status: str(raw.status),
    ...(typeof raw.error === "string" && raw.error !== "" ? { error: raw.error } : {}),
  };
}

function parseToken(raw: unknown, tool: string): LlmToken | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  return {
    id: raw.id,
    tool: str(raw.tool) || tool,
    label: str(raw.label) || raw.id,
    kind: str(raw.kind) || "subscription",
    active: raw.active === true,
    state: str(raw.state) || "unknown",
    detail: strOrNull(raw.detail),
    email: strOrNull(raw.email),
    org: strOrNull(raw.org),
    plan: strOrNull(raw.plan),
    pinnedTo: arr(raw.pinnedTo)
      .filter(isRecord)
      .map((p) => ({ scopeKind: str(p.scopeKind), label: str(p.label) })),
    inUse: raw.inUse === true,
    usage: parseTokenUsage(raw.usage),
    usageCheckedAt: numOrNull(raw.usageCheckedAt),
  };
}

function toolRank(id: string): number {
  const i = (TOOL_ORDER as readonly string[]).indexOf(id);
  return i < 0 ? TOOL_ORDER.length : i;
}

/** The `llm/accounts/list` body as a real doc. Anything that is not the
 *  daemon's shape (an error envelope, `{}`, `null`, a string) becomes an
 *  empty doc; rows that are not well-formed are dropped. Never throws. */
export function parseLlmTokensDoc(raw: unknown): LlmTokensDoc {
  const o = isRecord(raw) ? raw : {};
  const tools: LlmTokenTool[] = [];
  for (const t of arr(o.tools)) {
    if (!isRecord(t) || typeof t.tool !== "string" || t.tool === "") continue;
    const supported = t.supported === true;
    const accounts: LlmToken[] = [];
    for (const a of arr(t.accounts)) {
      const tok = parseToken(a, t.tool);
      if (tok) accounts.push(tok);
    }
    const activeId = typeof t.activeId === "string" && t.activeId !== "" ? t.activeId : null;
    // `active` on each row and the tool's `activeId` say the same thing;
    // trust `activeId` when it names a row, else the row flag.
    const fixed = activeId && accounts.some((a) => a.id === activeId)
      ? accounts.map((a) => ({ ...a, active: a.id === activeId }))
      : accounts;
    tools.push({
      tool: t.tool,
      display: str(t.display) || t.tool,
      supported,
      // Older daemons (before API keys) sent no flag: supported meant sign-in.
      subscription: typeof t.subscription === "boolean" ? t.subscription : supported,
      activeId: activeId ?? fixed.find((a) => a.active)?.id ?? null,
      switchedAt: numOrNull(t.switchedAt),
      accounts: fixed,
    });
  }
  tools.sort((a, b) => toolRank(a.tool) - toolRank(b.tool));
  const signingInIds = arr(o.logins)
    .filter(isRecord)
    .filter((l) => l.done !== true && typeof l.accountId === "string")
    .map((l) => l.accountId as string);
  return {
    tools,
    signingInIds,
    airgap: o.airgap === true,
    switchNote: str(o.switchNote),
  };
}

// ─── What the page shows ───

/** Tools worth a section: supported and holding at least one token. */
export function visibleTools(doc: LlmTokensDoc | null): LlmTokenTool[] {
  return (doc?.tools ?? []).filter((t) => t.supported && t.accounts.length > 0);
}

/** The server default first, then the others in the daemon's order. */
export function splitTool(tool: LlmTokenTool): { active: LlmToken | null; others: LlmToken[] } {
  const active = tool.accounts.find((a) => a.id === tool.activeId) ?? null;
  return { active, others: tool.accounts.filter((a) => a !== active) };
}

function planTitle(plan: string | null | undefined): string {
  const p = (plan ?? "").trim();
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : "";
}

/** Desktop `tokenName`: "Claude · Max · work" for a subscription, "API
 *  token · metered · billed per token" for a key. */
export function tokenName(toolDisplay: string, a: Pick<LlmToken, "kind" | "label" | "plan">): string {
  if (a.kind === "api_key") return `API token · ${a.label} · ${API_TOKEN_SUFFIX}`;
  return [toolDisplay, planTitle(a.plan), a.label].filter(Boolean).join(" · ");
}

export function isApiToken(a: Pick<LlmToken, "kind">): boolean {
  return a.kind === "api_key";
}

export const PINNED_REASON =
  "Set for a workspace or chat, so it can't also be the server default. Set those back to Server default from K2 on your desktop first.";
export const SIGNING_IN_REASON = "This token is signing in; finish or cancel that sign-in first.";
export const NEEDS_SIGN_IN_REASON = "Needs sign-in. Sign it in again from K2 on your desktop.";
export const API_TOKEN_REASON = "API tokens are billed per token. Make one the server default from K2 on your desktop.";

/** Why this token can't become the server default from the phone, or null
 *  when it can (a signed-in subscription that isn't the default, isn't
 *  set for a workspace or chat and isn't signing in — the daemon's own
 *  switch rules, plus subscriptions only). The default itself → null too:
 *  the page never offers a switch on it. */
export function switchBlockReason(doc: LlmTokensDoc | null, a: LlmToken): string | null {
  if (a.active) return null;
  if (isApiToken(a)) return API_TOKEN_REASON;
  if (a.state === "signing_in" || (doc?.signingInIds ?? []).includes(a.id)) return SIGNING_IN_REASON;
  if (a.state !== "signed_in") return NEEDS_SIGN_IN_REASON;
  if (a.pinnedTo.length > 0) return PINNED_REASON;
  return null;
}

export function canSwitchTo(doc: LlmTokensDoc | null, a: LlmToken): boolean {
  return !a.active && switchBlockReason(doc, a) === null;
}

/** "Session 42%" etc.: a whole percent used, clamped 0–100. */
export function percentUsed(used: number): number {
  return Math.max(0, Math.min(100, Math.round(used * 100)));
}

/** Desktop `formatResetsIn`: `45m`, `3h`, `4d`; `now` once past; "" when
 *  unknown. */
export function formatResetsIn(resetsAt: string, nowMs: number): string {
  const t = Date.parse(resetsAt);
  if (!resetsAt || Number.isNaN(t)) return "";
  const delta = t - nowMs;
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 90) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(delta / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(delta / 86_400_000)}d`;
}

/** When the token's usage was last read successfully (unix seconds). */
export function usageCheckedAtSecs(a: Pick<LlmToken, "usageCheckedAt" | "usage">): number | null {
  if (typeof a.usageCheckedAt === "number" && a.usageCheckedAt > 0) return a.usageCheckedAt;
  const t = a.usage?.checkedAt ? Date.parse(a.usage.checkedAt) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** "checked just now" / "checked 12 min ago" / "checked 3 h ago" /
 *  "checked 2 d ago" / "never checked". */
export function checkedAgoText(secs: number | null, nowMs: number = Date.now()): string {
  if (secs === null) return "never checked";
  const d = Math.max(0, Math.floor(nowMs / 1000) - secs);
  if (d < 60) return "checked just now";
  if (d < 3600) return `checked ${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `checked ${Math.floor(d / 3600)} h ago`;
  return `checked ${Math.floor(d / 86400)} d ago`;
}

/** Windows used up and not reset yet: "Session is used up (resets in
 *  3h)". Shown on a row before a confirm-free switch. */
export function exhaustedWindows(a: Pick<LlmToken, "usage">, nowMs: number = Date.now()): string[] {
  const out: string[] = [];
  for (const w of a.usage?.windows ?? []) {
    if (!(w.used >= 0.995)) continue;
    const until = formatResetsIn(w.resetsAt, nowMs);
    if (until === "now") continue;
    out.push(until ? `${w.label} is used up (resets in ${until})` : `${w.label} is used up`);
  }
  return out;
}

/** "Used by: K2, chat a1b2" (desktop `pinLabel`). */
export function pinnedToText(a: Pick<LlmToken, "pinnedTo">): string {
  return a.pinnedTo
    .map((p) => (p.scopeKind === "workspace" ? p.label : `chat ${p.label}`))
    .join(", ");
}

// ─── Failures ───

export type TokensFailureKind = "unsupported" | "forbidden" | "error";

/** A daemon older than 0.45.0 has no token routes: a login gets 404
 *  `route_unclassified`, the owner token `route not found`. */
const NO_ROUTE = /route_unclassified|route not found/i;

/** How the page treats a failed call. */
export function failureKind(status: number | undefined, error: string): TokensFailureKind {
  if (status === 404 || NO_ROUTE.test(error)) return "unsupported";
  if (status === 403 || /role_required|owner_only/.test(error)) return "forbidden";
  return "error";
}

export function unsupportedText(serverLabel: string): string {
  return `${serverLabel || "This server"}'s K2 doesn't support usage yet. Update K2 on that computer to see its subscriptions here.`;
}

export function forbiddenListText(serverLabel: string): string {
  return `Your login on ${serverLabel || "this server"} can't see its subscriptions. Ask the server's owner for a Member login or higher.`;
}

export const FORBIDDEN_SWITCH_TEXT = "Your login on this server isn't allowed to switch subscriptions.";
