// Prompt stash (spec "Prompt stash v1", Rosson 2026-10-29; shared schema
// with K2 0.46.7 desktop/web, K2 m_P6o9Lm8Ae3): a person stashes a message
// they are writing and brings it back later, into any agent's Thread.
//
// Like Home, stashes belong to the person on this device, not to a server:
// switching servers keeps the list, and a stash can go to an agent on any
// server. Each device keeps its own list until Home sync carries it, so the
// records are sync-ready: stable ids, snake_case ms epochs, a schema `v`,
// and soft-delete tombstones (text and attachments cleared, dropped after
// TOMBSTONE_KEEP_MS). Attachment bytes stay on the device by attachment id
// (stashBackend), never in the record. The cap counts live items only.
//
// Field rules settled after the 4.1.4 review (K2 spec-prompt-stash-v1,
// "Field rules settled"): snake_case keys; `server_id` is the server's
// host key (`rosson.k2.dev`), not this phone's saved-server id; `user` is
// the login name; `agent` is the sender (`doc.from`), in group chats too;
// absent fields are null; ids are uuid v4. A record from a newer schema
// (`v` > STASH_SCHEMA) is kept but hidden and never rewritten, so this
// client can't drop another's fields.
//
// Pure: the store (stashStore) and the UI use these.

export const STASH_SCHEMA = 1;
/** Live stashes kept. The next save asks before removing the oldest. */
export const STASH_MAX = 50;
/** How long a delete's tombstone is kept for a later sync. */
export const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** A file in a stash. Records carry a reference, never bytes: the
 *  device that saved it (the Homes-sync device id) and its path there.
 *  The phone has no lasting path (iOS hands over bytes), so its own
 *  attachments have `path: null` and their bytes stay on this phone,
 *  keyed by `id` (stash-sync-v1, K2 0.46.7). */
export type StashAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  device_id: string | null;
  path: string | null;
};
export type StashQuote = { text: string; from?: string };
/** Where it was stashed: display only. */
export type StashSource = {
  /** The server's host key (`rosson.k2.dev`). */
  server_id: string | null;
  server_label: string | null;
  /** The login name on that server. */
  user: string | null;
  /** The agent it was written to, or the sender of a saved message. */
  agent: string | null;
  agent_name: string | null;
};

