import type { ThreadDoc, ThreadItem } from "../api/client";
import type { ProjectGroupMessage } from "../api/projectGroups";
import { parseThreadAttachments, type ThreadAttachment } from "../api/threadAttachmentPure";
import { parsePermissionCard, type PermissionCardModel } from "./permissionCardModel";

export type ThreadChoice = {
  prompt: string;
  options: string[];
  answer: string | null;
  /** K2 0.46.3 action cards: what the answer did ("Kept as yours. Undo in
   *  Settings → Gardens → Local Data."), once answered. Null otherwise. */
  resultMessage?: string | null;
  /** K2 0.46.3 permission card (`cards=2`): the rich, per-viewer view. */
  permission?: PermissionCardModel | null;
  /** The card's wire status: `pending` | `answered` | `voided` | `expired`.
   *  Absent from older servers (then an answer is the only close). */
  status?: string;
  /** K2 0.46.11 (prd-popup-close-and-card-dismiss-v1 B1): how a `voided`
   *  card closed, when a person dismissed it or its agent withdrew it.
   *  A `voided` card without it is a daemon close (hidden, as on desktop). */
  closedAs?: CardClosedAs;
  /** The one-line reason given with a dismiss or withdraw. */
  closeReason?: string;
  /** Who answered or dismissed it (`choice.answeredBy`). */
  closedBy?: CardAuthor;
};

export type CardClosedAs = "dismissed" | "withdrawn";
/** `answeredBy` on a card: `{kind: "owner" | "user" | "imported" | …, login, name?}`. */
export type CardAuthor = { kind: string; login: string; name?: string };

/** The daemon's limit on a dismiss reason (`CLOSE_REASON_MAX_CHARS`). */
export const CARD_DISMISS_REASON_MAX = 200;

export function parseCardAuthor(raw: unknown): CardAuthor | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind.trim() : "";
  const login = typeof r.login === "string" ? r.login.trim() : "";
  if (!kind || !login) return null;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  return name ? { kind, login, name } : { kind, login };
}

/** Who closed a card, as the desktop says it (K2 `cardAnswererLabel`):
 *  "You" for the signed-in person, the owner's name, else the login. */
export function cardAuthorLabel(a: CardAuthor | null | undefined, username: string): string | null {
  if (!a) return null;
  const me = username.trim().toLowerCase();
  if (me && a.kind === "user" && a.login.toLowerCase() === me) return "You";
  if (a.kind === "owner") {
    // The phone can't tell whether its person is the owner (only a login
    // of "owner" says so): the owner's name, never a guessed "You".
    if (me === "owner") return "You";
    return a.name && a.name.toLowerCase() !== "owner" ? a.name : "the owner";
  }
  if (a.kind === "imported") return a.name || a.login;
  return a.login;
}

/** "Dismissed by Bob: Shipped yesterday" / "Withdrawn by sales" (K2
 *  `closedCardLine`). */
export function closedCardLine(closedAs: CardClosedAs, who: string | null, agent: string, reason?: string | null): string {
  const head = closedAs === "dismissed" ? `Dismissed${who ? ` by ${who}` : ""}` : `Withdrawn${agent ? ` by ${agent}` : ""}`;
  const why = reason?.trim();
  return why ? `${head}: ${why}` : head;
}

/** A card the daemon closed by itself (a newer card replaced it, a switch
 *  went off): `voided` with no `closedAs`. Kept in memory, not drawn (K2
 *  `isVoidedHitl`). */
export function daemonClosedCard(c: ThreadChoice | null | undefined): boolean {
  return !!c && c.status === "voided" && !c.closedAs;
}

/** Still waiting for an answer (no answer, not voided or expired). */
export function cardOpen(c: ThreadChoice | null | undefined): boolean {
  if (!c) return false;
  if (c.answer != null && String(c.answer) !== "") return false;
  return !c.status || c.status === "pending";
}

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
  /** K2 0.46.1: files riding this message (`doc.attachments`). Absent
   *  when none. Shown only on a server listing `thread-attachments-v1`. */
  files?: readonly ThreadAttachment[];
  /** K2 0.46.7 `stash.offer` card: an agent offers a prompt for the
   *  person's stash (`doc.stash`). Saved on this device only; nothing is
   *  answered back. `text` keeps `doc.body`'s readable fallback. */
  stashOffer?: StashOffer;
  /** From a sealed push (lib/pushInbox), not yet confirmed by a server
   *  read: shown, but never a delta cursor (a gap before it would be
   *  skipped), and replaced by the server's copy. */
  provisional?: boolean;
  /** Cut short to fit the push: the rest arrives with the server's copy. */
  partial?: boolean;
  /** K2 0.46.13 tombstone (`deleted: true`): one muted "Message deleted"
   *  line on the sender's side. No bubble, name, status, receipt, files or
   *  menu; the receipt moves to the message before it. */
  deleted?: true;
};

