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
  /** A project chat line's own seq (K2 0.46.1); `seq` there is the
   *  list position. What a read cursor is posted with. */
  readSeq?: number | null;
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
  if (Number.isNaN(d.getTime())) return "";
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

/** Chats-list when: today = time, yesterday = Yesterday, this week =
 *  weekday, older = numeric date. Mountain Time. Empty if no at. */
export function mountainListWhen(at: number | null): string {
  if (at == null || !Number.isFinite(at)) return "";
  const d = asDate(at);
  if (Number.isNaN(d.getTime())) return "";
  const key = mountainDayKey(d);
  const today = mountainDayKey(new Date());
  if (key === today) {
    return d.toLocaleTimeString("en-US", {
      timeZone: TZ,
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const yesterday = mountainDayKey(new Date(Date.now() - 86400000));
  if (key === yesterday) return "Yesterday";
  for (let i = 2; i <= 6; i++) {
    const k = mountainDayKey(new Date(Date.now() - i * 86400000));
    if (key === k) {
      return d.toLocaleDateString("en-US", {
        timeZone: TZ,
        weekday: "short",
      });
    }
  }
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

export function isMine(from: string, username: string): boolean {
  if (!from) return false;
  if (from === "owner") return true;
  return !!username && from === username;
}

/** Send authorship: owner or the signed-in username, never this
 *  thread's own agent handle — even when that handle equals username. */
export function isOwnerAuthored(
  from: string,
  username: string,
  agentHandle: string
): boolean {
  if (!from) return false;
  if (agentHandle && from === agentHandle) return false;
  return isMine(from, username);
}

/** Live GET /cli/thread (k2so-companion-qa seq 18, 2026-09-30):
 *  options are `{label}` objects, not strings. String(object) is
 *  "[object Object]". Take `label` from the wire; a plain string is
 *  still accepted. Drop an option that has neither. */
function optionLabel(o: unknown): string | null {
  if (typeof o === "string") {
    const s = o.trim();
    return s || null;
  }
  if (o && typeof o === "object" && "label" in o) {
    const label = (o as { label: unknown }).label;
    if (typeof label === "string") {
      const s = label.trim();
      return s || null;
    }
  }
  return null;
}

function choiceAnswer(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "label" in raw) {
    const label = (raw as { label: unknown }).label;
    if (typeof label === "string") return label;
  }
  return null;
}

function choiceOf(doc: ThreadDoc): ThreadChoice | null {
  const c = doc.choice;
  if (!c || typeof c !== "object") return null;
  const raw = c.options;
  const options = Array.isArray(raw)
    ? raw.map(optionLabel).filter((s): s is string => !!s)
    : typeof raw === "string"
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const prompt = String(c.prompt || doc.body || doc.text || "");
  return {
    prompt,
    options,
    answer: choiceAnswer(c.answer),
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
  // Skin: item.doc.body ?? item.doc.text. Never item.text when doc exists.
  const textRaw = doc.body ?? doc.text ?? "";
  const text = typeof textRaw === "string" ? textRaw : "";
  if (!text && kind === "text") return null;
  if (!text && !choice) return null;
  const from = String(doc.from || "");
  const atRaw = doc.created_at;
  const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : null;
  return { id, seq, text, from, at, mine: isMine(from, username), kind, choice };
}
