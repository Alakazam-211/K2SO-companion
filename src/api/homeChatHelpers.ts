// Home chat's pure client rules (brief §2.6, §5 item 10; desktop
// `lib/home-chat/chat.ts`, `stores/home-chat.ts`, `HomeChatView.tsx`):
//   - typing: send at most one `typing` per conversation every 8 s; a name
//     clears 10 s after its last frame, or at once when that member's
//     message arrives (Sew has no stop event);
//   - send with a nonce: a retry of the same words reuses the nonce, so
//     Sew never posts twice;
//   - merging pages and live frames (by id, oldest first), reactions,
//     deletes.
// No timers, no I/O: every function takes `now` and returns new state.

import { compareSewIds, type HomeChatMessage, type HomeChatReaction } from "./homeChatPure";

// ─── Typing ───

/** At most one `typing` call per conversation this often. */
export const TYPING_SEND_INTERVAL_MS = 8_000;
/** A name clears this long after its last typing frame. */
export const TYPING_CLEAR_MS = 10_000;

/** Per-conversation memory of when this device last sent `typing`. */
export type TypingSent = Readonly<Record<string, number>>;

/** Should the composer send `typing` for `conv` now? Blank drafts never
 *  do. Returns the memory to keep (unchanged when it says no). */
export function typingTick(
  sent: TypingSent,
  conv: string,
  draft: string,
  now: number,
  intervalMs = TYPING_SEND_INTERVAL_MS
): { send: boolean; sent: TypingSent } {
  if (!conv || !draft.trim()) return { send: false, sent };
  const last = sent[conv];
  if (last !== undefined && now - last < intervalMs && now >= last) return { send: false, sent };
  return { send: true, sent: { ...sent, [conv]: now } };
}

/** After a send (the message went), the next keystroke may say `typing`
 *  again at once. */
export function typingForget(sent: TypingSent, conv: string): TypingSent {
  if (!(conv in sent)) return sent;
  const next = { ...sent };
  delete next[conv];
  return next;
}

/** Who is typing in one conversation: member id → when the name clears
 *  (epoch ms). */
export type TypingRoster = Readonly<Record<string, number>>;

/** A `typing` frame from `member`. */
export function typingNoted(roster: TypingRoster, member: string, now: number, clearMs = TYPING_CLEAR_MS): TypingRoster {
  if (!member) return roster;
  return { ...roster, [member]: now + clearMs };
}

/** `member`'s message arrived (or they left): their name clears now. */
export function typingCleared(roster: TypingRoster, member: string): TypingRoster {
  if (!(member in roster)) return roster;
  const next = { ...roster };
  delete next[member];
  return next;
}

/** Drop names whose time is up (the same object when nothing changed). */
export function typingPruned(roster: TypingRoster, now: number): TypingRoster {
  let changed = false;
  const next: Record<string, number> = {};
  for (const [m, until] of Object.entries(roster)) {
    if (until > now) next[m] = until;
    else changed = true;
  }
  return changed ? next : roster;
}

/** The members typing now, oldest frame first. `me` (the viewer's own
 *  member id) is never listed. */
export function typingMembers(roster: TypingRoster, now: number, me: string | null = null): string[] {
  return Object.entries(roster)
    .filter(([m, until]) => until > now && m !== me)
    .sort((a, b) => a[1] - b[1])
    .map(([m]) => m);
}

/** When the next name clears (for one timer), or null. */
export function typingNextExpiry(roster: TypingRoster, now: number): number | null {
  let next: number | null = null;
  for (const until of Object.values(roster)) if (until > now && (next === null || until < next)) next = until;
  return next;
}

/** "Alex is typing…", "Alex and Sam are typing…", "Alex and 2 others are
 *  typing…"; "" when nobody is. */
