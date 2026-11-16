// People and channels on Home (K2 0.46.13, `home-chat-v1`): one function per
// `/cli/home-chat/*` route (brief §2.6), the DM call routes (§3), and the
// gate (§2.2). Every call goes to the server that holds the chat, on ITS
// scope, with this person's own login there; nothing here reads the active
// server. The phone never talks to Sew: only to these routes.
//
// Every function answers `{ok: true, …}` or a `HomeChatRefusal` (kind +
// code + hint, `retryAfterMs` when the server said) and never throws.
//
// Wire notes from the daemon (`home_chat/routes.rs`):
//   - POST bodies are `deny_unknown_fields`: send exactly the listed keys.
//   - Every POST answers 405 to a GET.
//   - Ids are Sew's decimal strings; a bad one is refused here, unsent.
//
// The gate: `/boot-status` `features` has `home-chat-v1` AND
// `GET /cli/home-chat/status` says `on: true`. Never assumed, not even for
// the connected server (desktop `useHomeChatOffered`).

import { NOT_CONNECTED, scopedFetch } from "./scopedFetch";
import { ensureBootStatus, type ServerScope } from "./scope";
import type { HttpPriority } from "./httpCap";
import { onServerForget } from "../stores/servers";
import {
  HOME_CHAT_FEATURE,
  NO_HOME_CHAT_FLAGS,
  clientRefusal,
  homeChatNoChatLine,
  isSewId,
  obj,
  parseHomeChatAddResults,
  parseHomeChatChannels,
  parseHomeChatCreated,
  parseHomeChatDelta,
  parseHomeChatMembers,
  parseHomeChatMessage,
  parseHomeChatPage,
  parseHomeChatPeople,
  parseHomeChatReactors,
  parseHomeChatRefusal,
  parseHomeChatStatus,
  parseHomeChatSummary,
  refusalClosesGate,
  strOrNull,
  type HomeChatAddOutcome,
  type HomeChatChannelsPage,
  type HomeChatCreated,
  type HomeChatDelta,
  type HomeChatFlags,
  type HomeChatMembers,
  type HomeChatMessage,
  type HomeChatPage,
  type HomeChatPeople,
  type HomeChatRefusal,
  type HomeChatResult,
  type HomeChatStatus,
  type HomeChatSummary,
} from "./homeChatPure";
import {
  dmJoinBody,
  parseDmCancelAnswer,
  parseDmJoinAnswer,
  parseDmLeaveAnswer,
  type DmCancelAnswer,
  type DmJoinAnswer,
  type DmJoinOptions,
  type DmLeaveAnswer,
  type K2CallId,
  type SewCallId,
} from "./homeChatCallsPure";
import { isValidNonce } from "./homeChatHelpers";

// ─── The one request path ───

type Q = Record<string, string>;

interface CallOpts {
  method?: "GET" | "POST";
  query?: Q;
  body?: Record<string, unknown>;
  priority?: HttpPriority;
  timeoutMs?: number;
}

/** One request on `scope`; the parsed JSON body or a refusal. A refusal
 *  that says chat is off or unusable closes the gate too. */