/** What a deleted message shows, in the chat and as a list preview. */
export const DELETED_TEXT = "Message deleted";

export type StashOffer = { text: string; title: string | null };

/** Offer limits (shared with desktop, K2 4.1.4 review): longer text is
 *  not an offer (the body shows as a message); a title is one line. */
export const STASH_OFFER_TEXT_MAX = 20_000;
export const STASH_OFFER_TITLE_MAX = 200;

/** `doc.kind === "stash.offer"` with `doc.stash = {text, title?}`, posted
 *  by an agent (not a person's post: no `author`, not `via:"compose"`). */
export function stashOfferOf(doc: { kind?: unknown; stash?: unknown; author?: unknown; via?: unknown }): StashOffer | null {
  if (doc.kind !== "stash.offer" || !doc.stash || typeof doc.stash !== "object") return null;
  if (doc.author || doc.via === "compose") return null;
  const o = doc.stash as { text?: unknown; title?: unknown };
  if (typeof o.text !== "string" || !o.text.trim() || o.text.length > STASH_OFFER_TEXT_MAX) return null;
  const line = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim().slice(0, STASH_OFFER_TITLE_MAX) : "";
  return { text: o.text, title: line || null };
}

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
  const out: ThreadChoice = {
    prompt,
    options,
    answer: choiceAnswer(c.answer),
  };
  const message = actionResultMessage(c);
  if (message) out.resultMessage = message;
  const status = typeof c.status === "string" ? c.status.trim() : "";
  if (status) out.status = status;
  const closedAs = (c as { closedAs?: unknown }).closedAs;
  if (closedAs === "dismissed" || closedAs === "withdrawn") out.closedAs = closedAs;
  const reason = (c as { closeReason?: unknown }).closeReason;
  if (typeof reason === "string" && reason.trim()) out.closeReason = reason.trim();
  const by = parseCardAuthor((c as { answeredBy?: unknown }).answeredBy);
  if (by) out.closedBy = by;
  const permission = parsePermissionCard(c);
  if (permission) out.permission = permission;
  return out;
}

/** `choice.action.result.message` of an answered action card (K2 0.46.3),
 *  trimmed; null for any other card. */
export function actionResultMessage(c: { status?: unknown; action?: unknown } | null | undefined): string | null {
  if (!c || c.status !== "answered") return null;
  const action = c.action;
  if (!action || typeof action !== "object") return null;
  const result = (action as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const message = (result as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
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
  if (doc.deleted === true) {
    // A tombstone: kept (it replaces the message on screen and in the
    // cache), never dropped as empty, and nothing of the old one rides it.
    const from = String(doc.from || "");
    const atRaw = doc.created_at;
    const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : null;
    return { id, seq, text: "", from, at, mine: isMine(from, username), kind, choice: null, deleted: true };
  }
  const choice = choiceOf(doc);
  // Skin: item.doc.body ?? item.doc.text. Never item.text when doc exists.
  const textRaw = doc.body ?? doc.text ?? "";
  const text = typeof textRaw === "string" ? textRaw : "";
  // Files may ride a message with an empty body (chips, no bubble).
  const files = parseThreadAttachments(doc.attachments);
  if (!text && !files.length && kind === "text") return null;
  if (!text && !choice && !files.length) return null;
  const from = String(doc.from || "");
  const atRaw = doc.created_at;
  const at = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : null;
  const m: ThreadMessage = { id, seq, text, from, at, mine: isMine(from, username), kind, choice };
  if (files.length) m.files = files;
  const offer = stashOfferOf(doc as Parameters<typeof stashOfferOf>[0]);
  if (offer) m.stashOffer = offer;
  return m;
}

/** Project chat lines as Thread messages: `seq` is the list position,
 *  `readSeq` the line's own seq (K2 0.46.1). */
export function groupMessagesToThread(
  messages: ProjectGroupMessage[],
  username: string
): ThreadMessage[] {
  return messages.map((m, i) => ({
    id: m.id,
    seq: i,
    text: m.body,
    from: m.author,
    at: m.createdAt,
    mine: isMine(m.author, username),
    kind: "text",
    choice: null,
    ...(typeof m.seq === "number" && Number.isFinite(m.seq) ? { readSeq: m.seq } : null),
  }));
}
