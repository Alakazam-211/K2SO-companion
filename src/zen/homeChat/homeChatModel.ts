// The Home chat view's pure rules (people and channels on Home, K2 0.46.13
// `home-chat-v1`; brief §2.9 and §5). No I/O, no React: names, colours,
// reply previews, the reactors line, the emoji search, the members sheet's
// permissions and copy, and the rows the list draws. Ported from the
// desktop's `lib/home-chat/chat.ts`, `permissions.ts`,
// `HomeChatGlyphs.tsx`, `Presence/PresenceChip.tsx`,
// `HomeChatMembersSheet.tsx` (queue-0.46.13), copy kept word for word.

import { HOME_CHAT_CHANNEL_NAME_MAX, type HomeChatMessage, type HomeChatPeople, type HomeChatPerson } from "../../api/homeChatPure";
import { QUICK_REACTIONS } from "../../api/homeChatHelpers";
import { chatRuns, type RunPos } from "../chatReceipt";

// ─── What a chat is ───

/** One open DM or channel (`openHomeChat`'s argument). */
export interface HomeChatTarget {
  /** The saved server that holds the chat (its own login there). */
  serverId: string;
  kind: "dm" | "channel";
  /** Sew's conversation id. A DM may come with only `ext` (null here):
   *  the view opens (or makes) it with `POST /cli/home-chat/dm`. */
  conversationId: string | null;
  /** The row's name until the server says better (the person's name,
   *  the channel's name without `#`). */
  title: string;
  /** A DM's other person (`k2:owner` / `k2:connect:<uuid>`). */
  ext?: string | null;
  /** A channel: invite-only (lock) or open (#); null/absent: not known
   *  yet (drawn as #). */
  inviteOnly?: boolean | null;
}

/** `<serverId>|<conv>`: one conversation's key in the store. */
export function convKey(serverId: string, conv: string): string {
  return `${serverId}|${conv}`;
}

/** The composer draft's key for a conversation. */
export function homeChatDraftKey(serverId: string, conv: string | null): string | null {
  return conv ? `${serverId}|homechat:${conv}` : null;
}

// ─── People: names, colours, initials ───

/** The default person colours: the daemon's `person_color::PALETTE`, same
 *  order (the hash must match). Identity colours, like agents' avatar
 *  colours: not palette tokens. */
export const PERSON_COLORS = ["#3a9e96", "#3a87a8", "#6a6fc8", "#8c62c4", "#b25cb0", "#c45a86", "#9b7a95", "#64778f"] as const;