async function call(scope: ServerScope, path: string, opts: CallOpts = {}): Promise<{ ok: true; body: unknown } | HomeChatRefusal> {
  let out;
  try {
    out = await scopedFetch(scope, path, {
      method: opts.method ?? "GET",
      query: opts.query,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      priority: opts.priority ?? "background",
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === NOT_CONNECTED) return clientRefusal("not_connected", msg);
    if (err instanceof Error && err.name === "ServerRemovedError") return clientRefusal("removed", msg);
    return clientRefusal("network", msg);
  }
  if (!out || typeof out.status !== "number") return clientRefusal("bad_response", "no answer");
  if (!out.ok) {
    const r = parseHomeChatRefusal(out.status, out.text);
    if (refusalClosesGate(r)) noteGateClosed(scope, r);
    return r;
  }
  try {
    return { ok: true, body: JSON.parse(out.text) as unknown };
  } catch {
    return clientRefusal("bad_response", "the server's answer isn't JSON", out.status);
  }
}

function badId(what: string): HomeChatRefusal {
  return clientRefusal("usage", `${what} is a Sew id (digits)`);
}

function ok<T extends object>(v: T): { ok: true } & T {
  return { ok: true, ...v };
}

// ─── Reads ───

/** `GET /cli/home-chat/status` → `{on, reason, flags, chat}`. Read through
 *  the gate (`refreshHomeChatGate`) unless you need it raw. A 404
 *  `home_chat_off` reads as `{on: false, reason: "off"}`. */
export async function fetchHomeChatStatus(scope: ServerScope): Promise<HomeChatResult<{ status: HomeChatStatus }>> {
  const r = await call(scope, "/cli/home-chat/status");
  if (!r.ok) {
    if (r.kind === "off") return ok({ status: { on: false, reason: "off", flags: { ...NO_HOME_CHAT_FLAGS }, chat: null } });
    return r;
  }
  const status = parseHomeChatStatus(r.body);
  return status ? ok({ status }) : clientRefusal("bad_response", "the status answer has no `on`");
}

/** `GET /cli/home-chat/people`: who you may DM here, and your own ext and
 *  member id (`me.memberId` tells your messages from others'). */
export async function fetchHomeChatPeople(scope: ServerScope): Promise<HomeChatResult<HomeChatPeople>> {
  const r = await call(scope, "/cli/home-chat/people");
  return r.ok ? ok(parseHomeChatPeople(r.body)) : r;
}

/** `GET /cli/home-chat/channels?q&after`: the K5 text channels you can see
 *  (Sew browse; voice rooms left out). */
export async function fetchHomeChatChannels(
  scope: ServerScope,
  opts: { q?: string; after?: string } = {}
): Promise<HomeChatResult<HomeChatChannelsPage>> {
  const query: Q = {};
  if (opts.q?.trim()) query.q = opts.q.trim();
  if (opts.after) {
    if (!isSewId(opts.after)) return badId("after");
    query.after = opts.after;
  }
  const r = await call(scope, "/cli/home-chat/channels", { query });
  return r.ok ? ok(parseHomeChatChannels(r.body)) : r;
}

/** `GET /cli/home-chat/summary?convs=a,b` (all when empty): unread and
 *  badges per conversation, and the link state. */
export async function fetchHomeChatSummary(
  scope: ServerScope,
  convs: readonly string[] = []
): Promise<HomeChatResult<HomeChatSummary>> {
  const list = convs.filter(isSewId);
  const r = await call(scope, "/cli/home-chat/summary", { query: list.length ? { convs: list.join(",") } : undefined });
  return r.ok ? ok(parseHomeChatSummary(r.body)) : r;
}

/** Messages per page: 1–100, default 50. */
export const HOME_CHAT_PAGE_DEFAULT = 50;
export const HOME_CHAT_PAGE_MAX = 100;

function limitOf(n: number | undefined): string {
  const v = Math.floor(n ?? HOME_CHAT_PAGE_DEFAULT);
  return String(Math.min(HOME_CHAT_PAGE_MAX, Math.max(1, Number.isFinite(v) ? v : HOME_CHAT_PAGE_DEFAULT)));
}

/** `GET /cli/home-chat/messages?conv&before&after&limit`: one page, oldest
 *  first (no `before`/`after`: the newest page). */
export async function fetchHomeChatMessages(
  scope: ServerScope,
  conv: string,
  opts: { before?: string; after?: string; limit?: number } = {}
): Promise<HomeChatResult<HomeChatPage>> {
  if (!isSewId(conv)) return badId("conv");
  const query: Q = { conv, limit: limitOf(opts.limit) };
  if (opts.before) {
    if (!isSewId(opts.before)) return badId("before");
    query.before = opts.before;
  }
  if (opts.after) {
    if (!isSewId(opts.after)) return badId("after");
    query.after = opts.after;
  }
  const r = await call(scope, "/cli/home-chat/messages", { query, priority: "user" });
  return r.ok ? ok(parseHomeChatPage(r.body)) : r;
}

/** `GET /cli/home-chat/messages?conv&since=<seq>`: the changes since a
 *  channel seq, or `resync` with the newest page after Sew's 410. */
export async function fetchHomeChatChangesSince(
  scope: ServerScope,
  conv: string,
  since: number,
  limit?: number
): Promise<HomeChatResult<{ delta: HomeChatDelta }>> {
  if (!isSewId(conv)) return badId("conv");
  if (!Number.isInteger(since) || since < 0) return clientRefusal("usage", "since is a channel seq");
  const query: Q = { conv, since: String(since) };
  if (limit !== undefined) query.limit = limitOf(limit);
  const r = await call(scope, "/cli/home-chat/messages", { query, priority: "user" });
  return r.ok ? ok({ delta: parseHomeChatDelta(r.body) }) : r;
}

/** `GET /cli/home-chat/reactors?msg&emoji=u:<emoji>`: who reacted (member
 *  ids). */
export async function fetchHomeChatReactors(
  scope: ServerScope,
  msg: string,
  emoji: string
): Promise<HomeChatResult<{ memberIds: string[]; next: string | null }>> {
  if (!isSewId(msg)) return badId("msg");
  const r = await call(scope, "/cli/home-chat/reactors", { query: { msg, emoji: `u:${emoji}` }, priority: "user" });
  return r.ok ? ok(parseHomeChatReactors(r.body)) : r;
}

/** `GET /cli/home-chat/channels/members?conv` or `?slug` (a pending new
 *  channel, by K2's slug `c-…`). */
export async function fetchHomeChatMembers(
  scope: ServerScope,
  by: { conv: string } | { slug: string }
): Promise<HomeChatResult<{ members: HomeChatMembers }>> {
  let query: Q;
  if ("conv" in by) {
    if (!isSewId(by.conv)) return badId("conv");
    query = { conv: by.conv };
  } else {
    if (!/^c-[A-Za-z0-9_-]{1,64}$/.test(by.slug)) return clientRefusal("usage", "slug is a Home channel's slug (c-…)");
    query = { slug: by.slug };
  }
  const r = await call(scope, "/cli/home-chat/channels/members", { query, priority: "user" });
  if (!r.ok) return r;
  const members = parseHomeChatMembers(r.body);
  return members ? ok({ members }) : clientRefusal("bad_response", "the members answer names no channel");
}

// ─── DMs, posts, reactions, read state ───

/** `POST /cli/home-chat/dm {ext}`: open (or make) the DM with `ext`. */
export async function openHomeChatDm(
  scope: ServerScope,
  ext: string
): Promise<HomeChatResult<{ conv: string; created: boolean }>> {
  const target = ext.trim();
  if (!target) return clientRefusal("usage", "name the person: ext");
  const r = await call(scope, "/cli/home-chat/dm", { method: "POST", body: { ext: target }, priority: "user" });
  if (!r.ok) return r;
  const o = obj(r.body);
  const conv = typeof o?.conv === "string" || typeof o?.conv === "number" ? String(o.conv) : "";
  if (!isSewId(conv)) return clientRefusal("bad_response", "the server answered no conversation for that DM");
  return ok({ conv, created: o?.created === true });
}

/** `POST /cli/home-chat/send {conv, text, nonce, replyTo?}`. Always with a
 *  nonce (`nonceForSend`): a retry reuses it and never posts twice.
 *  `message` is null when the answer's message didn't parse (the send
 *  still landed). */
export async function sendHomeChatMessage(
  scope: ServerScope,
  send: { conv: string; text: string; nonce: string; replyTo?: string | null }
): Promise<HomeChatResult<{ message: HomeChatMessage | null }>> {
  if (!isSewId(send.conv)) return badId("conv");
  if (!send.text.trim()) return clientRefusal("usage", "text is empty");
  if (!isValidNonce(send.nonce)) return clientRefusal("usage", "nonce is 1-64 characters");
  const body: Record<string, unknown> = { conv: send.conv, text: send.text, nonce: send.nonce };
  if (send.replyTo) {
    if (!isSewId(send.replyTo)) return badId("replyTo");
    body.replyTo = send.replyTo;
  }
  const r = await call(scope, "/cli/home-chat/send", { method: "POST", body, priority: "user" });
  return r.ok ? ok({ message: parseHomeChatMessage(obj(r.body)?.message) }) : r;
}

/** `POST /cli/home-chat/react {conv, msg, emoji, on}` (one Unicode emoji). */
export async function reactHomeChat(
  scope: ServerScope,
  react: { conv: string; msg: string; emoji: string; on: boolean }
): Promise<HomeChatResult<{ message: HomeChatMessage | null }>> {
  if (!isSewId(react.conv)) return badId("conv");
  if (!isSewId(react.msg)) return badId("msg");
  const emoji = react.emoji.trim();
  if (!emoji || [...emoji].length > 16) return clientRefusal("usage", "emoji is one Unicode emoji");
  const r = await call(scope, "/cli/home-chat/react", {
    method: "POST",
    body: { conv: react.conv, msg: react.msg, emoji, on: react.on },
    priority: "user",
  });
  return r.ok ? ok({ message: parseHomeChatMessage(obj(r.body)?.message) }) : r;
}

/** `POST /cli/home-chat/ack {conv}`: read up to the newest (while the chat
 *  is on screen and the app in focus). */
export async function ackHomeChat(scope: ServerScope, conv: string): Promise<HomeChatResult<object>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/ack", { method: "POST", body: { conv } });
  return r.ok ? ok({}) : r;
}

