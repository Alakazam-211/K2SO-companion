// People and channels on Home (K2 0.46.13, `home-chat-v1`): the wire types
// and parsers for `/cli/home-chat/*`, and the refusal shape every route and
// the DM call routes share. Pure: no I/O, never throws on server junk.
//
// Source of truth: K2's brief `companion-home-people-groups-brief-v1.md`
// §2.2–§2.7 and the code it cites on the 0.46.13 queue — the daemon's
// `crates/k2-daemon/src/home_chat/routes.rs` and the desktop's
// `src/renderer/lib/home-chat/api.ts`. Where they differ, the code wins.
//
// Rules the parsers keep:
//   - Ids are Sew's, decimal strings (a number is accepted and stringified).
//   - Unknown fields are ignored; a missing or mistyped field reads as its
//     empty value; a shape with no id is dropped (`null`), never thrown.
//   - Times: `createdAtMs` / `editedAtMs` are epoch MILLISECONDS (the
//     desktop keeps seconds; the phone's names say the unit).
//
// The I/O half is `homeChat.ts`; DM calls are `homeChatCallsPure.ts`; the
// events socket is `homeChatEvents.ts`; typing and send helpers are
// `homeChatHelpers.ts`.

import { parseCallSummary, type HomeChatCallSummary } from "./homeChatCallsPure";

/** The `/boot-status` feature key: listed only while the owner's `homeChat`
 *  switch is on, the server is Linux, Sew runs and the K5 Space is ready. */
export const HOME_CHAT_FEATURE = "home-chat-v1" as const;

// ─── Small readers ───

export function idOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return String(v);
  return null;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A Sew id as a request may carry it: 1–20 digits (the daemon refuses
 *  anything else with 400 `usage`, so the phone never sends one). */
export function isSewId(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,20}$/.test(v);
}

/** Compare two Sew ids (decimal strings, any length) numerically: the
 *  length first, then the string (brief §2.6 "Sort by id numerically"). */
