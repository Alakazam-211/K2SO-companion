// Permission cards' writes (K2 0.46.3 phone contract v1 §3, §5): answer
// (Allow / Deny / Allow all / Deny all / Close, a batch item, a Deny
// reason, a confirm token), the waiting person's note, and "Turn off
// again". Responses carry no doc: the rewritten card arrives as a frame or
// in `changed[]`. Errors come back as words a person can act on.

import type { ServerScope } from "./scope";
import { scopedFetch } from "./scopedFetch";

export type PermissionWrite = { ok: true } | { ok: false; status: number | null; code: string; text: string };

function parseError(text: string): { code: string; reason: string; required: string; hint: string } {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error;
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : "");
      return { code: s(o.code), reason: s(o.reason) || s(j.reason), required: s(o.required) || s(j.required), hint: s(o.hint) };
    }
    if (typeof e === "string") return { code: e, reason: "", required: "", hint: "" };
  } catch {
    /* plain text */
  }
  return { code: "", reason: "", required: "", hint: "" };
}

/** What a person reads for a refused write. */
export function permissionErrorText(status: number | null, code: string, reason = "", required = ""): string {
  switch (code) {
    case "request_not_pending":
      return "Someone already answered this, or it closed.";
    case "action_card_person_only":
      return required === "owner" ? "Only the owner can answer this." : "Only an owner or admin can answer this.";
    case "vault_confirm_required":
      return "This needs your password to approve.";
    case "rate_limited":
      return "Too many tries. Wait a minute, then try again.";
    case "undo_expired":
      return "It's too late to turn this off here. Use Settings.";
    case "note_not_allowed":
      return "You can't leave a note on this.";
    case "bad_note":
      return reason === "too_long"
        ? "That note is too long."
        : reason === "newline"
          ? "Keep the note to one paragraph."
          : reason === "link"
            ? "Notes can't contain links."
            : reason === "secret"
              ? "That looks like a secret. Leave it out."
              : "That note can't be sent.";
    case "usage":
      return "This card changed. Pull to refresh.";
    default:
      return status == null ? "Could not reach the server." : `Could not send (HTTP ${status}).`;
  }
}

async function post(scope: ServerScope, path: string, body: Record<string, unknown>): Promise<PermissionWrite> {
  try {
    const r = await scopedFetch(scope, path, { method: "POST", body: JSON.stringify(body), timeoutMs: 20_000 });
    if (r.ok) return { ok: true };
    const e = parseError(r.text);
    return { ok: false, status: r.status, code: e.code, text: permissionErrorText(r.status, e.code, e.reason, e.required) };
  } catch {
    return { ok: false, status: null, code: "network", text: permissionErrorText(null, "network") };
  }
}

export function answerPermission(
  scope: ServerScope,
  addr: string,
  id: string,
  answer: string,
  opts: { item?: string; reason?: string; confirmToken?: string } = {}
): Promise<PermissionWrite> {
  return post(scope, "/cli/thread/answer", {
    addr,
    id,
    answer,
    ...(opts.item ? { item: opts.item } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.confirmToken ? { confirmToken: opts.confirmToken } : {}),
  });
}

export function notePermission(scope: ServerScope, addr: string, id: string, text: string): Promise<PermissionWrite> {
  return post(scope, "/cli/thread/permission-note", { addr, id, text });
}

export function undoPermission(scope: ServerScope, addr: string, id: string): Promise<PermissionWrite> {
  return post(scope, "/cli/thread/permission-undo", { addr, id });
}
