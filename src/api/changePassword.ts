// "Set your new password" (K2 Cloud S1 / connect-login-edge-only §4.2):
// a login with a temporary password must choose its own before the server
// lets it do anything else. The phone's half of the daemon contract; the
// screen is `zen/SetPasswordStep.tsx`, the steps `zen/setPasswordFlow.ts`.
//
// Contract (K2 `connect_users_routes.rs` + `connect_users.rs`, read-only):
//   login   POST /cli/auth/login → {token, username, expiresAt,
//           mustChangePassword} (always present). `true` = the session is
//           RESTRICTED: only whoami, change-password, logout, GET
//           users/policy, /boot-status answer; every other route 403s
//           {"error":"password_change_required"}.
//   policy  GET /cli/users/policy (a restricted session may read it) →
//           {minLength, requireSpecial, requireNumber, requireUppercase}.
//   change  POST /cli/auth/change-password {currentPassword, newPassword},
//           the session as Bearer, on the server's own address (not the
//           login edge):
//             200 {"success":true}; the server ends EVERY session of that
//                 login, this one too: sign in again with the new password
//             400 {"error":"<first unmet policy rule>"} (or "invalid request")
//             401 {"error":"unauthorized"}: wrong current password OR the
//                 login is locked (3 misses → 15 min), on purpose the same
//             403 {"error":"password_fixed","message":…}: only the owner or
//                 an Admin sets this login's password
//
// K2 0.46.16 (`companion-password-ticket-v1` in `/boot-status` features,
// K2 m_5qzyH1xo0I). Without the feature everything above stays as it is.
//   ticket  POST /cli/auth/device/password-ticket {username, password}, no
//           token, on the box's own address (a web-off box too; refused
//           from a browser page, fine for the app):
//             200 {ok, ticket:"k2pct_…", user, expiresAt, expiresInSecs:600,
//                 changePath:"/cli/auth/change-password"}
//             401 {error:{code:"password_invalid"}}: wrong password, unknown
//                 name, or nothing to change (on purpose the same)
//             423 {error:{code:"locked", retryAfterSecs}} + Retry-After
//             403 device_pairing_not_from_browser; 429 rate_limited; 400
//           The ticket goes as `Authorization: Bearer k2pct_…` on
//           changePath, works once, for nothing else, for 10 minutes.
//   change  answers apart: 401 {"error":"unauthorized"} (no live session
//           or ticket: start the step over), 401 current_password_wrong,
//           423 {"error":"locked", retryAfterSecs} + Retry-After, 400
//           password_unchanged; 400 rule text and 403 password_fixed as
//           before.
//   pair    the pairing 409 names the login and the ticket route:
//           {error:{code:"password_change_required", user, ticketPath}}.
//
// The passwords live in the screen's memory only: never stored, never
// logged, never sent anywhere but this server's own login routes. So does
// a ticket: one per attempt, a local of `setPasswordFlow`, never kept.

import { netFetch as tauriFetch } from "../lib/netStats";
import { apiErrorText } from "../lib/apiError";

/** Wire shape of `GET /cli/users/policy`. */
export interface PasswordPolicy {
  minLength: number;
  requireSpecial: boolean;
  requireNumber: boolean;
  requireUppercase: boolean;
}

