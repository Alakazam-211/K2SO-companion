// People and channels on Home (K2 0.46.13, `home-chat-v1`; brief
// companion-home-people-groups-brief-v1 §2.1–2.5, §5 items 6–9): the pure
// rules behind a person or channel row, the Add to Home pickers and the
// "Same person?" question. Ported from desktop
// `components/HomeChat/HomeChatRow.tsx`, `HomeChatGlyphs.tsx`,
// `lib/home-chat/people.ts`.
// No I/O and no React.

import {
  homeChatRowNoChatLine,
  type HomeChatBadge,
  type HomeChatChannel,
  type HomeChatPerson,
  type HomeChatSummary,
} from "../../api/homeChatPure";
import type { HomeChatGate } from "../../api/homeChat";
import { homeAddress, parseHomeAddress, type HomeRow } from "../homes";
import type { RowUnread } from "../unread";

// Person colours and initials are the chat view's (`./homeChatModel`:
// `personColor`, `personInk`, `personInitials`), shared with the rows.

// ─── Who is a person, and "Same person?" (§2.4, §5 item 8) ───

const PERSON_EXT_RE = /^(k2:owner|k2:connect:[a-z0-9-]{1,64})$/;

/** A person the pickers may list (never an agent, App user or anything
 *  else: the daemon lists none of them, this is the client's belt). */
export function isPersonExt(ext: string): boolean {
  return PERSON_EXT_RE.test(ext.trim().toLowerCase());
}

/** A person Add to Home may pick: their chat is set up (`ready`). (The
 *  chat view's `pickablePerson` is the members sheet's rule.) */
export function canAddPerson(p: HomeChatPerson): boolean {
  return p.ready && isPersonExt(p.ext);
}