/** `POST /cli/home-chat/typing {conv}` — throttle with `typingTick`
 *  (one per 8 s per conversation). `via`: `http` (Sew's `httpTyping`) or
 *  `gateway` (`sent` says whether the gateway took it). */
export async function typingHomeChat(
  scope: ServerScope,
  conv: string
): Promise<HomeChatResult<{ via: "http" | "gateway" | null; sent: boolean | null }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/typing", { method: "POST", body: { conv } });
  if (!r.ok) return r;
  const o = obj(r.body) ?? {};
  return ok({
    via: o.via === "http" || o.via === "gateway" ? o.via : null,
    sent: typeof o.sent === "boolean" ? o.sent : null,
  });
}

/** `POST /cli/home-chat/view {conv, open}`: `open: true` while the chat is
 *  on screen (subscribes typing; joins an open channel you haven't),
 *  `false` when it leaves. */
export async function viewHomeChat(
  scope: ServerScope,
  conv: string,
  open: boolean
): Promise<HomeChatResult<{ joined: boolean }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/view", { method: "POST", body: { conv, open }, priority: "user" });
  return r.ok ? ok({ joined: obj(r.body)?.joined === true }) : r;
}

// ─── Channels (K2 checks the caller first) ───

/** `POST /cli/home-chat/channels/create {name, open, members[]}`. `conv` is
 *  null while pending: `waitForHomeChatChannel`. */
