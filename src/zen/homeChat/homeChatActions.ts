// What the Home chat view does over the wire, on the store
// (homeChatStore.ts). Every call goes to the chat's own server (`scope`),
// through `src/api/homeChat.ts`, which never throws: a refusal comes back
// as the words to show.
//
// Rules from K2's brief (§2.6, §5 item 10), kept here so the view stays
// layout:
//   - read: the newest page (50); a reopened chat reads only what came
//     after the newest it holds (up to 100; more than that → the newest
//     page again, the desktop's phone-style delta);
//   - send: always with a nonce; a retry of the same words reuses it, so
//     Sew never posts twice; the optimistic bubble shows at once and the
//     server's copy (same nonce) replaces it;
//   - send refusals (0.46.13): `conversation_gone` → reopen the DM for the
//     same person and send once more (a new conversation id moves the
//     sends, the open view, the draft and the mappings); `send_in_progress`
//     → wait 1 s, then 2 s, same nonce; `channel_archived` → Not sent with
//     no Retry, and the channel reads as archived (read-only);
//   - typing: at most one `typing` per conversation every 8 s;
//   - reactions: the chip toggles at once; a refusal puts it back;
//   - frames: merged by id; a member's message clears their typing name.

import type { ServerScope } from "../../api/scope";
import {
  fetchHomeChatMembers,
  fetchHomeChatMessages,
  fetchHomeChatPeople,
  fetchHomeChatReactors,
  openHomeChatDm,
  reactHomeChat,
  sendHomeChatMessage,
  typingHomeChat,
  HOME_CHAT_PAGE_DEFAULT,
  HOME_CHAT_PAGE_MAX,
} from "../../api/homeChat";
import type { HomeChatFrame } from "../../api/homeChatEvents";
import type { HomeChatMessage, HomeChatRefusal } from "../../api/homeChatPure";
import {
  applyReactionFrame,
  isOptimistic,
  markDeleted,
  nonceForSend,
  optimisticMessage,
  toggleReaction,
  typingForget,
  typingTick,
  type PendingSend,
  type TypingSent,
} from "../../api/homeChatHelpers";
import { authorName, convKey, homeChatDraftKey, memberNames, type HomeChatTarget } from "./homeChatModel";
import { EMPTY_CONV, noteHomeChatMoved, useHomeChatStore, type SendState } from "./homeChatStore";
import { useComposerDrafts } from "../composerDrafts";

/** A page; the reopen delta reads this many after the newest held. */
export const HOME_CHAT_PAGE = HOME_CHAT_PAGE_DEFAULT;
export const HOME_CHAT_DELTA = HOME_CHAT_PAGE_MAX;
/** The people list is read again after this long. */
export const PEOPLE_FRESH_MS = 60_000;

/** A refusal as one short line. */
export function refusalText(r: HomeChatRefusal): string {
  const hint = r.hint.trim();
  if (r.kind === "network" || r.kind === "not_connected") return "Can't reach the server";
  if (r.kind === "off") return "Chat is off on this server";
  if (r.code === "channel_archived") return CHANNEL_ARCHIVED_TEXT;
  if (r.code === "conversation_gone") return "This chat is gone";
  if (r.code === "send_in_progress") return "Still sending on the server";
  return hint || r.code;
}

/** A send to an archived channel: the whole line (no Retry). */
export const CHANNEL_ARCHIVED_TEXT = "This channel is archived.";
/** A DM Sew lost that couldn't be opened again. */
export const DM_GONE_TEXT = "This chat is gone and couldn't be opened again";
/** `send_in_progress`: wait this long before each send again (same nonce). */
export const SEND_IN_PROGRESS_BACKOFF_MS: readonly number[] = [1_000, 2_000];

let sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

const st = () => useHomeChatStore.getState();

// ─── People ───

const peopleInflight = new Map<string, Promise<void>>();

/** The server's people (names, your member id); fresh for PEOPLE_FRESH_MS
 *  unless `force`. Single-flight per server. */
export function ensureHomeChatPeople(scope: ServerScope, force = false): Promise<void> {
  const have = st().people[scope.id];
  if (!force && have && Date.now() - have.at < PEOPLE_FRESH_MS) return Promise.resolve();
  const running = peopleInflight.get(scope.id);
  if (running) return running;
  const p = (async () => {
    const r = await fetchHomeChatPeople(scope);
    if (r.ok) st().setPeople(scope.id, { me: r.me, people: r.people });
  })().finally(() => peopleInflight.delete(scope.id));
  peopleInflight.set(scope.id, p);
  return p;
}