/** A username's colour: stable, from the daemon's string hash. */
export function personColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb` (anything else reads as black). */
export function relativeLuminance(hex: string): number {
  const c = /^#[0-9a-f]{6}$/i.test(hex.trim()) ? hex.trim().toLowerCase() : "#000000";
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Initials on `hex`: white or black, whichever reads better (one of the
 *  two always clears 4.5:1; desktop `personInk`). */
export function personInk(hex: string): string {
  const l = relativeLuminance(hex);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#000000";
}

/** Initials: one letter below 20px, two at 20px and up when the name has
 *  two parts (`Riley Stone` → `RL`, `anna` → `A`; desktop `chipInitials`). */
export function personInitials(name: string, size: number): string {
  const n = (name === "owner" ? "Owner" : name).trim();
  const parts = n.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (size >= 20 && parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

/** Member id → the name to show, from a server's people answer. */
export function memberNames(people: HomeChatPeople | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of people?.people ?? []) if (p.memberId) out.set(p.memberId, p.displayName || p.username);
  return out;
}

/** The name over a run or in a reply: "You" for the viewer, else the
 *  person's name, else "Someone" (a member K2 doesn't list). */
export function authorName(authorId: string, me: string | null, names: ReadonlyMap<string, string>): string {
  if (me && authorId === me) return "You";
  return names.get(authorId) ?? "Someone";
}

/** The person behind a member id (their colour comes from the username). */
export function personByMember(people: HomeChatPeople | null | undefined, memberId: string): HomeChatPerson | null {
  if (!memberId) return null;
  return people?.people.find((p) => p.memberId === memberId) ?? null;
}

/** Can this person be invited (ready, a member id, not you)? */
export function pickablePerson(p: HomeChatPerson, meExt: string): boolean {
  return p.ready && p.memberId !== null && p.ext !== meExt;
}

// ─── Replies ───

/** The first non-blank line of a message (the reply chip and quote strip). */
export function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/** What a sent reply's quote strip says about its original. */
export type ReplyPreview =
  | { state: "loaded"; author: string; line: string }
  | { state: "deleted" }
  | { state: "missing" };

export function replyPreview(
  original: HomeChatMessage | undefined,
  me: string | null,
  names: ReadonlyMap<string, string>
): ReplyPreview {
  if (!original) return { state: "missing" };
  if (original.deleted) return { state: "deleted" };
  return { state: "loaded", author: authorName(original.authorId, me, names), line: firstLine(original.body) };
}

/** The quote strip's two parts. */
export function quoteText(p: ReplyPreview): { from: string; line: string } {
  if (p.state === "loaded") return { from: p.author, line: p.line || "(no text)" };
  if (p.state === "deleted") return { from: "", line: ORIGINAL_DELETED };
  return { from: "", line: "Original not loaded · tap to find it" };
}

export const ORIGINAL_DELETED = "Original message deleted";
export const ORIGINAL_NOT_LOADED = "Original not loaded.";

/** The note after a reply's jump came back empty: read back to the first
 *  message without it (`gone`), or stopped after the page limit. */
export type JumpMiss = { id: string; gone: boolean };

// ─── Reactions ───

/** "Ana", "You and Ana", "You, Ana and 2 others": who reacted, You first. */
export function reactorsLine(names: readonly string[], max = 6): string {
  const you = names.filter((n) => n === "You");
  const list = [...you, ...names.filter((n) => n !== "You")];
  if (list.length === 0) return "";
  const shown = list.length > max ? list.slice(0, max - 1) : list;
  const rest = list.length - shown.length;
  const words = rest > 0 ? [...shown, `${rest} ${rest === 1 ? "other" : "others"}`] : shown;
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The chip's tip: who reacted with `emoji`, or that it is still asking. */
export function reactionTipText(names: readonly string[] | undefined, emoji: string): string {
  if (names === undefined) return `Finding who reacted with ${emoji}…`;
  if (names.length === 0) return `Reacted with ${emoji}`;
  return `${reactorsLine(names)} reacted with ${emoji}`;
}

/** Unicode emoji with search words (v1 is Unicode only; the desktop's
 *  list). Built in: no emoji dependency. */
export const EMOJI_INDEX: ReadonlyArray<readonly [string, string]> = [
  ["👍", "thumbs up yes ok like +1"], ["👎", "thumbs down no dislike -1"], ["❤️", "heart love red"],
  ["😂", "joy laugh tears lol"], ["🎉", "party tada celebrate congrats"], ["😮", "wow surprised open mouth"],
  ["🙏", "pray thanks please hands"], ["😀", "grin smile happy"], ["😃", "smile happy"], ["😄", "smile happy eyes"],
  ["😁", "beam grin"], ["😅", "sweat smile relief"], ["🤣", "rofl rolling laugh"], ["🙂", "slight smile"],
  ["😉", "wink"], ["😊", "blush smile"], ["😍", "heart eyes love"], ["🥰", "hearts love smile"], ["😘", "kiss"],
  ["😎", "cool sunglasses"], ["🤔", "thinking hmm"], ["🤨", "raised eyebrow skeptical"], ["😐", "neutral"],
  ["😑", "expressionless"], ["🙄", "eye roll"], ["😏", "smirk"], ["😬", "grimace awkward"], ["😴", "sleep tired"],
  ["😪", "sleepy"], ["😷", "mask sick"], ["🤒", "sick thermometer"], ["🤯", "mind blown exploding"],
  ["🥳", "party face celebrate"], ["😕", "confused"], ["😟", "worried"], ["😢", "cry sad tear"], ["😭", "sob crying"],
  ["😤", "triumph huff"], ["😠", "angry"], ["😡", "rage pouting"], ["🤬", "cursing"], ["😱", "scream fear"],
  ["😳", "flushed"], ["🥺", "pleading"], ["🤗", "hug"], ["🤭", "oops hand over mouth"], ["🤫", "shush quiet"],
  ["🤐", "zipper mouth"], ["🫡", "salute"], ["🫠", "melting"], ["🙃", "upside down"], ["😇", "angel innocent"],
  ["🤓", "nerd"], ["🧐", "monocle"], ["😈", "devil"], ["💀", "skull dead"], ["👀", "eyes look"], ["👋", "wave hello bye"],
  ["👏", "clap applause"], ["🙌", "raised hands hooray"], ["💪", "muscle strong"], ["🤝", "handshake deal"],
  ["✌️", "victory peace"], ["🤞", "fingers crossed luck"], ["👌", "ok perfect"], ["🤌", "pinched"], ["👉", "point right"],
  ["👈", "point left"], ["👆", "point up"], ["👇", "point down"], ["☝️", "index up"], ["✋", "hand stop"],
  ["🖐️", "hand fingers"], ["🤙", "call me shaka"], ["💯", "hundred 100 perfect"], ["🔥", "fire hot lit"],
  ["✨", "sparkles shiny"], ["⭐", "star"], ["🌟", "glowing star"], ["⚡", "zap lightning"], ["💥", "boom collision"],
  ["💡", "idea bulb"], ["✅", "check done yes"], ["☑️", "check box"], ["✔️", "check mark"], ["❌", "cross no wrong"],
  ["❓", "question"], ["❗", "exclamation"], ["⚠️", "warning"], ["🚀", "rocket launch ship"], ["🎯", "target bullseye"],
  ["🏆", "trophy win"], ["🥇", "gold medal first"], ["🎁", "gift present"], ["🎂", "cake birthday"], ["☕", "coffee"],
  ["🍕", "pizza"], ["🍺", "beer"], ["🍻", "cheers beers"], ["🥂", "champagne toast"], ["🍿", "popcorn"],
  ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"],
  ["🖤", "black heart"], ["🤍", "white heart"], ["💔", "broken heart"], ["💕", "two hearts"], ["💖", "sparkling heart"],
  ["👻", "ghost"], ["🤖", "robot"], ["🐛", "bug"], ["🐞", "ladybug bug"], ["🦄", "unicorn"], ["🐶", "dog"], ["🐱", "cat"],
  ["🌈", "rainbow"], ["☀️", "sun"], ["🌙", "moon night"], ["❄️", "snow cold"], ["🌊", "wave water"],
  ["📌", "pin pushpin"], ["📎", "paperclip"], ["📝", "memo note write"], ["📅", "calendar date"], ["⏰", "alarm clock"],
  ["⏳", "hourglass wait"], ["🔒", "lock"], ["🔑", "key"], ["🛠️", "tools fix"], ["🔧", "wrench"], ["🧪", "test tube"],
  ["📈", "chart up growth"], ["📉", "chart down"], ["💰", "money bag"], ["🎵", "music note"], ["🎶", "music notes"],
  ["📣", "megaphone announce"], ["🔔", "bell"], ["💬", "speech bubble chat"], ["👍🏻", "thumbs up light"],
  ["🆗", "ok button"], ["🆒", "cool button"], ["➕", "plus"], ["➖", "minus"], ["🟢", "green circle"], ["🔴", "red circle"],
];

/** Emoji whose words start with every word of `q` (case-insensitive). A
 *  blank query lists them all, the quick six first (the sheet's grid). */
export function searchEmoji(q: string, limit = EMOJI_INDEX.length): string[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    const quick: string[] = [...QUICK_REACTIONS];
    return [...quick, ...EMOJI_INDEX.map(([e]) => e).filter((e) => !quick.includes(e))].slice(0, limit);
  }
  const out: string[] = [];
  for (const [emoji, keys] of EMOJI_INDEX) {
    const ks = keys.split(" ");
    if (words.every((w) => ks.some((k) => k.startsWith(w)))) out.push(emoji);
    if (out.length >= limit) break;
  }
  return out;
}

export { QUICK_REACTIONS };

// ─── The members sheet ───

/** A channel name: 1–100 characters after trimming. */
export const HOME_CHAT_NAME_MAX = HOME_CHAT_CHANNEL_NAME_MAX;

/** Is the caller an Owner or Admin there? The owner's login is
 *  `k2:owner`; the people list carries roles only for an Owner or Admin. */
export function callerIsAdmin(people: HomeChatPeople | null | undefined): boolean {
  if (!people) return false;
  if (people.me.ext === "k2:owner") return true;
  return people.people.some((p) => p.role !== null);
}

export interface ChannelFacts {
  callerExt: string;
  admin: boolean;
  creator: string;
  /** The caller is in the channel. */
  member: boolean;
  open: boolean;
  archived: boolean;
}

export interface ChannelPerms {
  addPeople: boolean;
  removeOthers: boolean;
  leave: boolean;
  rename: boolean;
  remove: boolean;
}

/** What the caller may do (the daemon checks each again; this only hides
 *  what would be refused). */
export function channelPerms(f: ChannelFacts): ChannelPerms {
  const live = !f.archived;
  const own = f.creator !== "" && f.creator === f.callerExt;
  return {
    addPeople: live && f.member,
    // An open channel is open to everyone: no one is removed from it.
    removeOthers: live && f.admin && !f.open,
    leave: f.member || f.open,
    rename: live && (own || f.admin),
    remove: live && (own || f.admin),
  };
}

/** Delete's question names the channel as its row does: `#general`, or a
 *  bare name for an invite-only one (its glyph is a lock). */