export async function createHomeChatChannel(
  scope: ServerScope,
  make: { name: string; open: boolean; members: readonly string[] }
): Promise<HomeChatResult<HomeChatCreated>> {
  const name = make.name.trim();
  if (!name || [...name].length > 100) return clientRefusal("usage", "a channel name is 1-100 characters");
  if (make.members.length >= 100) return clientRefusal("usage", "a new channel takes at most 99 people; add the rest after");
  const r = await call(scope, "/cli/home-chat/channels/create", {
    method: "POST",
    body: { name, open: make.open, members: [...make.members] },
    priority: "user",
  });
  if (!r.ok) return r;
  const made = parseHomeChatCreated(r.body);
  return made ? ok(made) : clientRefusal("bad_response", "the create answer has no slug");
}

/** Poll `channels/members?slug=` every 1 s for up to 30 s until a new
 *  channel's `conv` shows (desktop `waitForChannelId`). `conv: null` on
 *  timeout: say `HOME_CHAT_CREATE_TIMEOUT_COPY`. */
export async function waitForHomeChatChannel(
  scope: ServerScope,
  slug: string,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number; waitMs?: number; pollMs?: number } = {}
): Promise<HomeChatResult<{ conv: string | null }>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = deps.now ?? Date.now;
  const until = now() + (deps.waitMs ?? 30_000);
  for (;;) {
    const r = await fetchHomeChatMembers(scope, { slug });
    if (!r.ok && r.kind !== "retry" && r.kind !== "network") return r;
    if (r.ok && r.members.conv) return ok({ conv: r.members.conv });
    if (now() >= until) return ok({ conv: null });
    await sleep(deps.pollMs ?? 1_000);
  }
}

