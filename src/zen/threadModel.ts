import type { ThreadItem } from "../api/client";

export type ThreadMessage = {
  id: string;
  seq: number | null;
  text: string;
  from: string;
  at: number | null;
  mine: boolean;
  pending?: boolean;
  failed?: boolean;
};

export function mountainTime(at: number | null): string {
  if (at == null || !Number.isFinite(at)) return "";
  const ms = at > 1e12 ? at : at * 1000;
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/Denver",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function isMine(from: string, username: string): boolean {
  if (!from) return false;
  if (from === "owner") return true;
  return !!username && from === username;
}

export function normaliseThreadItem(
  raw: ThreadItem | null | undefined,
  username: string
): ThreadMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw.doc && typeof raw.doc === "object" ? raw.doc : (raw as ThreadItem);
  const id = String(doc.id || raw.id || "");
  const seqRaw = raw.seq ?? doc.seq;
  const seq = typeof seqRaw === "number" && Number.isFinite(seqRaw) ? seqRaw : null;
  const text = doc.body ?? doc.text ?? "";
  if (typeof text !== "string" || (!text && (doc.kind || "text") === "text")) return null;
  const from = String(doc.from || "");
  const atRaw = doc.created_at;
  const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : null;
  return { id, seq, text, from, at, mine: isMine(from, username) };
}