export function compareSewIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** RFC 3339 (or epoch s / ms) → epoch ms; null when unreadable. */
export function msOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e12 ? Math.floor(v) : Math.floor(v * 1000);
  if (typeof v === "string" && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// ─── Status (the gate's second half, §2.2) ───

/** Why chat isn't usable on a server (`status.reason`). */
export type HomeChatOffReason = "off" | "mac" | "sew_off" | "space_pending";

/** Sew's Home flags, camelCase as the daemon serialises `HomeChatFeatures`
 *  (`tool_hook/features.rs`). All true with Sew 0.10.0. */
export interface HomeChatFlags {
  channelMemberAddRemove: boolean;
  channelMembersCanLeave: boolean;
  httpTyping: boolean;
  readStateUnreadCount: boolean;
  memberChannelsLevelOnly: boolean;
  agentsDmWithBoxPeople: boolean;
  callCancel: boolean;
}

export const NO_HOME_CHAT_FLAGS: Readonly<HomeChatFlags> = Object.freeze({
  channelMemberAddRemove: false,
  channelMembersCanLeave: false,
  httpTyping: false,
  readStateUnreadCount: false,
  memberChannelsLevelOnly: false,
  agentsDmWithBoxPeople: false,
  callCancel: false,
});

/** The person's link to Sew as the daemon holds it (`status.chat`,
 *  `hello.chat`, `status` frames). */
export type HomeChatLinkState = "connecting" | "live" | "unavailable" | "ended";

export interface HomeChatStatus {
  on: boolean;
  /** `off` | `mac` | `sew_off` | `space_pending` (a newer reason passes
   *  through as its string); null while on. */
  reason: HomeChatOffReason | (string & {}) | null;
  flags: HomeChatFlags;
  /** Null when the daemon holds no Sew session for this person yet. */
  chat: HomeChatLinkState | (string & {}) | null;
}

/** Only known flags, each `=== true`; anything else is false. */
export function parseHomeChatFlags(v: unknown): HomeChatFlags {
  const o = obj(v);
  const out: HomeChatFlags = { ...NO_HOME_CHAT_FLAGS };
  if (!o) return out;
  for (const k of Object.keys(out) as Array<keyof HomeChatFlags>) out[k] = o[k] === true;
  return out;
}

export function parseHomeChatStatus(v: unknown): HomeChatStatus | null {
  const o = obj(v);
  if (!o || typeof o.on !== "boolean") return null;
  return {
    on: o.on,
    reason: o.on ? null : strOrNull(o.reason),
    flags: parseHomeChatFlags(o.flags),
    chat: strOrNull(o.chat),
  };
}

/** The picker copy for a server whose chat isn't usable (desktop
 *  `HomeChatPickers.tsx` `noChatLine`; the Mac line reworded by K2
 *  Design's 4.3.0 review, with the server's name). */
export function homeChatMacLine(serverName?: string | null): string {
  return `Chat isn’t available on ${serverName?.trim() || "this server"}. It needs a Linux server.`;
}
export const HOME_CHAT_COPY_SPACE_PENDING = "Chat is still being set up on this server.";
export const HOME_CHAT_COPY_NO_CHAT = "No chat on this server.";
/** A Home row's short form (the row has no room for the reason). */
export const HOME_CHAT_COPY_ROW_NO_CHAT = "No chat on this server";

export function homeChatNoChatLine(reason: string | null | undefined, serverName?: string | null): string {
  if (reason === "mac") return homeChatMacLine(serverName);
  if (reason === "space_pending") return HOME_CHAT_COPY_SPACE_PENDING;
  return HOME_CHAT_COPY_NO_CHAT;
}

/** A Home row's line for a server with no usable chat: the short form,
 *  except while it is still being set up. */
export function homeChatRowNoChatLine(reason: string | null | undefined): string {
  return reason === "space_pending" ? HOME_CHAT_COPY_SPACE_PENDING : HOME_CHAT_COPY_ROW_NO_CHAT;
}

// ─── People (§2.4) ───

export type HomeChatRole = "owner" | "admin" | "member" | "voice_chat";

export interface HomeChatPerson {
  /** `k2:owner` or `k2:connect:<uuid>`. */
  ext: string;
  username: string;
  /** Their full name, else the username. */
  displayName: string;
  /** A `data:image/…` URL, else null (always null from 0.46.13). */
  picture: string | null;
  /** Present only for an Owner or Admin caller. */
  role: HomeChatRole | (string & {}) | null;
  /** False: "Setting up…", and they can't be picked. */
  ready: boolean;
  /** Their Sew member id (authors are named by it); null while pending. */
  memberId: string | null;
}

export interface HomeChatPeople {
  me: { ext: string; memberId: string | null };
  people: HomeChatPerson[];
}

export function parseHomeChatPerson(v: unknown): HomeChatPerson | null {
  const r = obj(v);
  const ext = r ? strOrNull(r.ext) : null;
  if (!r || !ext) return null;
  const username = str(r.username);
  return {
    ext,
    username,
    displayName: str(r.displayName) || username,
    picture: typeof r.picture === "string" && r.picture.startsWith("data:image/") ? r.picture : null,
    role: strOrNull(r.role),
    ready: r.ready === true,
    memberId: idOf(r.memberId),
  };
}

export function parseHomeChatPeople(v: unknown): HomeChatPeople {
  const o = obj(v) ?? {};
  const me = obj(o.me) ?? {};
  return {
    me: { ext: str(me.ext), memberId: idOf(me.memberId) },
    people: arr(o.people)
      .map(parseHomeChatPerson)
      .filter((p): p is HomeChatPerson => p !== null),
  };
}

// ─── Channels (§2.4, §2.6) ───

export interface HomeChatChannel {
  conv: string;
  name: string;
  open: boolean;
  /** As the server says it; when it doesn't, the inverse of `open`
   *  (desktop `fetchHomeChatChannels`). */
  inviteOnly: boolean;
  archived: boolean;
  /** Made from Home (K2's ledger knows it). */
  home: boolean;
  allowAgents: boolean;
}

export interface HomeChatChannelsPage {
  channels: HomeChatChannel[];
  /** Sew's browse cursor for `?after=`; null at the end. */
  next: string | null;
}

export function parseHomeChatChannel(v: unknown): HomeChatChannel | null {
  const r = obj(v);
  const conv = r ? idOf(r.conv) : null;
  if (!r || !conv) return null;
  const open = r.open === true;
  return {
    conv,
    name: str(r.name) || conv,
    open,
    inviteOnly: typeof r.inviteOnly === "boolean" ? r.inviteOnly : !open,
    archived: r.archived === true,
    home: r.home === true,
    allowAgents: r.allowAgents === true,
  };
}

export function parseHomeChatChannels(v: unknown): HomeChatChannelsPage {
  const o = obj(v) ?? {};
  return {
    channels: arr(o.channels)
      .map(parseHomeChatChannel)
      .filter((c): c is HomeChatChannel => c !== null),
    next: idOf(o.next),
  };
}

/** `channels/members` (by `conv`, or by `slug` while a new channel is
 *  pending). */
export interface HomeChatMembers {
  /** Null while `state` is `pending`. */
  conv: string | null;
  slug: string;
  /** `pending` | `active` | `archived`. */
  state: string;
  name: string;
  open: boolean;
  inviteOnly: boolean;
  /** The creator's ext. */
  creator: string;
  allowAgents: boolean;
  /** `state`: `pending_add` | `in` (pending removes are left out). */
  people: Array<{ ext: string; state: string }>;
  /** S8 (agent grants) isn't built: always `[]` from 0.46.13. */
  agents: Array<Record<string, unknown>>;
}

export function parseHomeChatMembers(v: unknown): HomeChatMembers | null {
  const o = obj(v);
  if (!o) return null;
  const slug = str(o.slug);
  const conv = idOf(o.conv);
  if (!slug && !conv) return null;
  const open = o.open === true;
  return {
    conv,
    slug,
    state: str(o.state),
    name: str(o.name),
    open,
    inviteOnly: typeof o.inviteOnly === "boolean" ? o.inviteOnly : !open,
    creator: str(o.creator),
    allowAgents: o.allowAgents === true,
    people: arr(o.people)
      .map((p) => obj(p))
      .filter((p): p is Record<string, unknown> => !!p && typeof p.ext === "string" && !!p.ext)
      .map((p) => ({ ext: p.ext as string, state: str(p.state) })),
    agents: arr(o.agents)
      .map((a) => obj(a))
      .filter((a): a is Record<string, unknown> => a !== null),
  };
}

/** `channels/create`: `conv` is null while `state` is `pending` — poll
 *  `channels/members?slug=` (`HOME_CHAT_CREATE_POLL_MS`, up to
 *  `HOME_CHAT_CREATE_WAIT_MS`). */
export interface HomeChatCreated {
  slug: string;
  conv: string | null;
  state: string;
  name: string;
  open: boolean;
}

export function parseHomeChatCreated(v: unknown): HomeChatCreated | null {
  const o = obj(v);
  const slug = o ? str(o.slug) : "";
  if (!o || !slug) return null;
  return { slug, conv: idOf(o.conv), state: str(o.state), name: str(o.name), open: o.open === true };
}

/** How long the creator waits for a new channel's id, and how often it
 *  asks (desktop `CREATE_WAIT_MS` / `CREATE_POLL_MS`). */
export const HOME_CHAT_CREATE_WAIT_MS = 30_000;
export const HOME_CHAT_CREATE_POLL_MS = 1_000;
export const HOME_CHAT_CREATE_TIMEOUT_COPY =
  "The channel is still being set up on that server. Add it from Add a channel in a moment.";
/** A channel name after trimming: 1–100 characters (`valid_channel_name`). */
export const HOME_CHAT_CHANNEL_NAME_MAX = 100;
/** A new channel takes fewer than this many people (`CHANNEL_MEMBERS_MAX`). */
export const HOME_CHAT_CREATE_MEMBERS_MAX = 100;

/** One `channels/add` outcome: `added`, `already`, or `refused` with the
 *  daemon's code (`refused: <code>` on the wire). */
export interface HomeChatAddOutcome {
  ext: string;
  outcome: "added" | "already" | "refused" | (string & {});
  /** The refusal's code when `outcome` is `refused`. */
  code: string | null;
}

export function parseHomeChatAddResults(v: unknown): HomeChatAddOutcome[] {
  const out: HomeChatAddOutcome[] = [];
  for (const r of arr(obj(v)?.results)) {
    const o = obj(r);
    if (!o || typeof o.ext !== "string") continue;
    const raw = str(o.outcome).trim();
    const m = /^refused:\s*(.*)$/.exec(raw);
    out.push(m ? { ext: o.ext, outcome: "refused", code: m[1] || null } : { ext: o.ext, outcome: raw || "refused", code: null });
  }
  return out;
}

// ─── Summary and badges (§2.6) ───

export type HomeChatBadge = { kind: "none" } | { kind: "dot" } | { kind: "count"; n: number };

/** The server caps a count at 99 and the row shows "99+" there. */
export const HOME_CHAT_BADGE_CAP = 99;

export function parseHomeChatBadge(v: unknown): HomeChatBadge {
  const b = obj(v);
  if (b?.kind === "count" && typeof b.n === "number" && Number.isFinite(b.n) && b.n > 0) {
    return { kind: "count", n: Math.min(Math.floor(b.n), HOME_CHAT_BADGE_CAP) };
  }
  if (b?.kind === "dot") return { kind: "dot" };
  return { kind: "none" };
}

/** What a badge reads: `""` for a dot, `"N"`, `"99+"` at the cap; null for
 *  none. */
export function homeChatBadgeText(b: HomeChatBadge): string | null {
  if (b.kind === "none") return null;
  if (b.kind === "dot") return "";
  return b.n >= HOME_CHAT_BADGE_CAP ? "99+" : String(b.n);
}

export interface HomeChatSummaryRow {
  conv: string;
  kind: "dm" | "channel";
  unread: boolean;
  badge: HomeChatBadge;
  /** RFC 3339 as Sew sent it, and as epoch ms. */
  lastAt: string | null;
  lastAtMs: number | null;
  lastMessageId: string | null;
  /** A DM's other person (their ext), when K2 kept the DM: how a person
   *  row finds its badge without opening the DM. */
  with: string | null;
  /** A channel: invite-only (lock) or open (#); null for a DM or not known
   *  yet (draws #). */
  inviteOnly: boolean | null;
}

export type HomeChatSummaryLink = "live" | "connecting" | "unavailable";

export interface HomeChatSummary {
  /** `unavailable` greys the rows with their last badges. */
  chat: HomeChatSummaryLink;
  convs: HomeChatSummaryRow[];
}

export function parseHomeChatSummaryRow(v: unknown): HomeChatSummaryRow | null {
  const r = obj(v);
  const conv = r ? idOf(r.conv) : null;
  if (!r || !conv) return null;
  const dm = r.kind === "dm";
  return {
    conv,
    kind: dm ? "dm" : "channel",
    unread: r.unread === true,
    badge: parseHomeChatBadge(r.badge),
    lastAt: strOrNull(r.lastAt),
    lastAtMs: msOf(r.lastAt),
    lastMessageId: idOf(r.lastMessageId),
    with: strOrNull(r.with),
    inviteOnly: !dm && typeof r.inviteOnly === "boolean" ? r.inviteOnly : null,
  };
}

export function parseHomeChatSummary(v: unknown): HomeChatSummary {
  const o = obj(v) ?? {};
  const chat = o.chat === "live" || o.chat === "connecting" ? o.chat : "unavailable";
  return {
    chat,
    convs: arr(o.convs)
      .map(parseHomeChatSummaryRow)
      .filter((r): r is HomeChatSummaryRow => r !== null),
  };
}

// ─── Messages (§2.6: Sew's, as the daemon passes them) ───

export interface HomeChatReaction {
  /** The Unicode emoji (v1 is Unicode only; custom emoji are dropped). */
  emoji: string;
  count: number;
  /** The viewer reacted with it (a ring on the chip). */
  me: boolean;
}

export interface HomeChatMessage {
  id: string;
  conv: string;
  /** A Sew member id; compare with `people.me.memberId` for "mine". */
  authorId: string;
  /** Markdown; `@name` is plain text. Empty once deleted. */
  body: string;
  createdAtMs: number;
  /** The channel seq (for `messages?since=`); 0 when absent. */
  seq: number;
  reactions: HomeChatReaction[];
  /** The original's id for a reply (Sew's inline `reference`, kind
   *  `reply`, never a sub-thread). */
  replyTo: string | null;
  edited: boolean;
  editedAtMs: number | null;
  deleted: boolean;
  /** The client nonce it was sent with (matches an optimistic copy). */
  nonce: string | null;
  /** A DM call's record: drawn as a line, not a bubble. */
  call: HomeChatCallSummary | null;
}

export function parseHomeChatReaction(v: unknown): HomeChatReaction | null {
  const r = obj(v);
  const e = obj(r?.emoji);
  if (!r || e?.kind !== "unicode" || typeof e.value !== "string" || !e.value) return null;
  const count = typeof r.count === "number" && Number.isFinite(r.count) ? Math.floor(r.count) : 0;
  if (count <= 0) return null;
  return { emoji: e.value, count, me: r.me === true };
}

/** A Sew message (a page item, a send / react answer, or a frame's
 *  `message`). Null without an id and a channel id. */
export function parseHomeChatMessage(v: unknown): HomeChatMessage | null {
  const m = obj(v);
  if (!m) return null;
  const id = idOf(m.id);
  const conv = idOf(m.channel_id);
  if (!id || !conv) return null;
  const ref = obj(m.reference);
  const deleted = m.deleted_at !== undefined && m.deleted_at !== null;
  const editedAtMs = msOf(m.edited_at);
  return {
    id,
    conv,
    authorId: idOf(m.author_id) ?? "",
    body: deleted ? "" : str(m.body),
    createdAtMs: msOf(m.created_at) ?? 0,
    seq: typeof m.seq === "number" && Number.isFinite(m.seq) ? m.seq : 0,
    reactions: deleted
      ? []
      : arr(m.reactions)
          .map(parseHomeChatReaction)
          .filter((r): r is HomeChatReaction => r !== null),
    replyTo: ref && ref.kind === "reply" ? idOf(ref.message_id) : null,
    edited: editedAtMs !== null,
    editedAtMs,
    deleted,
    nonce: strOrNull(m.nonce),
    call: m.call ? parseCallSummary(m.call) : null,
  };
}

export interface HomeChatPage {
  conv: string | null;
  /** Oldest first, by id. */
  messages: HomeChatMessage[];
  hasMore: boolean;
}

/** A Sew page (`{items, has_more}`, or a bare array) → oldest first. */
export function parseHomeChatPageBody(conv: string | null, page: unknown): HomeChatPage {
  const p = obj(page);
  const items = Array.isArray(page) ? page : arr(p?.items);
  const messages = items.map(parseHomeChatMessage).filter((m): m is HomeChatMessage => m !== null);
  messages.sort((a, b) => compareSewIds(a.id, b.id));
  return { conv, messages, hasMore: p?.has_more === true };
}

/** `GET messages?conv&before&after&limit` → `{ok, conv, page}`. */
export function parseHomeChatPage(v: unknown): HomeChatPage {
  const o = obj(v) ?? {};
  return parseHomeChatPageBody(idOf(o.conv), o.page);
}

/** One entry of Sew's channel changes feed (`messages?since=`). Sew's
 *  entry shape isn't in K2's code beyond `seq` / `kind` / `entity_id`
 *  (the person feed's), so the rest rides as `raw`. */
export interface HomeChatChange {
  seq: number;
  kind: string;
  entityId: string | null;
  /** A message the entry carries (`message` or `data`), when it does. */
  message: HomeChatMessage | null;
  raw: Record<string, unknown>;
}

/** `GET messages?conv&since=<seq>`: the changes, or — after Sew's 410 —
 *  `resync` with the newest page (throw away what you had). */
export type HomeChatDelta =
  | { kind: "changes"; conv: string | null; changes: HomeChatChange[]; nextSince: number | null; hasMore: boolean }
  | { kind: "resync"; conv: string | null; page: HomeChatPage };

export function parseHomeChatDelta(v: unknown): HomeChatDelta {
  const o = obj(v) ?? {};
  const conv = idOf(o.conv);
  if (o.resync === true) return { kind: "resync", conv, page: parseHomeChatPageBody(conv, o.page) };
  const c = obj(o.changes);
  const list = Array.isArray(o.changes) ? o.changes : arr(c?.entries ?? c?.items);
  const changes: HomeChatChange[] = [];
  for (const e of list) {
    const r = obj(e);
    if (!r) continue;
    changes.push({
      seq: typeof r.seq === "number" && Number.isFinite(r.seq) ? r.seq : 0,
      kind: str(r.kind),
      entityId: idOf(r.entity_id),
      message: parseHomeChatMessage(r.message ?? r.data),
      raw: r,
    });
  }
  const next = c?.next_since;
  return {
    kind: "changes",
    conv,
    changes,
    nextSince: typeof next === "number" && Number.isFinite(next) ? next : null,
    hasMore: c?.has_more === true,
  };
}

/** `reactors`: who reacted, as Sew member ids. */
export function parseHomeChatReactors(v: unknown): { memberIds: string[]; next: string | null } {
  const r = obj(obj(v)?.reactors);
  const items = Array.isArray(obj(v)?.reactors) ? arr(obj(v)?.reactors) : arr(r?.items);
  return {
    memberIds: items.map((x) => idOf(obj(x)?.member_id)).filter((x): x is string => x !== null),
    next: idOf(r?.next),
  };
}

// ─── Refusals (§2.3 shape; codes from §2.2, §2.3, §2.6, §3) ───

/** What the caller does about a refusal:
 *  - `not_supported` — an older server (plain 404: no route). Never ask
 *    again until its `/boot-status` lists `home-chat-v1`.
 *  - `off` — the owner's switch is off (`home_chat_off`; on the voice
 *    routes `voice_rooms_off`).
 *  - `unavailable` — on but not usable (`chat_unavailable`, `reason`).
 *  - `wrong_login` — the caller isn't a person's own login
 *    (`person_login_required`, `agents_use_k2_chat`, `app_session_not_allowed`).
 *  - `auth` — sign in / pair again (`unauthenticated`, `device_session_ended`).
 *  - `plan` — DM calls need the Pro plan (`host_not_pro`).
 *  - `denied` — this person may not (`not_a_member`, `admin_required`,
 *    `not_creator`, `target_disabled`, `not_a_person`, …).
 *  - `not_found` — `dm_not_found`, `channel_not_found`, `person_not_found`,
 *    `conversation_gone` (a DM gone on Sew's side), …
 *  - `conflict` — `channel_open`, `channel_archived`, …
 *  - `retry` — try again shortly (`chat_member_pending`, `voice_unavailable`,
 *    `too_many_sockets`, `send_in_progress`, …; `retryAfterMs` when the
 *    server said).
 *  - `usage` — the phone sent something wrong (400 / 405 / 413).
 *  - `server` — the server failed (5xx, `sew_error`).
 *  - `network` / `not_connected` / `removed` / `bad_response` — client side. */
export type HomeChatRefusalKind =
  | "not_supported"
  | "off"
  | "unavailable"
  | "wrong_login"
  | "auth"
  | "plan"
  | "denied"
  | "not_found"
  | "conflict"
  | "retry"
  | "usage"
  | "server"
  | "network"
  | "not_connected"
  | "removed"
  | "bad_response";

export interface HomeChatRefusal {
  ok: false;
  kind: HomeChatRefusalKind;
  /** The daemon's code (`home_chat_off`, …); `not_supported` for a plain
   *  404; the client's own for client-side kinds. */
  code: string;
  hint: string;
  /** HTTP status; null for client-side failures. */
  status: number | null;
  /** `details.retry_after_ms`, when the server sent it. */
  retryAfterMs?: number;
  /** `chat_unavailable`'s `(<reason>)` (`off`, `mac`, `sew_off`,
   *  `space_pending`), or `details.reason`. */
  reason?: string | null;
  details?: Record<string, unknown>;
}

/** Every answer: `{ok: true, …fields}` or a refusal. */
export type HomeChatResult<T extends object> = ({ ok: true } & T) | HomeChatRefusal;

const CODE_KIND: Record<string, HomeChatRefusalKind> = {
  home_chat_off: "off",
  voice_rooms_off: "off",
  chat_unavailable: "unavailable",
  person_login_required: "wrong_login",
  agents_use_k2_chat: "wrong_login",
  app_session_not_allowed: "wrong_login",
  app_user_not_allowed: "wrong_login",
  unauthenticated: "auth",
  device_session_ended: "auth",
  host_not_pro: "plan",
  not_a_member: "denied",
  admin_required: "denied",
  not_creator: "denied",
  target_disabled: "denied",
  not_a_person: "denied",
  missing_permission: "denied",
  owner_or_admin_only: "denied",
  agents_not_in_voice: "denied",
  dm_not_found: "not_found",
  channel_not_found: "not_found",
  person_not_found: "not_found",
  call_not_found: "not_found",
  // 0.46.13: a DM gone on Sew's side (a send answers 404; reopen it with
  // `/cli/home-chat/dm` and send again once).
  conversation_gone: "not_found",
  channel_open: "conflict",
  channel_archived: "conflict",
  room_full: "conflict",
  room_closing: "conflict",
  recording_consent_required: "conflict",
  chat_member_pending: "retry",
  // 0.46.13: the same nonce is still in flight (409): wait, send it again.
  send_in_progress: "retry",
  voice_unavailable: "retry",
  voice_member_pending: "retry",
  too_many_sockets: "retry",
  usage: "usage",
  method_not_allowed: "usage",
  too_large: "usage",
  origin_not_listed: "usage",
  internal: "server",
  sew_error: "server",
};

/** A refusal made on the phone (no request, or no answer). */
export function clientRefusal(
  kind: Extract<HomeChatRefusalKind, "network" | "not_connected" | "removed" | "bad_response" | "usage">,
  hint: string,
  status: number | null = null
): HomeChatRefusal {
  return { ok: false, kind, code: kind, hint, status };
}

/** `chat isn't available on this server (mac)` → `mac` (also the DM call
 *  routes' `calls aren't available on this server (…)`); the K5 Space hint
 *  → `space_pending`. Null otherwise. */
export function reasonFromHint(hint: string): string | null {
  const m = /(?:isn't|aren't) available on this server \(([a-z_]+)\)\s*$/.exec(hint);
  if (m) return m[1];
  if (/K5 Space isn't ready/i.test(hint)) return "space_pending";
  return null;
}

/** Map a non-2xx answer: K2's refusal shape
 *  `{ok:false, code, hint, error:{code, hint, details}, details}` (voice
 *  `routes.rs` `refuse`), the older `{error: "…"}` / `{error: {code, hint}}`,
 *  or a body that isn't JSON at all. */
export function parseHomeChatRefusal(status: number, text: string): HomeChatRefusal {
  let body: Record<string, unknown> | null = null;
  try {
    body = obj(JSON.parse(text));
  } catch {
    body = null;
  }
  const err = obj(body?.error);
  const code = strOrNull(body?.code) ?? strOrNull(err?.code) ?? "";
  const hint =
    strOrNull(body?.hint) ??
    strOrNull(err?.hint) ??
    (typeof body?.error === "string" ? (body.error as string) : null) ??
    (body ? "" : text.trim().slice(0, 200));
  const details = obj(body?.details) ?? obj(err?.details) ?? undefined;
  const retry = details?.retry_after_ms;
  const retryAfterMs = typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? retry : undefined;

  let kind: HomeChatRefusalKind;
  let outCode = code;
  if (status === 404 && (!code || code === "not_found" || code === "route_not_found")) {
    // 0.46.12 or older (no route), or a route newer than this server.
    kind = "not_supported";
    outCode = "not_supported";
  } else if (code === "chat_unavailable" && retryAfterMs !== undefined) {
    // K2 couldn't reach Sew just now (`sessions::unavailable`): transient.
    kind = "retry";
  } else if (CODE_KIND[code]) {
    kind = CODE_KIND[code];
  } else if (status === 401) {
    kind = "auth";
    outCode = code || "unauthenticated";
  } else if (status === 403 && !code && /auth token/i.test(hint)) {
    // The daemon's token gate (`Invalid or missing auth token`).
    kind = "auth";
    outCode = "unauthenticated";
  } else if (status === 403) kind = "denied";
  else if (status === 404) kind = "not_found";
  else if (status === 409) kind = "conflict";
  else if (status === 429 || status === 503 || retryAfterMs !== undefined) kind = "retry";
  else if (status >= 400 && status < 500) kind = "usage";
  else kind = "server";

  const reason =
    code === "chat_unavailable" ? reasonFromHint(hint) : strOrNull(details?.reason) ?? null;
  const out: HomeChatRefusal = { ok: false, kind, code: outCode || `http_${status}`, hint, status };
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
  if (reason !== null) out.reason = reason;
  if (details) out.details = details;
  return out;
}

/** Does a route's refusal say the server has no usable Home chat (the
 *  gate closes until its next re-check)? `not_supported` closes it only
 *  from the status read (a route newer than a 0.46.13 server isn't the
 *  whole feature missing), and a transient `chat_unavailable` (with a
 *  retry) is `retry`, which never closes it. */
export function refusalClosesGate(r: HomeChatRefusal): boolean {
  return r.kind === "off" || r.kind === "unavailable";
}