/** The daemon's default (`PasswordPolicy::default`), used until (or when)
 *  the policy read fails. The server checks again on change anyway. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireSpecial: false,
  requireNumber: false,
  requireUppercase: false,
};

/** The screen's words. Desktop's `ROTATION_COPY` where it has one. */
export const SET_PASSWORD_COPY = {
  title: "Set your new password",
  lead: "Your server admin gave you a temporary password. Choose a new one to continue.",
  leadAskCurrent: (server: string) =>
    `${server} needs a new password before you can continue. Enter the temporary password you were given, then choose a new one.`,
  usernameLabel: "Username",
  currentLabel: "Temporary password",
  newLabel: "New password",
  confirmLabel: "Confirm new password",
  submit: "Set password and continue",
  busy: "Setting password…",
  back: "Back",
  missingUsername: "Enter your username.",
  missingCurrent: "Enter the temporary password you were given.",
  mismatch: "New passwords do not match.",
  badCurrent: "Temporary password incorrect, or too many attempts. Try again later.",
  weakFallback: "New password does not meet the requirements.",
  fixed: "This login's password is fixed: only the server's owner or an Admin changes it.",
  matchRule: "Both new passwords match",
  // K2 0.46.16 (`companion-password-ticket-v1`): the answers told apart.
  wrongCurrent: "Temporary password incorrect.",
  unchanged: "Choose a password different from your temporary one.",
  differentRule: "Different from your temporary password",
  ended: "Couldn't confirm your temporary password with the server. Try again.",
  /** A web-off box: the new password is set; pairing is how this phone
   *  signs in. */
  pairNext: "Password set. Now pair this phone: open K2 on your computer, get a pairing code, and enter it here.",
  /** From a pairing code: the code is checked again next. */
  pairNextFromCode: "Password set. Now pair this phone.",
} as const;

/** 423 (and a timed 429): "Too many tries. Try again in N minutes." Under a
 *  minute it counts seconds. */
export function lockedText(secs: number): string {
  const s = Math.max(1, Math.ceil(secs));
  if (s < 60) return `Too many tries. Try again in ${s} second${s === 1 ? "" : "s"}.`;
  const m = Math.ceil(s / 60);
  return `Too many tries. Try again in ${m} minute${m === 1 ? "" : "s"}.`;
}

