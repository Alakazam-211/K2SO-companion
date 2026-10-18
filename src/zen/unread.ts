// Unread counts (K2 0.46.1 `thread-read-v1`) — pure helpers, no imports
// from the store or React so they test in isolation.
//
// The daemon owns every count (one read cursor per person and
// conversation). The phone keeps, per saved server, the conversations that
// have something unread, a card waiting, or a mute, plus the badge totals:
//   - `total`        = unread in unmuted conversations + every waiting card;
//   - `waitingTotal` = waiting cards everywhere, muted or not.
// `unread` is capped at 100 by the daemon and shown as "99+" above 99.
// `unread` and `waiting` never overlap (a pending card is only `waiting`).
//
// Row identity:
//   - a Thread (main chat or sidecar) is keyed by its conversationId; rows
//     know their overlay addr, so each server keeps an addr → conversationId
//     map learned from `/cli/thread/latest` rows and the open Thread;
//   - a project chat is keyed by its group id.

export type UnreadKind = "thread" | "project";

export interface UnreadEntry {
  kind: UnreadKind;
  /** A Thread's conversationId, or a project group id. */
  id: string;
  /** A Thread's workspace id; null for a project chat. */
  projectId: string | null;
  lastReadSeq: number;
  lastSeq: number;
  unread: number;
  waiting: number;
  muted: boolean;
  /** Unix seconds; null = until unmuted (or not muted). */
  mutedUntil: number | null;
}

export interface UnreadTotals {
  total: number;
  waitingTotal: number;
}

/** One server's unread state. */
export interface ServerUnread extends UnreadTotals {
  /** `${kind}:${id}` → entry, only while it says something. */
  byKey: Record<string, UnreadEntry>;
  /** The summary has landed at least once. */
  loaded: boolean;
}

export const EMPTY_SERVER_UNREAD: ServerUnread = {
  byKey: {},
  total: 0,
  waitingTotal: 0,
  loaded: false,
};

export function unreadKey(kind: UnreadKind, id: string): string {
  return `${kind}:${id}`;
}