/** `POST /cli/home-chat/channels/add {conv, ext[]}`: one outcome each. */
export async function addHomeChatPeople(
  scope: ServerScope,
  conv: string,
  ext: readonly string[]
): Promise<HomeChatResult<{ results: HomeChatAddOutcome[] }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/channels/add", { method: "POST", body: { conv, ext: [...ext] }, priority: "user" });
  return r.ok ? ok({ results: parseHomeChatAddResults(r.body) }) : r;
}

/** `POST /cli/home-chat/channels/remove {conv, ext}` (Owner/Admin removes
 *  others; nobody is removed from an open channel: 409 `channel_open`). */
export async function removeHomeChatPerson(
  scope: ServerScope,
  conv: string,
  ext: string
): Promise<HomeChatResult<{ removed: boolean }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/channels/remove", { method: "POST", body: { conv, ext }, priority: "user" });
  return r.ok ? ok({ removed: obj(r.body)?.removed === true }) : r;
}

/** `POST /cli/home-chat/channels/leave {conv}`. */
export async function leaveHomeChatChannel(scope: ServerScope, conv: string): Promise<HomeChatResult<{ left: boolean }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/channels/leave", { method: "POST", body: { conv }, priority: "user" });
  return r.ok ? ok({ left: obj(r.body)?.left === true }) : r;
}

/** `POST /cli/home-chat/channels/rename {conv, name}` (creator, or an
 *  Owner/Admin who sees it). */
export async function renameHomeChatChannel(
  scope: ServerScope,
  conv: string,
  name: string
): Promise<HomeChatResult<object>> {
  if (!isSewId(conv)) return badId("conv");
  const n = name.trim();
  if (!n || [...n].length > 100) return clientRefusal("usage", "a channel name is 1-100 characters");
  const r = await call(scope, "/cli/home-chat/channels/rename", { method: "POST", body: { conv, name: n }, priority: "user" });
  return r.ok ? ok({}) : r;
}

/** `POST /cli/home-chat/channels/delete {conv}`: archives (history stays). */
export async function deleteHomeChatChannel(scope: ServerScope, conv: string): Promise<HomeChatResult<{ archived: boolean }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/channels/delete", { method: "POST", body: { conv }, priority: "user" });
  return r.ok ? ok({ archived: obj(r.body)?.archived === true }) : r;
}

/** `POST /cli/home-chat/channels/allow-agents {conv, on}` (Owner/Admin). */
export async function setHomeChatAllowAgents(
  scope: ServerScope,
  conv: string,
  on: boolean
): Promise<HomeChatResult<{ allowAgents: boolean }>> {
  if (!isSewId(conv)) return badId("conv");
  const r = await call(scope, "/cli/home-chat/channels/allow-agents", { method: "POST", body: { conv, on }, priority: "user" });
  return r.ok ? ok({ allowAgents: obj(r.body)?.allowAgents === true }) : r;
}

// ─── DM calls (§3) ───

