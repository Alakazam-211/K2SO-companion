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
// The passwords live in the screen's memory only: never stored, never
// logged, never sent anywhere but this server's own login routes.

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
} as const;

const POLICY_TIMEOUT_MS = 8000;
const CHANGE_TIMEOUT_MS = 10000;

/** Rust `char::is_alphanumeric` (Alphabetic or a Numeric category). */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;
/** Rust `char::is_uppercase` (the Uppercase property). */
const UPPER = /\p{Uppercase}/u;
/** Rust `char::is_ascii_digit`. */
const DIGIT = /[0-9]/;

/** One active rule of the policy, for the live checklist. */
export interface PasswordRule {
  id: "length" | "special" | "number" | "uppercase";
  label: string;
  met: boolean;
}

/** The active rules, in the server's order, each met or not for `pw`.
 *  Mirrors `connect_users::validate_password` exactly: length counts
 *  characters (code points), "special" is anything that is not a letter or
 *  number in any script, a number is 0–9, uppercase is any script's. */
export function passwordRules(pw: string, policy: PasswordPolicy): PasswordRule[] {
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
  return rules;
}

/** The server's own message for the first unmet rule, or null when `pw`
 *  passes (the same words the daemon's 400 carries). */
export function firstUnmetRule(pw: string, policy: PasswordPolicy): string | null {
  const miss = passwordRules(pw, policy).find((r) => !r.met);
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
      /** weak: 400 (the server's rule, verbatim). bad-current: 401.
       *  fixed: 403 password_fixed. unreachable: no answer (maybe sent).
       *  server: anything else. */
      kind: "weak" | "bad-current" | "fixed" | "unreachable" | "server";
      error: string;
    };

/** `POST <server>/cli/auth/change-password` as `token`. Not retried: a
 *  retry after a lost answer would read as a wrong current password. On
 *  success every session of this login has ended, `token` included. */
export async function changeServerPassword(
  serverUrl: string,
  token: string,
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await Promise.race([
      tauriFetch(`${base(serverUrl)}/cli/auth/change-password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
      timeout(CHANGE_TIMEOUT_MS, "change-password"),
    ]);
  } catch {
    let host = serverUrl;
    try {
      host = new URL(serverUrl).host;
    } catch {
      /* keep as given */
    }
    return { ok: false, kind: "unreachable", error: `Couldn't reach ${host} to set the password. Try again.` };
  }
  if (res.ok) return { ok: true };
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
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
