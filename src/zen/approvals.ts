import { invoke } from "@tauri-apps/api/core";

// Signed approvals (K2 PRD prd-signed-approvals-v1, wire contract dated
// note 2): the Thread's approval card. The card is the daemon's word only
// (status, who asked); it carries no payload. What is approved is read,
// shown and signed by native code (`plugin:k2-push|approval_open`), never
// here (SA-8): this file only asks the native screen to open a request id.

export type ApprovalStatus = "waiting" | "approved" | "declined" | "expired" | "cancelled";

export type ApprovalCardModel = {
  requestId: string;
  status: ApprovalStatus;
  /** Who asked, as the daemon reports it (SA-11). */
  requestedBy: string | null;
  answerBy: string | null;
  /** "iPhone (iPhone18,4)" once answered. */
  device: string | null;
  answeredVia: string | null;
};

const STATUSES: readonly ApprovalStatus[] = ["waiting", "approved", "declined", "expired", "cancelled"];
const REQUEST_ID = /^ap_[0-9a-f]{16}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** `doc.kind === "approval"` with `doc.approval = {requestId, status, …}`. */
export function approvalCardOf(doc: { kind?: unknown; approval?: unknown }): ApprovalCardModel | null {
  if (doc.kind !== "approval" || !doc.approval || typeof doc.approval !== "object") return null;
  const a = doc.approval as Record<string, unknown>;
  const requestId = str(a.requestId);
  if (!requestId || !REQUEST_ID.test(requestId)) return null;
  const status = STATUSES.includes(a.status as ApprovalStatus) ? (a.status as ApprovalStatus) : "waiting";
  const by = a.requestedBy;
  const requestedBy =
    str(by) ?? (by && typeof by === "object" ? str((by as Record<string, unknown>).agent) : null);
  return {
    requestId,
    status,
    requestedBy,
    answerBy: str(a.answerBy),
    device: str(a.device),
    answeredVia: str(a.answeredVia),
  };
}

/** The card's status line. */
export function approvalStatusLine(card: ApprovalCardModel): string {
  const on = card.device ? ` on ${card.device}` : "";
  switch (card.status) {
    case "approved":
      return `Approved${on}.`;
    case "declined":
      return `Declined${on}.`;
    case "expired":
      return "Expired before anyone answered.";
    case "cancelled":
      return "Withdrawn.";
    default:
      return "Waiting for you. Open it to read exactly what you'd approve.";
  }
}

export type ApprovalOutcome = "approved" | "declined" | "closed" | "failed";

/** Open the native approval screen; resolves when it closes. */
export async function openApproval(
  server: string,
  url: string,
  requestId: string
): Promise<{ outcome: ApprovalOutcome; detail?: string }> {
  try {
    const r = await invoke<{ outcome?: string; detail?: string }>("plugin:k2-push|approval_open", {
      server,
      url,
      requestId,
    });
    const outcome = (["approved", "declined", "closed"] as const).find((o) => o === r?.outcome) ?? "failed";
    return r?.detail ? { outcome, detail: r.detail } : { outcome };
  } catch (e) {
    return { outcome: "failed", detail: String(e) };
  }
}

/** This phone's approver keys (check + key id only), or [] off iOS. */
export async function approverKeyStatus(): Promise<{ check: string; keyId: string }[]> {
  try {
    const r = await invoke<{ keys?: { check: string; keyId: string }[] }>("plugin:k2-push|approver_keys", {
      op: "status",
    });
    return Array.isArray(r?.keys) ? r.keys : [];
  } catch {
    return [];
  }
}

/** The native Approver keys screen; resolves with the keys when it closes. */
export async function openApproverKeys(): Promise<{ check: string; keyId: string }[]> {
  try {
    const r = await invoke<{ keys?: { check: string; keyId: string }[] }>("plugin:k2-push|approver_keys", {
      op: "open",
    });
    return Array.isArray(r?.keys) ? r.keys : [];
  } catch {
    return [];
  }
}