/** The submit button while locked: "Try again in 14:59". */
export function lockedButtonText(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `Try again in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The `/boot-status` feature key for the ticket and the told-apart change
 *  answers (K2 0.46.16). */
export const FEATURE_PASSWORD_TICKET = "companion-password-ticket-v1";
export const DEFAULT_TICKET_PATH = "/cli/auth/device/password-ticket";
export const DEFAULT_CHANGE_PATH = "/cli/auth/change-password";

/** A route the server named (`ticketPath`, `changePath`): only a plain
 *  `/cli/…` path on the same server, else `fallback`. Never a URL. */
export function safeCliPath(p: unknown, fallback: string): string {
  return typeof p === "string" && /^\/cli\/[A-Za-z0-9/_-]+$/.test(p) && !p.includes("//") ? p : fallback;
}

const POLICY_TIMEOUT_MS = 8000;
const CHANGE_TIMEOUT_MS = 10000;
const TICKET_TIMEOUT_MS = 10000;
const BOOT_TIMEOUT_MS = 4000;

/** Rust `char::is_alphanumeric` (Alphabetic or a Numeric category). */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;
/** Rust `char::is_uppercase` (the Uppercase property). */
const UPPER = /\p{Uppercase}/u;
/** Rust `char::is_ascii_digit`. */
const DIGIT = /[0-9]/;

/** One active rule of the policy, for the live checklist. */
export interface PasswordRule {
  id: "length" | "special" | "number" | "uppercase" | "different";
  label: string;
  met: boolean;
}

/** The active rules, in the server's order, each met or not for `pw`.
 *  Mirrors `connect_users::validate_password` exactly: length counts
 *  characters (code points), "special" is anything that is not a letter or
 *  number in any script, a number is 0–9, uppercase is any script's. */
export function passwordRules(
  pw: string,
  policy: PasswordPolicy,
  /** `differentFrom`: the temporary password (K2 0.46.16 answers 400
   *  `password_unchanged`); the rule is listed only when given. */
  opts: { differentFrom?: string } = {}
): PasswordRule[] {
  const chars = [...pw];
  const rules: PasswordRule[] = [
    { id: "length", label: `At least ${policy.minLength} characters`, met: chars.length >= policy.minLength },
  ];
  if (policy.requireSpecial) {
    rules.push({
      id: "special",
      label: "A special character (not a letter or number)",
      met: chars.some((c) => !ALNUM.test(c)),
    });
  }
  if (policy.requireNumber) {
    rules.push({ id: "number", label: "A number (0–9)", met: chars.some((c) => DIGIT.test(c)) });
  }
  if (policy.requireUppercase) {
    rules.push({ id: "uppercase", label: "An uppercase letter", met: chars.some((c) => UPPER.test(c)) });
  }
  if (opts.differentFrom !== undefined) {
    rules.push({
      id: "different",
      label: SET_PASSWORD_COPY.differentRule,
      met: pw.length > 0 && pw !== opts.differentFrom,
    });
  }
  return rules;
}

/** The server's own message for the first unmet rule, or null when `pw`
 *  passes (the same words the daemon's 400 carries). */
export function firstUnmetRule(
  pw: string,
  policy: PasswordPolicy,
  opts: { differentFrom?: string } = {}
): string | null {
  const miss = passwordRules(pw, policy, opts).find((r) => !r.met);
  if (!miss) return null;
  switch (miss.id) {
    case "length":
      return `Password must be at least ${policy.minLength} characters.`;
    case "special":
      return "Password must include a special character.";
    case "number":
      return "Password must include a number.";
    case "uppercase":
      return "Password must include an uppercase letter.";
    case "different":
      return SET_PASSWORD_COPY.unchanged;
  }
}

export function parsePolicy(raw: unknown): PasswordPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.minLength !== "number" || !Number.isFinite(r.minLength)) return null;
  return {
    minLength: Math.max(0, Math.floor(r.minLength)),
    requireSpecial: r.requireSpecial === true,
    requireNumber: r.requireNumber === true,
    requireUppercase: r.requireUppercase === true,
  };
}

function base(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "");
}

function timeout(ms: number, what: string): Promise<never> {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms));
}

/** `GET <server>/cli/users/policy` with this login's (restricted) session.
 *  Null when it can't be read (no token, an older server, offline): the
 *  caller keeps what it has. */
export async function fetchPasswordPolicy(serverUrl: string, token: string | null): Promise<PasswordPolicy | null> {
  if (!token) return null;
  try {
    const res = await Promise.race([
      tauriFetch(`${base(serverUrl)}/cli/users/policy`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
      timeout(POLICY_TIMEOUT_MS, "policy"),
    ]);
    if (!res.ok) return null;
    return parsePolicy(JSON.parse(await res.text()));
  } catch {
    return null;
  }
}

export type ChangePasswordResult =
  | { ok: true }
  | {
      ok: false;
      /** weak: 400 (the server's rule, verbatim). bad-current: 401 (a
       *  pre-0.46.16 server: wrong OR locked; 0.46.16: current_password_wrong).
       *  ended: 0.46.16 401 `unauthorized`, the session or ticket is gone.
       *  locked: 0.46.16 423. unchanged: 0.46.16 400 password_unchanged.
       *  fixed: 403 password_fixed. unreachable: no answer (maybe sent).
       *  server: anything else. */
      kind: "weak" | "bad-current" | "ended" | "locked" | "unchanged" | "fixed" | "unreachable" | "server";
      error: string;
      /** `locked`: seconds until the server takes another try. */
      retryAfterSecs?: number;
    };

/** Seconds from a 423/429: the body's `retryAfterSecs` (top level or in
 *  `error`), else the Retry-After header, else `fallback`. */
function retryAfterOf(text: string, header: string | null | undefined, fallback: number | null): number | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j?.error;
    const v = typeof j?.retryAfterSecs === "number"
      ? j.retryAfterSecs
      : e && typeof e === "object" && typeof (e as Record<string, unknown>).retryAfterSecs === "number"
        ? ((e as Record<string, unknown>).retryAfterSecs as number)
        : null;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.ceil(v);
  } catch {
    /* not JSON */
  }
  const h = Number.parseInt(String(header ?? ""), 10);
  if (Number.isFinite(h) && h > 0) return h;
  return fallback;
}

/** The error code of `{error:"code"}` or `{error:{code}}`, or "". */
function errorCode(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: unknown })?.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return (e as { code: string }).code;
  } catch {
    /* not JSON */
  }
  return "";
}

/** The daemon's default lock (3 misses → 15 min), when a 423 names none. */
const DEFAULT_LOCK_SECS = 15 * 60;

type RawResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get?: (name: string) => string | null };
};

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/** `POST <server><path>` (`/cli/auth/change-password` unless a ticket
 *  named another) with `credential` as Bearer: a session token, or a
 *  K2 0.46.16 `k2pct_` ticket (never a cookie). Not retried: a retry after
 *  a lost answer would read as a wrong current password. On success every
 *  session of this login has ended, `credential` included.
 *
 *  `ticketContract` (the server lists `companion-password-ticket-v1`): its
 *  401s, 423 and `password_unchanged` are told apart. Without it a 401 is
 *  read the old way (wrong or locked, said both ways). */
export async function changeServerPassword(
  serverUrl: string,
  credential: string,
  currentPassword: string,
  newPassword: string,
  opts: { ticketContract?: boolean; path?: string } = {}
): Promise<ChangePasswordResult> {
  const path = safeCliPath(opts.path, DEFAULT_CHANGE_PATH);
  let res: RawResponse;
  try {
    res = await Promise.race([
      tauriFetch(`${base(serverUrl)}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
      timeout(CHANGE_TIMEOUT_MS, "change-password"),
    ]);
  } catch {
    return { ok: false, kind: "unreachable", error: `Couldn't reach ${hostOf(serverUrl)} to set the password. Try again.` };
  }
  if (res.ok) return { ok: true };
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  const code = errorCode(text);
  if (opts.ticketContract) {
    if (res.status === 423 || code === "locked") {
      const secs = retryAfterOf(text, res.headers?.get?.("retry-after"), DEFAULT_LOCK_SECS)!;
      return { ok: false, kind: "locked", error: lockedText(secs), retryAfterSecs: secs };
    }
    if (res.status === 400 && code === "password_unchanged") {
      return { ok: false, kind: "unchanged", error: SET_PASSWORD_COPY.unchanged };
    }
    if (res.status === 401) {
      if (code === "current_password_wrong") return { ok: false, kind: "bad-current", error: SET_PASSWORD_COPY.wrongCurrent };
      return { ok: false, kind: "ended", error: SET_PASSWORD_COPY.ended };
    }
  }
  if (res.status === 400) {
    let error: string = SET_PASSWORD_COPY.weakFallback;
    try {
      const e = (JSON.parse(text) as { error?: unknown })?.error;
      if (typeof e === "string" && e.trim() && e !== "invalid request") error = e;
    } catch {
      /* not JSON: keep the generic words */
    }
    return { ok: false, kind: "weak", error };
  }
  if (res.status === 401) return { ok: false, kind: "bad-current", error: SET_PASSWORD_COPY.badCurrent };
  if (res.status === 403 && /password_fixed/.test(text)) {
    let error: string = SET_PASSWORD_COPY.fixed;
    try {
      const m = (JSON.parse(text) as { message?: unknown })?.message;
      if (typeof m === "string" && m.trim()) error = m;
    } catch {
      /* keep ours */
    }
    return { ok: false, kind: "fixed", error };
  }
  return {
    ok: false,
    kind: "server",
    error: apiErrorText(text, `The server answered ${res.status} while setting the password.`),
  };
}