export function typingLine(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} others are typing…`;
}

// ─── Send with a nonce ───

/** The daemon takes a nonce of 1–64 characters. */
export const NONCE_MAX = 64;

export function isValidNonce(v: unknown): boolean {
  return typeof v === "string" && v.length >= 1 && v.length <= NONCE_MAX;
}

/** A fresh client nonce (a UUID, 36 characters). */
export function newNonce(rand: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `n-${Date.now().toString(36)}-${Math.floor(rand() * 2 ** 52).toString(36)}`;
}

/** A send that hasn't been confirmed yet: what a retry must match to
 *  reuse its nonce. */
export interface PendingSend {
  conv: string;
  text: string;
  replyTo: string | null;
  nonce: string;
}

/** The nonce for sending `text` in `conv`: the kept one when this is a
 *  retry of the same words (same conversation, text and reply), else a
 *  new one. Keep the returned `pending` until the send is confirmed, then
 *  drop it. (The desktop matches conversation and text; the reply is
 *  matched too, so a retry never posts as a reply to the wrong message.) */
export function nonceForSend(
  kept: PendingSend | null,
  send: { conv: string; text: string; replyTo?: string | null },
  make: () => string = newNonce
): PendingSend {
  const replyTo = send.replyTo ?? null;
  if (kept && kept.conv === send.conv && kept.text === send.text && kept.replyTo === replyTo && isValidNonce(kept.nonce)) {
    return kept;
  }
  const made: string = make();
  const nonce = isValidNonce(made) ? made : made.slice(0, NONCE_MAX) || newNonce();
  return { conv: send.conv, text: send.text, replyTo, nonce };
}

/** The optimistic copy of a pending send, drawn until the server's
 *  message (same nonce) replaces it. Its id sorts after every real one. */
export function optimisticMessage(p: PendingSend, authorId: string, now: number): HomeChatMessage {
  return {
    id: `~${p.nonce}`,
    conv: p.conv,
    authorId,
    body: p.text,
    createdAtMs: now,
    seq: 0,
    reactions: [],
    replyTo: p.replyTo,
    edited: false,
    editedAtMs: null,
    deleted: false,
    nonce: p.nonce,
    call: null,
  };
}

export function isOptimistic(m: HomeChatMessage): boolean {
  return m.id.startsWith("~");
}

// ─── Merging ───

function sortKey(a: HomeChatMessage, b: HomeChatMessage): number {
  const oa = isOptimistic(a);
  const ob = isOptimistic(b);
  if (oa !== ob) return oa ? 1 : -1;
  if (oa && ob) return a.createdAtMs - b.createdAtMs;
  return compareSewIds(a.id, b.id);
}

/** Merge messages by id (a later copy wins), oldest first. A real message
 *  replaces the optimistic copy with its nonce. */
export function mergeHomeChatMessages(
  prev: readonly HomeChatMessage[],
  incoming: readonly HomeChatMessage[]
): HomeChatMessage[] {
  if (incoming.length === 0) return prev as HomeChatMessage[];
  const byId = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) {
    if (m.nonce && !isOptimistic(m)) byId.delete(`~${m.nonce}`);
    byId.set(m.id, m);
  }
  return [...byId.values()].sort(sortKey);
}

function withReaction(
  list: readonly HomeChatReaction[],
  emoji: string,
  count: number,
  me: boolean | null
): HomeChatReaction[] {
  const at = list.findIndex((r) => r.emoji === emoji);
  if (count <= 0) return at < 0 ? [...list] : list.filter((_, i) => i !== at);
  if (at < 0) return [...list, { emoji, count, me: me ?? false }];
  return list.map((r, i) => (i === at ? { emoji, count, me: me ?? r.me } : r));
}

/** A live `reaction` frame: the chip takes the frame's `count`; `me`
 *  changes only for the viewer's own (`mine`); 0 drops the chip. */
export function applyReactionFrame(
  messages: readonly HomeChatMessage[],
  f: { msg: string; emoji: string; on: boolean; count: number; mine: boolean }
): HomeChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.id !== f.msg) return m;
    changed = true;
    return { ...m, reactions: withReaction(m.reactions, f.emoji, f.count, f.mine ? f.on : null) };
  });
  return changed ? out : (messages as HomeChatMessage[]);
}

/** Tapping a chip: the optimistic toggle and the `on` to ask for. */
export function toggleReaction(
  messages: readonly HomeChatMessage[],
  msgId: string,
  emoji: string
): { messages: HomeChatMessage[]; on: boolean } {
  const m = messages.find((x) => x.id === msgId);
  const cur = m?.reactions.find((r) => r.emoji === emoji);
  const on = !cur?.me;
  if (!m) return { messages: messages as HomeChatMessage[], on };
  const count = (cur?.count ?? 0) + (on ? 1 : -1);
  return {
    messages: messages.map((x) => (x.id === msgId ? { ...x, reactions: withReaction(x.reactions, emoji, count, on) } : x)),
    on,
  };
}

/** A `deleted` frame: the message keeps its place with no words. */
export function markDeleted(messages: readonly HomeChatMessage[], id: string): HomeChatMessage[] {
  if (!messages.some((m) => m.id === id)) return messages as HomeChatMessage[];
  return messages.map((m) => (m.id === id ? { ...m, deleted: true, body: "", reactions: [] } : m));
}

/** The picker's quick row (§2.9). Unicode only. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"] as const;

/** Pages a reply's jump reads back before "Original not loaded". */
export const REPLY_JUMP_MAX_PAGES = 20;