export function deleteTitle(c: { name: string; open: boolean } | null): string {
  if (!c) return "Delete this channel?";
  return `Delete ${c.open ? "#" : ""}${c.name}?`;
}

export const DELETE_MESSAGE = "No one can post in it again. Everyone in it keeps its history, read-only.";

/** Leave's question and its words. */
export function leaveCopy(c: { name: string; open: boolean } | null): { title: string; message: string } {
  return {
    title: `Leave ${c?.name ?? "this channel"}?`,
    message: c?.open
      ? "You can join it again from Add channel: it is open to everyone on this server."
      : "You lose access at once. Someone in the channel can add you back.",
  };
}

/** Where a Home chat message saved to the stash came from (the stash's
 *  shared source fields): the server, your login there, and the
 *  conversation's other person (a DM) or the channel. */
export function homeChatStashSource(
  server: { hostKey: string; label: string; user: string },
  chat: { kind: "dm" | "channel"; ext?: string | null; conv: string | null; title: string; inviteOnly?: boolean | null }
): { server_id: string | null; server_label: string | null; user: string | null; agent: string | null; agent_name: string | null } {
  const dm = chat.kind === "dm";
  return {
    server_id: server.hostKey || null,
    server_label: server.label || null,
    user: server.user || null,
    agent: (dm ? chat.ext : chat.conv) || null,
    agent_name: chat.title ? (dm || chat.inviteOnly ? chat.title : `#${chat.title}`) : null,
  };
}