type Who = Pick<HomeChatPerson, "ext" | "username" | "displayName">;

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Might `a` and `b` (on two servers) be one person? The same username
 *  (never for `k2:owner`, whose username is always `owner`), or the same
 *  real full name (a name that is just the username doesn't count). */
export function mightBeSamePerson(a: Who, b: Who): boolean {
  const ownerA = a.ext === "k2:owner";
  const ownerB = b.ext === "k2:owner";
  if (!ownerA && !ownerB && norm(a.username) && norm(a.username) === norm(b.username)) return true;
  const na = norm(a.displayName);
  const nb = norm(b.displayName);
  const realA = !!na && na !== norm(a.username);
  const realB = !!nb && nb !== norm(b.username);
  return realA && realB && na === nb;
}

/** Every server other than `serverId` whose list has a possible match. */
export function matchesElsewhere<P extends Who>(
  person: Who,
  serverId: string,
  peopleByServer: Readonly<Record<string, readonly P[] | undefined>>
): Array<{ serverId: string; person: P }> {
  const out: Array<{ serverId: string; person: P }> = [];
  for (const [sid, list] of Object.entries(peopleByServer)) {
    if (sid === serverId || !list) continue;
    for (const p of list) if (mightBeSamePerson(person, p)) out.push({ serverId: sid, person: p });
  }
  return out;
}

/** The question's words (desktop `askSamePerson`'s title; the body as K2
 *  Design reworded it for 4.3.0). */
export function samePersonCopy(name: string, theirName: string, theirServer: string): { title: string; body: string } {
  return {
    title: `Is ${name} the same person as ${theirName} on ${theirServer}?`,
    body: "Same person: one row, and its menu switches between servers. Different person: two rows.",
  };
}

/** A person's line under their name in a picker: their handle and role,
 *  the word once when both are the same ("owner", not "owner · owner"). */
export function personDetail(username: string, role: string | null | undefined): string {
  const r = role ? (role === "voice_chat" ? "voice & chat" : role) : "";
  const u = username.trim();
  if (!r) return u;
  if (!u || u.toLowerCase() === r.toLowerCase()) return r;
  return `${u} · ${r}`;
}

// ─── Rows ───

export type ChatRowKind = "person" | "channel";

/** A person or channel row's parts: `handle` is the person's ext or the
 *  channel's Sew id; `host` the row's server (box id or host key). */
export function chatRowParts(row: Pick<HomeRow, "kind" | "address">): { kind: ChatRowKind; handle: string; host: string } | null {
  if (row.kind !== "person" && row.kind !== "channel") return null;
  const p = parseHomeAddress(row.address);
  return p ? { kind: row.kind, handle: p.handle, host: p.host } : null;
}

/** The row a picked person adds (`<ext>::<host>`). Null for an ext that
 *  isn't a person's. */
export function personRow(person: Pick<HomeChatPerson, "ext" | "displayName">, host: string): HomeRow | null {
  if (!isPersonExt(person.ext) || !host.trim()) return null;
  return { kind: "person", address: homeAddress(person.ext, host), workspaceId: null, label: person.displayName };
}

/** The row a picked (or new) channel adds (`<conv>::<host>`). */
export function channelRow(conv: string, name: string, host: string): HomeRow | null {
  if (!/^[0-9]{1,20}$/.test(conv) || !host.trim()) return null;
  return { kind: "channel", address: homeAddress(conv, host), workspaceId: null, label: name };
}

/** A row's summary entry: a channel by its id; a person by the DM this
 *  phone opened (`dms`), else the summary's `with` (their ext). */
export function summaryRowFor(
  summary: HomeChatSummary | null | undefined,
  dms: Readonly<Record<string, string>> | undefined,
  kind: ChatRowKind,
  handle: string
): HomeChatSummary["convs"][number] | null {
  if (!summary) return null;
  if (kind === "channel") return summary.convs.find((c) => c.conv === handle) ?? null;
  const conv = dms?.[handle];
  if (conv) {
    const hit = summary.convs.find((c) => c.conv === conv);
    if (hit) return hit;
  }
  return summary.convs.find((c) => c.kind === "dm" && (c.with ?? "").toLowerCase() === handle) ?? null;
}

/** A summary badge as the row's unread marks: a dot (no number) or a
 *  count; "99+" at the server's cap of 99. */
export function badgeUnread(b: HomeChatBadge): RowUnread | null {
  if (b.kind === "none") return null;
  if (b.kind === "dot") return { tone: "unread", count: 1, emphasis: true, muted: false };
  return { tone: "unread", count: b.n >= 99 ? 100 : b.n, emphasis: true, muted: false };
}

/** Is the channel invite-only? The summary says, else the channel list;
 *  null while not known (draws `#`). */
export function channelInviteOnly(
  summaryInviteOnly: boolean | null | undefined,
  channels: readonly HomeChatChannel[] | null | undefined,
  conv: string
): boolean | null {
  if (typeof summaryInviteOnly === "boolean") return summaryInviteOnly;
  const c = channels?.find((x) => x.conv === conv);
  return c ? c.inviteOnly : null;
}

/** What one server's Home chat looks like to a row. */
export interface ChatServerLook {
  gate: HomeChatGate | null;
  summary: HomeChatSummary | null;
  summaryError: string | null;
}

/** Why a row is greyed, or null when it isn't. Order: no saved server,
 *  signed out, the gate closed (feature missing, chat off, a Mac server,
 *  still being set up), the server can't be reached, chat unavailable. A
 *  gate not read yet is not a reason (the row shows as normal). */
export function chatRowQuiet(opts: {
  saved: boolean;
  signedIn: boolean;
  serverLabel: string;
  look: ChatServerLook | null | undefined;
}): { line: string; noChat: boolean } | null {
  if (!opts.saved) return { line: `${opts.serverLabel} is not saved on this phone`, noChat: false };
  if (!opts.signedIn) return { line: `Sign in to ${opts.serverLabel}`, noChat: false };
  const gate = opts.look?.gate ?? null;
  if (gate && gate.checkedAt !== null && !gate.offered) {
    // The feature is listed but the status read failed (a blip, not an
    // answer): the server can't be reached right now.
    if (gate.feature && gate.on === null && gate.refusal) {
      return { line: `${opts.serverLabel} can’t be reached`, noChat: false };
    }
    // The short form: the row has no room for the reason (K2 Design).
    return { line: homeChatRowNoChatLine(gate.reason), noChat: true };
  }
  if (opts.look?.summaryError) return { line: `${opts.serverLabel} can’t be reached`, noChat: false };
  if (opts.look?.summary?.chat === "unavailable") return { line: "Chat isn’t available right now", noChat: false };
  return null;
}

/** Line two of a healthy row. */
export function chatRowLine(kind: ChatRowKind, inviteOnly: boolean | null, unread: RowUnread | null): string {
  if (unread) return unread.count > 1 ? "New messages" : "New message";
  if (kind === "person") return "Direct message";
  return inviteOnly ? "Invite-only channel" : "Channel";
}