/** A held join waits up to 20 s on the server. */
const JOIN_TIMEOUT_MS = 30_000;

/** `POST /cli/voice/join {dm, join?, callAnswer?}`: ring (or answer the
 *  ring already here). Keeps K2's `callId` (`vc_…`, for leave) and Sew's
 *  `sewCallId` (for decline / ring / cancel) apart. Sew's media join is
 *  not returned: the native engine makes media joins. */
export async function joinDmCall(
  scope: ServerScope,
  conv: string,
  opts: { join?: DmJoinOptions; callAnswer?: boolean } = {}
): Promise<HomeChatResult<{ answer: DmJoinAnswer }>> {
  if (!isSewId(conv)) return badId("dm");
  const r = await call(scope, "/cli/voice/join", {
    method: "POST",
    body: dmJoinBody(conv, opts.join, opts.callAnswer),
    priority: "user",
    timeoutMs: JOIN_TIMEOUT_MS,
  });
  if (!r.ok) return r;
  const answer = parseDmJoinAnswer(r.body);
  return answer ? ok({ answer }) : clientRefusal("bad_response", "the join answer has no callId or dm");
}

/** `POST /cli/voice/call/decline {dm, callId}` — Sew's call id. */
export async function declineDmCall(
  scope: ServerScope,
  conv: string,
  callId: SewCallId
): Promise<HomeChatResult<{ declined: boolean }>> {
  if (!isSewId(conv)) return badId("dm");
  const r = await call(scope, "/cli/voice/call/decline", { method: "POST", body: { dm: conv, callId }, priority: "user" });
  return r.ok ? ok({ declined: obj(r.body)?.declined === true }) : r;
}

/** `POST /cli/voice/call/ring {dm, callId, memberIds?}`: ring again (Sew
 *  allows 3 per person) — Sew's call id. */
export async function ringDmCallAgain(
  scope: ServerScope,
  conv: string,
  callId: SewCallId,
  memberIds?: readonly string[]
): Promise<HomeChatResult<{ rung: boolean }>> {
  if (!isSewId(conv)) return badId("dm");
  const body: Record<string, unknown> = { dm: conv, callId };
  if (memberIds) {
    if (!memberIds.every(isSewId)) return badId("memberIds");
    body.memberIds = [...memberIds];
  }
  const r = await call(scope, "/cli/voice/call/ring", { method: "POST", body, priority: "user" });
  return r.ok ? ok({ rung: obj(r.body)?.rung === true }) : r;
}

/** `POST /cli/voice/call/cancel {dm, callId}`: the caller's Cancel — Sew's
 *  call id. Without Sew's `callCancel` the server leaves instead
 *  (`cancelled: false, via: "leave"`) and the callee sees a missed call. */
export async function cancelDmCall(
  scope: ServerScope,
  conv: string,
  callId: SewCallId
): Promise<HomeChatResult<DmCancelAnswer>> {
  if (!isSewId(conv)) return badId("dm");
  const r = await call(scope, "/cli/voice/call/cancel", { method: "POST", body: { dm: conv, callId }, priority: "user" });
  return r.ok ? ok(parseDmCancelAnswer(r.body)) : r;
}

/** `POST /cli/voice/call/leave {callId}` — K2's call id (`vc_…`), always:
 *  without one K2 leaves whatever call this login is in, which could be
 *  another device's (K2's answers §4). The call store's leave is
 *  `session/leave` (zen/voice/voiceApi.ts `leaveVoiceSession`), the same
 *  leave. */
export async function leaveDmCall(scope: ServerScope, callId: K2CallId): Promise<HomeChatResult<DmLeaveAnswer>> {
  if (!callId) return clientRefusal("usage", "callId is K2's call id (vc_…)");
  const r = await call(scope, "/cli/voice/call/leave", {
    method: "POST",
    body: { callId },
    priority: "user",
  });
  return r.ok ? ok(parseDmLeaveAnswer(r.body)) : r;
}

