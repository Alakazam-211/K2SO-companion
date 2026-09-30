import type { ThreadDoc, ThreadItem } from "../api/client";

export type ThreadChoice = {
  prompt: string;
  options: string[];
  answer: string | null;
};

export type ThreadMessage = {
  id: string;
  seq: number | null;
  text: string;
  from: string;
  at: number | null;
  mine: boolean;
  kind: string;
  choice: ThreadChoice | null;
  pending?: boolean;
  failed?: boolean;
};

const TZ = "America/Denver";

function asDate(at: number): Date {
  return new Date(at > 1e12 ? at : at * 1000);
}

function mountainDayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function mountainTime(at: number | null): string {
  if (at == null || !Number.isFinite(at)) return "";
  const d = asDate(at);
  const time = d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
  const key = mountainDayKey(d);
  const today = mountainDayKey(new Date());
  const yesterday = mountainDayKey(new Date(Date.now() - 86400000));
  if (key === today) return time;
  if (key === yesterday) return `Yesterday ${time}`;
  const date = d.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
}

export function isMine(from: string, username: string): boolean {
  if (!from) return false;
  if (from === "owner") return true;
  return !!username && from === username;
}

function choiceOf(doc: ThreadDoc): ThreadChoice | null {
  const c = doc.choice;
  if (!c || typeof c !== "object") return null;
  const raw = c.options;
  const options = Array.isArray(raw)
    ? raw.map((o) => String(o))
    : typeof raw === "string"
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const prompt = String(c.prompt || doc.body || doc.text || "");
  return {
    prompt,
    options,
    answer: c.answer == null ? null : String(c.answer),
  };
}

export function normaliseThreadItem(
  raw: ThreadItem | null | undefined,
  username: string
): ThreadMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const doc: ThreadDoc =
    raw.doc && typeof raw.doc === "object" ? raw.doc : raw;
  const id = String(doc.id || raw.id || "");
  const seqRaw = raw.seq ?? doc.seq;
  const seq = typeof seqRaw === "number" && Number.isFinite(seqRaw) ? seqRaw : null;
  const kind = String(doc.kind || "text");
  const choice = choiceOf(doc);
  const text = typeof doc.body === "string" ? doc.body : typeof doc.text === "string" ? doc.text : "";
  if (!text && !choice) return null;
  const from = String(doc.from || "");
  const atRaw = doc.created_at;
  const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : null;
  return { id, seq, text, from, at, mine: isMine(from, username), kind, choice };
}