/** A role as the sheet says it: Owner, Admin; a member says nothing. */
export function memberRoleLabel(role: string | null | undefined): string | null {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return null;
}

/** "Open to everyone on this server · 4 people". */
export function membersSubline(c: { open: boolean; state: string; people: readonly unknown[] }): string {
  const n = c.people.length;
  return `${c.open ? "Open to everyone on this server" : "Invite only"} · ${n === 1 ? "1 person" : `${n} people`}${
    c.state === "archived" ? " · Archived: read-only" : ""
  }`;
}

// ─── Sending ───

/** The line above the box when a send fails: the reason, and that the
 *  bubble can be sent again (same nonce, so never twice). */
export function sendFailedLine(reason: string): string {
  const why = reason.trim().replace(/[.\s]+$/, "");
  return `Not sent${why ? ` (${why})` : ""}. Tap Retry on the message to send it again.`;
}

/** The line for a failed send: a final one (no Retry, e.g. an archived
 *  channel) says only why; the rest offer Retry. */
export function sendFailedNote(s: { error: string | null; final?: boolean } | null | undefined): string {
  if (s?.final) return (s.error ?? "").trim() || "Not sent.";
  return sendFailedLine(s?.error ?? "");
}

// ─── The rows the list draws ───

export type HomeChatRow =
  | {
      kind: "call";
      m: HomeChatMessage;
    }
  | {
      kind: "message";
      m: HomeChatMessage;
      mine: boolean;
      /** The name over its run (null: none, mine or a DM's own). */
      name: string | null;
      run: RunPos;
    };

/** Every message as a row: a call's record is a line, never a bubble (and
 *  never part of a run); the rest run as the Thread's do. Names: in a
 *  channel over every run of someone else's; in a DM over the other
 *  person's runs only (never over yours). */
export function homeChatRows(
  messages: readonly HomeChatMessage[],
  me: string | null,
  names: ReadonlyMap<string, string>,
  kind: "dm" | "channel"
): HomeChatRow[] {
  const runs = chatRuns(
    messages.map((m) => ({
      mine: !!me && m.authorId === me,
      from: m.authorId,
      at: m.createdAtMs || null,
      deleted: m.deleted || m.call !== null,
    }))
  );
  return messages.map((m, i) => {
    if (m.call) return { kind: "call", m };
    const mine = !!me && m.authorId === me;
    const run = runs[i];
    // A channel names every run; a DM only the other person's. Yours never
    // carry a name in either (the Thread's rule).
    const name = mine || !run.first ? null : authorName(m.authorId, me, names);
    return { kind: "message", m, mine, name: kind === "channel" || !mine ? name : null, run };
  });
}

/** Who is typing, as the line names them (never you). */
export function typingNames(members: readonly string[], me: string | null, names: ReadonlyMap<string, string>): string[] {
  return members.filter((m) => m !== me).map((m) => authorName(m, me, names));
}