/** The names (member id → name) and your member id on a server. */
export function namesOn(serverId: string): { me: string | null; names: Map<string, string> } {
  const p = st().people[serverId]?.people ?? null;
  return { me: p?.me.memberId ?? null, names: memberNames(p) };
}

// ─── A channel's facts ───

/** Read a channel's facts (name, open, creator, people) into the store.
 *  The refusal's words, or null. */
export async function loadHomeChatChannel(scope: ServerScope, conv: string): Promise<string | null> {
  const r = await fetchHomeChatMembers(scope, { conv });
  if (!r.ok) return refusalText(r);
  st().setChannel(convKey(scope.id, conv), r.members);
  return null;
}

// ─── The conversation ───

/** The target's conversation id: a channel's own, a DM's known one, or
 *  the DM opened (made) now by `ext`. */
export async function resolveHomeChatConv(
  scope: ServerScope,
  target: HomeChatTarget
): Promise<{ conv: string } | { error: string }> {
  if (target.conversationId) return { conv: target.conversationId };
  const ext = (target.ext ?? "").trim();
  if (target.kind !== "dm" || !ext) return { error: "This chat has no conversation yet." };
  const known = st().dms[`${scope.id}|${ext}`];
  if (known) return { conv: known };
  const r = await openHomeChatDm(scope, ext);
  if (!r.ok) return { error: refusalText(r) };
  st().noteDm(scope.id, ext, r.conv);
  return { conv: r.conv };
}

function realOnly(list: readonly HomeChatMessage[]): HomeChatMessage[] {
  return list.filter((m) => !isOptimistic(m));
}

/** Read the newest: a delta after what is held, or the newest page. Keeps
 *  what it held on a failure (the error is the view's note). */
export async function loadHomeChatNewest(scope: ServerScope, conv: string): Promise<void> {
  const key = convKey(scope.id, conv);
  const held = realOnly(st().convs[key]?.messages ?? []);
  const newest = held.length ? held[held.length - 1].id : null;
  if (newest) {
    const delta = await fetchHomeChatMessages(scope, conv, { after: newest, limit: HOME_CHAT_DELTA });
    if (!delta.ok) {
      st().patchConv(key, { error: refusalText(delta) });
      return;
    }
    if (delta.messages.length < HOME_CHAT_DELTA) {
      st().mergeMessages(key, delta.messages);
      st().patchConv(key, { loaded: true, error: null });
      return;
    }
    // Too much came after: start from the newest page again (keep sends).
  }
  const page = await fetchHomeChatMessages(scope, conv, { limit: HOME_CHAT_PAGE });
  if (!page.ok) {
    st().patchConv(key, { error: refusalText(page) });
    return;
  }
  const cur = st().convs[key] ?? EMPTY_CONV;
  const keep = newest ? cur.messages.filter(isOptimistic) : cur.messages;
  st().patchConv(key, { messages: [], hasMore: page.hasMore, loaded: true, error: null });
  st().mergeMessages(key, [...keep, ...page.messages]);
}

/** One page older than the oldest held. The merged list, or null when it
 *  failed (the error is in the store) or there is nothing older. */
export async function loadHomeChatOlder(scope: ServerScope, conv: string): Promise<HomeChatMessage[] | null> {
  const key = convKey(scope.id, conv);
  const cur = st().convs[key] ?? EMPTY_CONV;
  const held = realOnly(cur.messages);
  if (!cur.hasMore || held.length === 0) return null;
  st().patchConv(key, { loadingOlder: true });
  const page = await fetchHomeChatMessages(scope, conv, { before: held[0].id, limit: HOME_CHAT_PAGE });
  if (!page.ok) {
    st().patchConv(key, { loadingOlder: false, error: refusalText(page) });
    return null;
  }
  st().mergeMessages(key, page.messages);
  st().patchConv(key, { loadingOlder: false, hasMore: page.hasMore, error: null });
  return st().convs[key]?.messages ?? null;
}

// ─── Send ───

/** Send `text` (a reply when `replyTo`): the optimistic bubble at once,
 *  the nonce kept until the server confirms. A failed send stays as a
 *  "Not sent · Retry" bubble with its nonce. */
export async function sendHomeChat(
  scope: ServerScope,
  conv: string,
  send: { text: string; replyTo?: string | null }
): Promise<boolean> {
  const text = send.text.trim();
  if (!text) return false;
  const key = convKey(scope.id, conv);
  // A failed copy of the same words (and reply) goes again with its nonce.
  const kept = Object.values(st().sends[key] ?? {}).find(
    (s) => s.status === "failed" && s.pending.text === text && s.pending.replyTo === (send.replyTo ?? null)
  );
  const pending = nonceForSend(kept?.pending ?? null, { conv, text, replyTo: send.replyTo ?? null });
  typingSent = typingForget(typingSent, conv);
  return deliver(scope, key, pending);
}