/** What a count says: null at 0, "99+" above 99. */
export function unreadCountText(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n > 99 ? "99+" : String(Math.floor(n));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function count(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One `State` (summary row, POST reply, or frame). Frames tag their kind
 *  as `thread_read` / `project_read`. Null when it is not one. */
export function parseUnreadEntry(raw: unknown, kindHint?: UnreadKind): UnreadEntry | null {
  if (!isObj(raw)) return null;
  const k = raw.kind;
  const kind: UnreadKind | undefined =
    k === "thread" || k === "thread_read"
      ? "thread"
      : k === "project" || k === "project_read"
        ? "project"
        : kindHint;
  if (!kind || typeof raw.id !== "string" || !raw.id) return null;
  const until = raw.mutedUntil;
  return {
    kind,
    id: raw.id,
    projectId: typeof raw.projectId === "string" && raw.projectId ? raw.projectId : null,
    lastReadSeq: count(raw.lastReadSeq ?? raw.seq),
    lastSeq: count(raw.lastSeq),
    unread: count(raw.unread),
    waiting: count(raw.waiting),
    muted: raw.muted === true,
    mutedUntil: typeof until === "number" && Number.isFinite(until) ? until : null,
  };
}

/** `{total, waitingTotal}` from a summary, reply or frame. */
export function parseTotals(raw: unknown): UnreadTotals | null {
  if (!isObj(raw)) return null;
  const t = raw.total;
  const w = raw.waitingTotal;
  if (typeof t !== "number" || !Number.isFinite(t) || typeof w !== "number" || !Number.isFinite(w)) {
    return null;
  }
  return { total: Math.max(0, Math.floor(t)), waitingTotal: Math.max(0, Math.floor(w)) };
}

/** Kept only while it says something. */
export function worthKeeping(e: UnreadEntry): boolean {
  return e.unread > 0 || e.waiting > 0 || e.muted;
}

/** `GET /cli/thread/unread` → a server's state. Null when not a summary. */
export function parseUnreadSummary(raw: unknown): ServerUnread | null {
  const totals = parseTotals(raw);
  if (!totals || !isObj(raw) || !Array.isArray(raw.byConversation)) return null;
  const byKey: Record<string, UnreadEntry> = {};
  for (const row of raw.byConversation) {
    const e = parseUnreadEntry(row);
    if (e && worthKeeping(e)) byKey[unreadKey(e.kind, e.id)] = e;
  }
  return { byKey, ...totals, loaded: true };
}

/** Is `raw` a `thread_read` / `project_read` frame? */
export function isReadFrame(raw: unknown): boolean {
  return isObj(raw) && (raw.kind === "thread_read" || raw.kind === "project_read");
}

/** Replace one entry (and the totals when given). */
export function withEntry(
  s: ServerUnread,
  entry: UnreadEntry,
  totals: UnreadTotals | null
): ServerUnread {
  const key = unreadKey(entry.kind, entry.id);
  const byKey = { ...s.byKey };
  if (worthKeeping(entry)) byKey[key] = entry;
  else delete byKey[key];
  return { ...s, byKey, ...(totals ?? {}) };
}

/** What one conversation adds to `total`: unmuted unread + every waiting. */
export function badgeShare(e: UnreadEntry | null | undefined): number {
  if (!e) return 0;
  return (e.muted ? 0 : e.unread) + e.waiting;
}

/** Optimistic read up to `seq` (absent = newest): unread 0 (when `seq`
 *  reaches the newest) and the total drops by what that entry counted.
 *  Waiting cards stay. */
export function optimisticRead(s: ServerUnread, key: string, seq?: number): ServerUnread {
  const before = s.byKey[key];
  if (!before || before.unread === 0) return s;
  const readTo = seq === undefined ? before.lastSeq : Math.max(before.lastReadSeq, seq);
  // A partial read keeps what is still above the cursor (counted as best
  // we can: the server's reply corrects it).
  const left =
    before.lastSeq > 0 && readTo < before.lastSeq
      ? Math.min(before.unread, before.lastSeq - readTo)
      : 0;
  const after: UnreadEntry = { ...before, unread: left, lastReadSeq: readTo };
  const drop = before.muted ? 0 : before.unread - left;
  return withEntry(s, after, { total: Math.max(0, s.total - drop), waitingTotal: s.waitingTotal });
}

/** Optimistic mute / unmute: a muted conversation leaves the total. */
export function optimisticMute(
  s: ServerUnread,
  base: UnreadEntry,
  muted: boolean,
  mutedUntil: number | null
): ServerUnread {
  const delta = base.muted === muted ? 0 : muted ? -base.unread : base.unread;
  return withEntry(
    s,
    { ...base, muted, mutedUntil: muted ? mutedUntil : null },
    { total: Math.max(0, s.total + delta), waitingTotal: s.waitingTotal }
  );
}

export function blankEntry(kind: UnreadKind, id: string): UnreadEntry {
  return {
    kind,
    id,
    projectId: null,
    lastReadSeq: 0,
    lastSeq: 0,
    unread: 0,
    waiting: 0,
    muted: false,
    mutedUntil: null,
  };
}

// ─── Rows ───

/** What a list row needs to know about its conversation. */
export type RowRef =
  | { kind: "thread"; addr?: string | null; conversationId?: string | null }
  | { kind: "project"; groupId: string };

/** addr → conversationId, per server (keys lowercased). */
export type AddrMap = Record<string, string>;

export function addrKey(addr: string): string {
  return addr.trim().toLowerCase();
}

/** The conversationId a Thread row stands for, if known. */
export function conversationOf(ref: RowRef, addrs: AddrMap | undefined): string | null {
  if (ref.kind !== "thread") return null;
  if (ref.conversationId) return ref.conversationId;
  if (!ref.addr) return null;
  return addrs?.[addrKey(ref.addr)] ?? null;
}

/** The entry key for a row, or null when its identity is unknown. */
export function rowKeyOf(ref: RowRef, addrs: AddrMap | undefined): string | null {
  if (ref.kind === "project") return ref.groupId ? unreadKey("project", ref.groupId) : null;
  const conv = conversationOf(ref, addrs);
  return conv ? unreadKey("thread", conv) : null;
}

/** A row's state; null when nothing is unread, waiting or muted. */
export function entryForRow(
  s: ServerUnread | undefined,
  addrs: AddrMap | undefined,
  ref: RowRef | null
): UnreadEntry | null {
  if (!s || !ref) return null;
  const key = rowKeyOf(ref, addrs);
  return key ? s.byKey[key] ?? null : null;
}

/** How a row draws its marks. `tone` picks the colour:
 *  waiting (amber) > muted (grey) > unread (blue). */
export interface RowUnread {
  tone: "waiting" | "unread" | "muted";
  /** The number in the pill (waiting cards when amber, else unread). */
  count: number;
  /** Bold name + bright line two (something new, not muted). */
  emphasis: boolean;
  muted: boolean;
}

export function rowUnreadOf(e: UnreadEntry | null | undefined): RowUnread | null {
  if (!e) return null;
  if (e.waiting > 0) {
    return { tone: "waiting", count: e.waiting, emphasis: true, muted: e.muted };
  }
  if (e.unread > 0) {
    return e.muted
      ? { tone: "muted", count: e.unread, emphasis: false, muted: true }
      : { tone: "unread", count: e.unread, emphasis: true, muted: false };
  }
  if (e.muted) return { tone: "muted", count: 0, emphasis: false, muted: true };
  return null;
}

export const UNREAD_BLUE = "#0a84ff";
export const WAITING_AMBER = "#f59e0b";
export const MUTED_GREY = "#8e8e93";

export function toneColor(tone: RowUnread["tone"]): string {
  return tone === "waiting" ? WAITING_AMBER : tone === "muted" ? MUTED_GREY : UNREAD_BLUE;
}

// ─── Totals for the chrome ───

/** The open chat, to leave out of the back arrow's count. */
export interface OpenChat {
  serverId: string;
  ref: RowRef;
}

function sameServerRow(
  a: { serverId: string; key: string | null },
  b: { serverId: string; key: string | null }
): boolean {
  return !!a.key && a.serverId === b.serverId && a.key === b.key;
}

/** Back from a chat to the Agents list: that server's `total`, minus what
 *  the open chat counts. Never below 0. */
export function agentsBackCount(
  s: ServerUnread | undefined,
  addrs: AddrMap | undefined,
  open: RowRef | null
): number {
  if (!s) return 0;
  const openEntry = entryForRow(s, addrs, open);
  return Math.max(0, s.total - badgeShare(openEntry));
}

/** One Home row (or any row on any server). */
export interface ServerRowRef {
  serverId: string;
  ref: RowRef;
}

/** Back to Home: the sum over Home rows on every server (each
 *  conversation once), leaving the open chat out. */
export function homeBackCount(
  rows: ServerRowRef[],
  servers: Record<string, ServerUnread | undefined>,
  addrs: Record<string, AddrMap | undefined>,
  open: OpenChat | null
): number {
  const seen = new Set<string>();
  const openId = open
    ? { serverId: open.serverId, key: rowKeyOf(open.ref, addrs[open.serverId]) }
    : null;
  let n = 0;
  for (const r of rows) {
    const key = rowKeyOf(r.ref, addrs[r.serverId]);
    if (!key) continue;
    const id = `${r.serverId}|${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (openId && sameServerRow({ serverId: r.serverId, key }, openId)) continue;
    n += badgeShare(servers[r.serverId]?.byKey[key]);
  }
  return n;
}

/** Back to the Projects sheet: project chats on that server, minus the
 *  open one. */
export function projectsBackCount(s: ServerUnread | undefined, openGroupId: string | null): number {
  if (!s) return 0;
  let n = 0;
  for (const e of Object.values(s.byKey)) {
    if (e.kind !== "project" || e.id === openGroupId) continue;
    n += badgeShare(e);
  }
  return n;
}

/** The Agents header's Projects badge: project chats with something
 *  unread (unmuted) or waiting. */
export function projectBadgeCount(s: ServerUnread | undefined): number {
  if (!s) return 0;
  let n = 0;
  for (const e of Object.values(s.byKey)) {
    if (e.kind === "project" && (e.waiting > 0 || (!e.muted && e.unread > 0))) n += 1;
  }
  return n;
}

/** Home rows (`handle::hostKey`) → server rows. Rows whose host matches
 *  no saved server are dropped. */
export function homeRowRefs(
  rows: { address: string }[],
  servers: { id: string; hostKey: string }[],
  parse: (address: string) => { handle: string; host: string } | null
): ServerRowRef[] {
  const byHost = new Map(servers.map((s) => [s.hostKey.toLowerCase(), s.id]));
  const out: ServerRowRef[] = [];
  for (const r of rows) {
    const p = parse(r.address);
    if (!p) continue;
    const serverId = byHost.get(p.host.toLowerCase());
    if (!serverId) continue;
    out.push({ serverId, ref: { kind: "thread", addr: p.handle } });
  }
  return out;
}

/** Newest seq the reader has actually seen: the last delivered message's
 *  (`readSeq` for project chats, where `seq` is a list index). Null when
 *  none. */
export function newestSeenSeq(
  messages: { seq: number | null; readSeq?: number | null; pending?: boolean }[],
  kind: UnreadKind
): number | null {
  let best: number | null = null;
  for (const m of messages) {
    if (m.pending) continue;
    const s = kind === "project" ? m.readSeq : m.seq;
    if (typeof s !== "number" || !Number.isFinite(s)) continue;
    if (best === null || s > best) best = s;
  }
  return best;
}

/** Mute durations offered in the menus (seconds; null = until unmuted). */
export const MUTE_CHOICES: { label: string; seconds: number | null }[] = [
  { label: "Mute for 1 hour", seconds: 3600 },
  { label: "Mute for 8 hours", seconds: 8 * 3600 },
  { label: "Mute until I unmute", seconds: null },
];

/** A list row's identity: a project chat by group id, a Thread (main chat
 *  or sidecar) by its addr. */
export function rowRefOf(row: {
  kind?: string | null;
  groupId?: string | null;
  addr?: string | null;
}): RowRef | null {
  if (row.kind === "group") return row.groupId ? { kind: "project", groupId: row.groupId } : null;
  return row.addr ? { kind: "thread", addr: row.addr } : null;
}

/** A row's marks from the store's maps (for lists rendered in a loop). */
export function rowUnreadFor(
  servers: Record<string, ServerUnread | undefined>,
  addrs: Record<string, AddrMap | undefined>,
  serverId: string | null | undefined,
  row: { kind?: string | null; groupId?: string | null; addr?: string | null } | null
): RowUnread | null {
  if (!serverId || !row) return null;
  return rowUnreadOf(entryForRow(servers[serverId], addrs[serverId], rowRefOf(row)));
}