export type StashItem = {
  v: number;
  id: string;
  text: string;
  attachments: StashAttachment[];
  quotes: StashQuote[];
  source: StashSource;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

/** A uuid v4 (randomUUID, else built from getRandomValues). */
export function newStashId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function emptySource(): StashSource {
  return { server_id: null, server_label: null, user: null, agent: null, agent_name: null };
}

/** This client's schema: shown, counted, editable. A newer one is kept
 *  as stored and left alone. */
export function isOwnSchema(item: Pick<StashItem, "v">): boolean {
  return item.v === STASH_SCHEMA;
}

export function makeStashItem(input: {
  text: string;
  attachments?: StashAttachment[];
  quotes?: StashQuote[];
  source?: Partial<StashSource>;
  now?: number;
  id?: string;
}): StashItem {
  const now = input.now ?? Date.now();
  return {
    v: STASH_SCHEMA,
    id: input.id ?? newStashId(),
    text: input.text,
    attachments: input.attachments ?? [],
    quotes: input.quotes ?? [],
    source: { ...emptySource(), ...input.source },
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

/** Live items of this schema, newest first (a tie: the later saved
 *  first). */
export function liveStash(items: readonly StashItem[]): StashItem[] {
  return items
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => item.deleted_at == null && isOwnSchema(item))
    .sort((a, b) => b.item.created_at - a.item.created_at || b.at - a.at)
    .map(({ item }) => item);
}

export function stashIsFull(items: readonly StashItem[], max = STASH_MAX): boolean {
  return liveStash(items).length >= max;
}

/** The live item a full stash would remove. */
export function oldestLive(items: readonly StashItem[]): StashItem | null {
  const live = liveStash(items);
  return live.length ? live[live.length - 1] : null;
}

/** A delete: the record stays (for sync) with its content cleared. */
export function tombstone(item: StashItem, now = Date.now()): StashItem {
  return { ...item, text: "", attachments: [], quotes: [], updated_at: now, deleted_at: now };
}

/** Ids of tombstones past TOMBSTONE_KEEP_MS. */
export function expiredTombstones(items: readonly StashItem[], now = Date.now()): string[] {
  return items
    .filter((i) => isOwnSchema(i) && i.deleted_at != null && now - i.deleted_at > TOMBSTONE_KEEP_MS)
    .map((i) => i.id);
}

/** A stash dropped into a box that already has text goes below it,
 *  after a blank line. */
export function insertBelow(existing: string, text: string): string {
  const head = existing.replace(/\s+$/, "");
  if (!head.trim()) return text;
  if (!text) return head;
  return `${head}\n\n${text}`;
}

/** Whether there is anything to stash. */
export function hasStashContent(text: string, attachmentCount: number): boolean {
  return Boolean(text.trim()) || attachmentCount > 0;
}

/** One line for the list: the first non-empty line, else the files. */
export function stashPreview(item: Pick<StashItem, "text" | "attachments">): string {
  const line = item.text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (line) return line;
  const n = item.attachments.length;
  if (n === 1) return item.attachments[0].name;
  return n ? `${n} files` : "";
}

/** "Rosson" / "k2-companion" / "agent on server": who it came from. */
export function stashSourceLabel(s: StashSource): string {
  const who = (s.agent_name || s.agent || "").trim();
  const where = (s.server_label || "").trim();
  if (who && where) return `${who} · ${where}`;
  return who || where;
}

/** "now", "5m", "3h", "2d", "4w": the item's age. */
export function stashAge(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const ms = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored record, or null when it is not one. Tolerates missing optional
 *  parts (a later schema adding fields). */
export function parseStashItem(raw: unknown): StashItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const created = ms(r.created_at);
  if (!id || created == null) return null;
  const attachments = Array.isArray(r.attachments)
    ? r.attachments.flatMap((a): StashAttachment[] => {
        if (!a || typeof a !== "object") return [];
        const x = a as Record<string, unknown>;
        const aid = str(x.id);
        if (!aid) return [];
        return [
          {
            id: aid,
            name: str(x.name) ?? "file",
            type: str(x.type) ?? "",
            size: ms(x.size) ?? 0,
            device_id: str(x.device_id),
            path: str(x.path),
          },
        ];
      })
    : [];
  const quotes = Array.isArray(r.quotes)
    ? r.quotes.flatMap((q): StashQuote[] => {
        if (!q || typeof q !== "object") return [];
        const x = q as Record<string, unknown>;
        const text = str(x.text);
        if (!text) return [];
        const from = str(x.from);
        return [from ? { text, from } : { text }];
      })
    : [];
  const s = (r.source && typeof r.source === "object" ? r.source : {}) as Record<string, unknown>;
  // snake_case is the shared shape; camelCase is what early 4.1.4 test
  // builds wrote, read once and rewritten on the next write.
  const pick = (snake: string, camel: string) => str(s[snake]) ?? str(s[camel]);
  return {
    v: ms(r.v) ?? STASH_SCHEMA,
    id,
    text: str(r.text) ?? "",
    attachments,
    quotes,
    source: {
      server_id: pick("server_id", "serverId"),
      server_label: pick("server_label", "serverLabel"),
      user: str(s.user),
      agent: str(s.agent),
      agent_name: pick("agent_name", "agentName"),
    },
    created_at: created,
    updated_at: ms(r.updated_at) ?? created,
    deleted_at: ms(r.deleted_at),
  };
}

/** The composer's note when a restored stash leaves files behind. */
export function missingFilesNote(missing: readonly { name: string; elsewhere: boolean }[]): string {
  if (!missing.length) return "";
  const elsewhere = missing.every((m) => m.elsewhere);
  if (missing.length === 1) {
    const name = missing[0].name;
    return elsewhere ? `${name} wasn't restored: it's on another device.` : `${name} couldn't be restored.`;
  }
  return elsewhere
    ? `${missing.length} files weren't restored: they're on another device.`
    : `${missing.length} files couldn't be restored.`;
}