/** Send a "Not sent" bubble again (its nonce: never posted twice). */
export function retryHomeChatSend(scope: ServerScope, conv: string, nonce: string): Promise<boolean> {
  const key = convKey(scope.id, conv);
  const s = st().sends[key]?.[nonce];
  if (!s || s.status === "sending" || s.final) return Promise.resolve(false);
  return deliver(scope, key, s.pending);
}

/** A failed send's state wherever it is now on `serverId` (its DM may
 *  have moved to a new conversation id): by nonce, or else the newest
 *  failed send of these words. */
export function findHomeChatSend(serverId: string, by: { nonce?: string; text?: string }): SendState | null {
  const prefix = `${serverId}|`;
  let hit: SendState | null = null;
  for (const [k, sends] of Object.entries(st().sends)) {
    if (!k.startsWith(prefix)) continue;
    for (const [nonce, s] of Object.entries(sends)) {
      if (by.nonce ? nonce === by.nonce : s.status === "failed" && s.pending.text === by.text) hit = s;
    }
  }
  return hit;
}

/** A DM's other person (to open it again), when this phone knows it. */
function dmExtOf(serverId: string, conv: string): string | null {
  const s = st();
  const o = s.open;
  if (o && o.serverId === serverId && o.kind === "dm" && o.ext && o.conversationId === conv) return o.ext;
  const prefix = `${serverId}|`;
  for (const [k, v] of Object.entries(s.dms)) if (v === conv && k.startsWith(prefix)) return k.slice(prefix.length);
  return null;
}

/** A DM Sew lost came back under `to`: move its sends, the open view, the
 *  draft and the mappings (Home rows hear it) from `from`. */
export function moveHomeChatConv(serverId: string, from: string, to: string, ext: string | null): void {
  if (from === to) return;
  st().moveConv(serverId, from, to, ext);
  const drafts = useComposerDrafts.getState();
  const a = homeChatDraftKey(serverId, from);
  const b = homeChatDraftKey(serverId, to);
  const text = a ? (drafts.drafts[a]?.text ?? "") : "";
  if (text.trim() && b && !(drafts.drafts[b]?.text ?? "").trim()) drafts.setDraft(b, text);
  if (a && text) drafts.setDraft(a, "");
  noteHomeChatMoved({ serverId, ext, from, to });
}

/** One send, sent again with the SAME nonce while the server says the
 *  first is still in flight (`send_in_progress`; idempotent per nonce). */
async function postSend(scope: ServerScope, pending: PendingSend, stillWanted: () => boolean) {
  const once = () =>
    sendHomeChatMessage(scope, { conv: pending.conv, text: pending.text, nonce: pending.nonce, replyTo: pending.replyTo });
  let r = await once();
  for (const ms of SEND_IN_PROGRESS_BACKOFF_MS) {
    if (r.ok || r.code !== "send_in_progress" || !stillWanted()) break;
    await sleep(r.retryAfterMs ?? ms);
    if (!stillWanted()) break;
    r = await once();
  }
  return r;
}

/** Take a "Not sent" bubble back (its words go into the box). */
export function dropHomeChatSend(serverId: string, conv: string, nonce: string): PendingSend | null {
  const key = convKey(serverId, conv);
  const s = st().sends[key]?.[nonce] ?? null;
  st().setSend(key, nonce, null);
  st().mapMessages(key, (list) => list.filter((m) => m.id !== `~${nonce}`));
  return s?.pending ?? null;
}

