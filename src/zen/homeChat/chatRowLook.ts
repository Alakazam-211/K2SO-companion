// What one person or channel row on Home shows (brief §2.5; desktop
// `HomeChatRow.tsx`), from its server's Home chat state. Pure: the Home
// list calls it per row with the store's state.

import type { HomeChatPerson } from "../../api/homeChatPure";
import type { HomeRowView } from "../homeView";
import { mountainListWhen } from "../threadModel";
import type { RowUnread } from "../unread";
import {
  badgeUnread,
  channelInviteOnly,
  chatRowLine,
  chatRowQuiet,
  matchesElsewhere,
  summaryRowFor,
} from "./homeChatRows";
import type { HomeChatServerState } from "./homeChatStore";

export type ChatHomeView = Extract<HomeRowView, { kind: "chat" }>;

export interface ChatRowLook {
  serverId: string | null;
  name: string;
  /** The person on their server's list (null for a channel or not read). */
  person: HomeChatPerson | null;
  /** Their username (colour), the row's label when not read. */
  username: string;
  inviteOnly: boolean | null;
  unread: RowUnread | null;
  when: string;
  line: string;
  /** Greyed (its last badge kept). */
  quiet: boolean;
  /** The server has no usable chat: a tap opens nothing. */
  noChat: boolean;
  /** People and channels are offered there (Call shows). */
  offered: boolean;
  chip: string | null;
  /** Possible matches on other servers ("Also on"). */
  also: Array<{ serverId: string; person: HomeChatPerson }>;
}

export function chatRowLook(
  v: ChatHomeView,
  ctx: {
    byServer: Readonly<Record<string, HomeChatServerState | undefined>>;
    tokens: Readonly<Record<string, string>>;
    rowNotes: Readonly<Record<string, string>>;
    /** The active server's chip on its own rows (several servers). */
    hereChip: string | null;
  }
): ChatRowLook {
  const sid = v.server?.id ?? null;
  const st = sid ? ctx.byServer[sid] : undefined;
  const person =
    v.chat === "person" ? (st?.people?.people.find((p) => p.ext.toLowerCase() === v.handle) ?? null) : null;
  const name = person?.displayName || v.row.label || v.handle;
  const quiet = chatRowQuiet({
    saved: !!v.server,
    signedIn: !!(sid && (ctx.tokens[sid] ?? "").length > 0),
    serverLabel: v.serverLabel,
    look: st,
  });
  const sum = summaryRowFor(st?.summary, st?.dms, v.chat, v.handle);
  const unread = sum ? badgeUnread(sum.badge) : null;
  const inviteOnly = v.chat === "channel" ? channelInviteOnly(sum?.inviteOnly, st?.channels, v.handle) : null;
  const others: Record<string, HomeChatPerson[] | undefined> = {};
  if (person && sid) for (const [id, s] of Object.entries(ctx.byServer)) if (id !== sid) others[id] = s?.people?.people;
  const also = person && sid ? matchesElsewhere(person, sid, others) : [];
  const chip = !v.here ? v.serverLabel : (ctx.hereChip ?? (also.length ? v.serverLabel : null));
  const note = ctx.rowNotes[v.row.address];
  return {
    serverId: sid,
    name,
    person,
    username: person?.username || v.row.label || v.handle,
    inviteOnly,
    unread,
    when: sum?.lastAtMs ? mountainListWhen(sum.lastAtMs) : "",
    line: note ?? quiet?.line ?? chatRowLine(v.chat, inviteOnly, unread),
    quiet: !!quiet,
    noChat: !!quiet?.noChat,
    offered: !!st?.gate?.offered,
    chip,
    also,
  };
}