// ─── The gate (§2.2) ───

/** A status answer stays good this long; a failed read is retried sooner. */
export const HOME_CHAT_GATE_FRESH_MS = 2 * 60_000;
export const HOME_CHAT_GATE_RETRY_MS = 15_000;

export interface HomeChatGate {
  /** `home-chat-v1` in `/boot-status` AND `status.on`. */
  offered: boolean;
  /** `/boot-status` lists `home-chat-v1` (live from the boot memory). */
  feature: boolean;
  /** `status.on`; null while not read (or the feature is missing). */
  on: boolean | null;
  /** `off` | `mac` | `sew_off` | `space_pending`; null while on/unknown. */
  reason: string | null;
  flags: HomeChatFlags;
  /** The person's Sew link (`status.chat`, or the socket's last word). */
  chat: string | null;
  /** When the status was last read (epoch ms); null never. */
  checkedAt: number | null;
  /** The last read's refusal (a failed or refused status read). */
  refusal: HomeChatRefusal | null;
  /** The desktop's picker line for a server with no usable chat; null
   *  while offered or unknown. */
  pickerLine: string | null;
}

interface GateEntry {
  status: HomeChatStatus | null;
  refusal: HomeChatRefusal | null;
  /** When the next read is due. */
  dueAt: number;
  checkedAt: number;
  /** The boot feature when this was read: a change makes it stale. */
  feature: boolean;
}

const gates = new Map<string, GateEntry>();
const gateInflight = new Map<string, Promise<HomeChatGate>>();
type GateListener = (serverId: string, gate: HomeChatGate) => void;
const gateListeners = new Set<GateListener>();

onServerForget((id) => {
  gates.delete(id);
  gateInflight.delete(id);
});

function featureOf(scope: ServerScope): boolean {
  try {
    return scope.supports(HOME_CHAT_FEATURE);
  } catch {
    return false;
  }
}

function gateOf(feature: boolean, e: GateEntry | undefined): HomeChatGate {
  const status = feature ? (e?.status ?? null) : null;
  const on = status ? status.on : null;
  const reason = status && !status.on ? (status.reason ?? null) : null;
  return {
    offered: feature && on === true,
    feature,
    on,
    reason,
    flags: status ? { ...status.flags } : { ...NO_HOME_CHAT_FLAGS },
    chat: status?.chat ?? null,
    checkedAt: e?.checkedAt ?? null,
    refusal: e?.refusal ?? null,
    pickerLine: status && !status.on ? homeChatNoChatLine(reason) : null,
  };
}

function emitGate(scope: ServerScope): void {
  const g = homeChatGateNow(scope);
  for (const fn of [...gateListeners]) {
    try {
      fn(scope.id, g);
    } catch {
      /* a listener never breaks the gate */
    }
  }
}

/** The gate as known now (no I/O). Unknown → not offered. */
export function homeChatGateNow(scope: ServerScope): HomeChatGate {
  return gateOf(featureOf(scope), gates.get(scope.id));
}

/** Is the known gate due a re-read? */
export function homeChatGateStale(scope: ServerScope, now = Date.now()): boolean {
  const e = gates.get(scope.id);
  return !e || e.feature !== featureOf(scope) || now >= e.dueAt;
}

/** Read the gate: `/boot-status` (from the boot memory; one re-read when it
 *  doesn't list the feature and is older than its max age), then
 *  `GET /cli/home-chat/status`. Single-flight per server. `force` skips
 *  the freshness check. Never throws. */