async function deliver(scope: ServerScope, key: string, pending: PendingSend): Promise<boolean> {
  const me = namesOn(scope.id).me ?? "";
  st().setSend(key, pending.nonce, { pending, status: "sending", error: null });
  const held = st().convs[key]?.messages.find((m) => m.id === `~${pending.nonce}`);
  if (!held) st().mergeMessages(key, [optimisticMessage(pending, me, Date.now())]);
  // Dropped (Edit) while it waited: stop sending it.
  const wanted = () => !!st().sends[key]?.[pending.nonce];
  let r = await postSend(scope, pending, wanted);

  if (!r.ok && r.code === "conversation_gone") {
    // The DM is gone on Sew's side: open it again for the same person and
    // send once more. A new conversation id carries everything over.
    const ext = dmExtOf(scope.id, pending.conv);
    const again = ext ? await openHomeChatDm(scope, ext) : null;
    if (!again?.ok) {
      st().setSend(key, pending.nonce, { pending, status: "failed", error: DM_GONE_TEXT });
      return false;
    }
    if (again.conv !== pending.conv) {
      moveHomeChatConv(scope.id, pending.conv, again.conv, ext);
      // The reply's original was in the old conversation.
      pending = { ...pending, conv: again.conv, replyTo: null };
      key = convKey(scope.id, again.conv);
    } else if (ext) {
      st().noteDm(scope.id, ext, again.conv);
    }
    if (!wanted()) return false;
    r = await postSend(scope, pending, wanted);
    if (!r.ok && r.code === "conversation_gone") {
      st().setSend(key, pending.nonce, { pending, status: "failed", error: DM_GONE_TEXT });
      return false;
    }
  }

  if (!r.ok) {
    if (!wanted()) return false;
    if (r.code === "channel_archived") {
      st().setSend(key, pending.nonce, { pending, status: "failed", error: CHANNEL_ARCHIVED_TEXT, final: true });
      noteArchived(scope, pending.conv);
      return false;
    }
    st().setSend(key, pending.nonce, { pending, status: "failed", error: refusalText(r) });
    return false;
  }
  st().setSend(key, pending.nonce, null);
  // The server's copy replaces the optimistic one (same nonce; a retry
  // answers the first message). Without a parsable copy the optimistic one
  // stands in until the frame comes.
  if (r.message) st().mergeMessages(key, [{ ...r.message, nonce: r.message.nonce ?? pending.nonce }]);
  return true;
}

/** A send found the channel archived: the view goes read-only until the
 *  channel is read again. */
function noteArchived(scope: ServerScope, conv: string): void {
  const key = convKey(scope.id, conv);
  const c = st().channels[key];
  if (c) st().setChannel(key, { ...c, state: "archived" });
  else void loadHomeChatChannel(scope, conv);
}

// ─── Typing ───

let typingSent: TypingSent = {};

/** The box changed: say `typing` (at most once per 8 s per conversation;
 *  never for a blank box). */
export function noteHomeChatDraft(scope: ServerScope, conv: string, draft: string, now = Date.now()): boolean {
  const t = typingTick(typingSent, conv, draft, now);
  typingSent = t.sent;
  if (t.send) void typingHomeChat(scope, conv);
  return t.send;
}

// ─── Reactions ───

/** Tap a chip (or pick from the menu): toggle yours at once, then ask the
 *  server; a refusal puts it back. The error line, or null. */
export async function toggleHomeChatReaction(
  scope: ServerScope,
  conv: string,
  msg: string,
  emoji: string
): Promise<string | null> {
  const key = convKey(scope.id, conv);
  const list = st().convs[key]?.messages ?? [];
  const t = toggleReaction(list, msg, emoji);
  st().patchConv(key, { messages: t.messages });
  const r = await reactHomeChat(scope, { conv, msg, emoji, on: t.on });
  if (r.ok) {
    if (r.message) st().mergeMessages(key, [r.message]);
    return null;
  }
  // The server's truth back: undo the optimistic toggle.
  st().mapMessages(key, (cur) => toggleReaction(cur, msg, emoji).messages);
  return refusalText(r);
}

/** Who reacted with `emoji` (names, "You" for you); null when it failed. */
export async function homeChatReactorNames(scope: ServerScope, msg: string, emoji: string): Promise<string[] | null> {
  const r = await fetchHomeChatReactors(scope, msg, emoji);
  if (!r.ok) return null;
  const { me, names } = namesOn(scope.id);
  return r.memberIds.map((id) => authorName(id, me, names));
}

// ─── Live frames ───

/** One events-socket frame into the store: messages and their updates
 *  (merged by id), deletes, reactions, typing. Conversations this phone
 *  never opened are left alone (rows read the summary). */
export function applyHomeChatFrame(serverId: string, f: HomeChatFrame, now = Date.now()): void {
  switch (f.type) {
    case "message":
    case "message_updated": {
      const key = convKey(serverId, f.conv);
      // Their message ends their typing at once (no stop event).
      if (f.type === "message") st().clearTyping(key, f.message.authorId);
      if (st().convs[key]) st().mergeMessages(key, [f.message]);
      break;
    }
    case "deleted":
      st().mapMessages(convKey(serverId, f.conv), (list) => markDeleted(list, f.id));
      break;
    case "reaction":
      st().mapMessages(convKey(serverId, f.conv), (list) => applyReactionFrame(list, f));
      break;
    case "typing":
      st().noteTyping(convKey(serverId, f.conv), f.member, now);
      break;
    default:
      break;
  }
}

/** Tests only. */
export function __resetHomeChatActionsForTests(): void {
  typingSent = {};
  peopleInflight.clear();
  sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
}

/** Tests only: the `send_in_progress` wait. */
export function __setHomeChatSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}