// ─── K2 0.46.16: the password ticket ───

export type PasswordTicketResult =
  /** `ticket` is a secret: the caller keeps it in a local only. */
  | { ok: true; ticket: string; changePath: string }
  | {
      ok: false;
      /** bad-current: 401 password_invalid. locked: 423 (or a timed 429).
       *  refused: 403 / an untimed 429 / 400. unreachable: no answer.
       *  server: anything else. */
      kind: "bad-current" | "locked" | "refused" | "unreachable" | "server";
      error: string;
      retryAfterSecs?: number;
    };

const RATE_TEXT = "Too many tries. Wait a minute and try again.";

/** `POST <server><ticketPath>` {username, password}, no token, on the
 *  box's own address (never the *.app.k2.dev edge: a web-off box answers
 *  it too). The ticket that comes back is used once and dropped. */
export async function requestPasswordTicket(
  serverUrl: string,
  username: string,
  password: string,
  ticketPath?: string | null
): Promise<PasswordTicketResult> {
  const path = safeCliPath(ticketPath, DEFAULT_TICKET_PATH);
  let res: RawResponse;
  try {
    res = await Promise.race([
      tauriFetch(`${base(serverUrl)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
      timeout(TICKET_TIMEOUT_MS, "password-ticket"),
    ]);
  } catch {
    return { ok: false, kind: "unreachable", error: `Couldn't reach ${hostOf(serverUrl)} to set the password. Try again.` };
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  if (res.ok) {
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* falls through to the missing-ticket answer */
    }
    const ticket = typeof j.ticket === "string" && /^k2pct_[0-9a-f]{16,}$/i.test(j.ticket) ? j.ticket : "";
    if (!ticket) return { ok: false, kind: "server", error: "The server's answer had no ticket. Try again." };
    return { ok: true, ticket, changePath: safeCliPath(j.changePath, DEFAULT_CHANGE_PATH) };
  }
  const code = errorCode(text);
  const retryHeader = res.headers?.get?.("retry-after");
  if (res.status === 401 || code === "password_invalid") {
    return { ok: false, kind: "bad-current", error: SET_PASSWORD_COPY.wrongCurrent };
  }
  if (res.status === 423 || code === "locked") {
    const secs = retryAfterOf(text, retryHeader, DEFAULT_LOCK_SECS)!;
    return { ok: false, kind: "locked", error: lockedText(secs), retryAfterSecs: secs };
  }
  if (res.status === 429) {
    const secs = retryAfterOf(text, retryHeader, null);
    if (secs) return { ok: false, kind: "locked", error: lockedText(secs), retryAfterSecs: secs };
    return { ok: false, kind: "refused", error: RATE_TEXT };
  }
  if (res.status === 403 || res.status === 400) {
    return {
      ok: false,
      kind: "refused",
      error: apiErrorText(text, `The server refused to set the password (HTTP ${res.status}).`),
    };
  }
  return {
    ok: false,
    kind: "server",
    error: apiErrorText(text, `The server answered ${res.status} while setting the password.`),
  };
}

/** Does the server at `serverUrl` list `companion-password-ticket-v1`?
 *  One `GET /boot-status` on its own address (the session as Bearer when
 *  one is held, once more without it on a 401/403). False when it can't be
 *  read or a stranger's view leaves the list out: the step then works as
 *  before the feature. Never throws. */
export async function serverListsPasswordTicket(serverUrl: string, token?: string | null): Promise<boolean> {
  const once = async (bearer: string | null | undefined) =>
    Promise.race([
      tauriFetch(
        `${base(serverUrl)}/boot-status`,
        bearer ? { method: "GET", headers: { Authorization: `Bearer ${bearer}` } } : { method: "GET" }
      ),
      timeout(BOOT_TIMEOUT_MS, "boot-status"),
    ]);
  try {
    let res = await once(token);
    if (token && (res.status === 401 || res.status === 403)) res = await once(null);
    if (!res.ok) return false;
    const body = JSON.parse(await res.text()) as { features?: unknown };
    return Array.isArray(body?.features) && body.features.includes(FEATURE_PASSWORD_TICKET);
  } catch {
    return false;
  }
}
