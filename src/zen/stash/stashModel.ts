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
// Pure: the store (stashStore) and the UI use these.

export const STASH_SCHEMA = 1;
/** Live stashes kept. The next save asks before removing the oldest. */
export const STASH_MAX = 50;
/** How long a delete's tombstone is kept for a later sync. */
export const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export type StashAttachment = { id: string; name: string; type: string; size: number };
export type StashQuote = { text: string; from?: string };
/** Where it was stashed: display only. */
export type StashSource = {
  serverId: string | null;
  serverLabel: string | null;
  user: string | null;
  /** The agent's address it was written to (or offered by). */
  agent: string | null;
  agentName: string | null;
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

export function newStashId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function emptySource(): StashSource {
  return { serverId: null, serverLabel: null, user: null, agent: null, agentName: null };
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

/** Live items, newest first (a tie: the later saved first). */
export function liveStash(items: readonly StashItem[]): StashItem[] {
  return items
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => item.deleted_at == null)
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
    .filter((i) => i.deleted_at != null && now - i.deleted_at > TOMBSTONE_KEEP_MS)
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
  const who = (s.agentName || s.agent || "").trim();
  const where = (s.serverLabel || "").trim();
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
        return [{ id: aid, name: str(x.name) ?? "file", type: str(x.type) ?? "", size: ms(x.size) ?? 0 }];
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
  return {
    v: ms(r.v) ?? STASH_SCHEMA,
    id,
    text: str(r.text) ?? "",
    attachments,
    quotes,
    source: {
      serverId: str(s.serverId),
      serverLabel: str(s.serverLabel),
      user: str(s.user),
      agent: str(s.agent),
      agentName: str(s.agentName),
    },
    created_at: created,
    updated_at: ms(r.updated_at) ?? created,
    deleted_at: ms(r.deleted_at),
  };
}