export function refreshHomeChatGate(scope: ServerScope, opts: { force?: boolean } = {}): Promise<HomeChatGate> {
  if (!scope.id) return Promise.resolve(gateOf(false, undefined));
  if (!opts.force && !homeChatGateStale(scope)) return Promise.resolve(homeChatGateNow(scope));
  const running = gateInflight.get(scope.id);
  if (running) return running;
  const p = (async (): Promise<HomeChatGate> => {
    let feature = featureOf(scope);
    if (!feature) {
      try {
        await ensureBootStatus(scope);
      } catch {
        /* the boot memory keeps what it knew */
      }
      feature = featureOf(scope);
    }
    const now = Date.now();
    if (!feature) {
      gates.set(scope.id, { status: null, refusal: null, dueAt: now + HOME_CHAT_GATE_FRESH_MS, checkedAt: now, feature });
      return homeChatGateNow(scope);
    }
    const r = await fetchHomeChatStatus(scope);
    const prev = gates.get(scope.id);
    const at = Date.now();
    if (r.ok) {
      gates.set(scope.id, { status: r.status, refusal: null, dueAt: at + HOME_CHAT_GATE_FRESH_MS, checkedAt: at, feature });
    } else if (r.kind === "not_supported" || r.kind === "unavailable" || r.kind === "wrong_login" || r.kind === "auth") {
      // A definite answer: not usable with this login now.
      const status: HomeChatStatus = {
        on: false,
        reason: r.kind === "unavailable" ? (r.reason ?? null) : null,
        flags: { ...NO_HOME_CHAT_FLAGS },
        chat: null,
      };
      gates.set(scope.id, { status, refusal: r, dueAt: at + HOME_CHAT_GATE_FRESH_MS, checkedAt: at, feature });
    } else {
      // A blip (network, 5xx, retry): keep what was known, ask again soon.
      gates.set(scope.id, {
        status: prev?.feature === feature ? (prev?.status ?? null) : null,
        refusal: r,
        dueAt: at + (r.retryAfterMs ?? HOME_CHAT_GATE_RETRY_MS),
        checkedAt: at,
        feature,
      });
    }
    return homeChatGateNow(scope);
  })().finally(() => {
    gateInflight.delete(scope.id);
    emitGate(scope);
  });
  gateInflight.set(scope.id, p);
  return p;
}

/** Offer people and channels for this server? Reads the gate when it is
 *  stale; never assumes. */
export async function homeChatOffered(scope: ServerScope): Promise<boolean> {
  return (await refreshHomeChatGate(scope)).offered;
}

/** Hear every gate change (a read, a closing refusal, the socket's flags). */
export function onHomeChatGate(fn: GateListener): () => void {
  gateListeners.add(fn);
  return () => {
    gateListeners.delete(fn);
  };
}

/** A route said chat is off or unusable: close the gate until the next
 *  read (which is due at once, so the next `homeChatOffered` re-checks). */
function noteGateClosed(scope: ServerScope, r: HomeChatRefusal): void {
  if (!scope.id) return;
  const prev = gates.get(scope.id);
  const now = Date.now();
  const reason = r.kind === "off" ? "off" : (r.reason ?? prev?.status?.reason ?? null);
  gates.set(scope.id, {
    status: { on: false, reason, flags: prev?.status?.flags ?? { ...NO_HOME_CHAT_FLAGS }, chat: prev?.status?.chat ?? null },
    refusal: r,
    dueAt: now + HOME_CHAT_GATE_RETRY_MS,
    checkedAt: now,
    feature: featureOf(scope),
  });
  emitGate(scope);
}

/** The events socket's word: `hello.flags` / `hello.chat` and `status`
 *  frames. Updates a known-on gate only; it never opens a gate. */
export function noteHomeChatLink(scope: ServerScope, update: { flags?: HomeChatFlags; chat?: string | null }): void {
  const e = gates.get(scope.id);
  if (!e?.status?.on) return;
  const status: HomeChatStatus = {
    ...e.status,
    flags: update.flags ? { ...update.flags } : e.status.flags,
    chat: update.chat !== undefined ? strOrNull(update.chat) : e.status.chat,
  };
  gates.set(scope.id, { ...e, status });
  emitGate(scope);
}

/** Tests only. */
export function __resetHomeChatGateForTests(): void {
  gates.clear();
  gateInflight.clear();
  gateListeners.clear();
}
