// Fresh confirm for permission cards (K2 0.46.3, contract DRAFT §Q1). A
// card whose action needs the same confirm Settings asks for is answered
// with a one-use token, never with a password on the answer route:
//
//   POST /cli/vault/confirm/start  {action, secretId}            → {methods, expiresIn:60}
//   POST /cli/vault/confirm/finish {action, secretId,
//                                   method:"connect-password", password} → {token, expiresIn:60}
//   POST /cli/thread/answer        {addr, id, answer, confirmToken}
//
// The token is single use, lives 60 s and is bound to (action, secretId =
// the request id, this login). Five wrong passwords lock it (429). Only an
// Admin or Owner login may start. The phone has no biometric method: Face
// ID can only gate showing the password sheet.

import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";

export const CONFIRM_METHOD_LOGIN = "connect-password";
export const CONFIRM_METHOD_VAULT = "vault-password";

export type ConfirmErrorCode = "forbidden" | "wrong_password" | "locked" | "expired" | "unavailable" | "network";

export type ConfirmResult<T> = { ok: true; data: T } | { ok: false; code: ConfirmErrorCode; text: string };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errorCode(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") return str((e as Record<string, unknown>).code);
  } catch {
    /* plain text */
  }
  return "";
}

/** What a person reads for a confirm failure. */
export function confirmErrorText(code: ConfirmErrorCode): string {
  switch (code) {
    case "wrong_password":
      return "That password didn't match. Try again.";
    case "locked":
      return "Too many tries. Wait a minute, then try again.";
    case "expired":
      return "That took too long. Try again.";
    case "forbidden":
      return "Only an owner or admin can approve this.";
    case "unavailable":
      return "This server can't confirm from the phone. Approve on your desktop.";
    default:
      return "Could not reach the server.";
  }
}

async function post(scope: ServerScope, path: string, body: Record<string, unknown>) {
  return scopedFetch(scope, path, { method: "POST", body: JSON.stringify(body), timeoutMs: 15_000, revive: false });
}

function mapFailure(status: number, text: string): { ok: false; code: ConfirmErrorCode; text: string } {
  const c = errorCode(text);
  let code: ConfirmErrorCode = "network";
  if (status === 429) code = "locked";
  else if (status === 401 || /password|mismatch|invalid_credentials/i.test(c)) code = "wrong_password";
  else if (status === 403) code = "forbidden";
  else if (status === 410 || /expired/i.test(c)) code = "expired";
  else if (status === 404 || status === 405) code = "unavailable";
  return { ok: false, code, text: confirmErrorText(code) };
}

/** Step 1: which methods this login may use. */
export async function confirmStart(
  scope: ServerScope,
  action: string,
  secretId: string
): Promise<ConfirmResult<{ methods: string[]; expiresIn: number }>> {
  try {
    const r = await post(scope, "/cli/vault/confirm/start", { action, secretId });
    if (!r.ok) return mapFailure(r.status, r.text);
    const j = JSON.parse(r.text || "{}") as Record<string, unknown>;
    const methods = Array.isArray(j.methods) ? j.methods.filter((m): m is string => typeof m === "string") : [];
    return { ok: true, data: { methods, expiresIn: typeof j.expiresIn === "number" ? j.expiresIn : 60 } };
  } catch {
    return { ok: false, code: "network", text: confirmErrorText("network") };
  }
}

/** Step 2: the password → a one-use token. */
export async function confirmFinish(
  scope: ServerScope,
  action: string,
  secretId: string,
  password: string,
  method: string = CONFIRM_METHOD_LOGIN
): Promise<ConfirmResult<{ token: string }>> {
  try {
    const r = await post(scope, "/cli/vault/confirm/finish", { action, secretId, method, password });
    if (!r.ok) return mapFailure(r.status, r.text);
    const j = JSON.parse(r.text || "{}") as Record<string, unknown>;
    const token = str(j.token);
    if (!token) return { ok: false, code: "network", text: confirmErrorText("network") };
    return { ok: true, data: { token } };
  } catch {
    return { ok: false, code: "network", text: confirmErrorText("network") };
  }
}

/** The method the password sheet uses: the login's own password when the
 *  server offers it, else the vault password; null when neither (the card
 *  says "Approve on your desktop"). */
export function pickConfirmMethod(methods: readonly string[]): string | null {
  if (methods.includes(CONFIRM_METHOD_LOGIN)) return CONFIRM_METHOD_LOGIN;
  if (methods.includes(CONFIRM_METHOD_VAULT)) return CONFIRM_METHOD_VAULT;
  return null;
}
