// DM calls (K2 0.46.13, brief §3; daemon `voice/dm_call.rs`, desktop
// `lib/home-chat/calls.ts`): the wire types and parsers. Pure.
//
// TWO CALL IDS, KEPT APART BY TYPE:
//   - `K2CallId` — K2's call record (`vc_…`), the join answer's top-level
//     `callId`. Leave takes it (`/cli/voice/call/leave`,
//     `/cli/voice/session/leave`).
//   - `SewCallId` — Sew's call (digits): the join answer's `call.id`, the
//     `call_ring` frame's `call_id`, the push's `callId`. Decline, ring
//     again and cancel take it.
// The brands make passing one where the other belongs a type error, and
// the constructors refuse the other's shape at runtime.

import { arr, idOf, msOf, obj, str, strOrNull } from "./homeChatPure";

export type K2CallId = string & { readonly __k2CallId: unique symbol };
export type SewCallId = string & { readonly __sewCallId: unique symbol };

/** Sew's call id: digits only. Null for anything else (a `vc_…` id). */
export function asSewCallId(v: unknown): SewCallId | null {
  const id = idOf(v);
  return id && /^\d{1,20}$/.test(id) ? (id as SewCallId) : null;
}

/** K2's call id: `vc_<uuid>` (`voice/bff.rs` `note_call`). Null for
 *  anything else (a digits-only id is Sew's). */
export function asK2CallId(v: unknown): K2CallId | null {
  const id = typeof v === "string" ? v.trim() : "";
  return /^vc_[A-Za-z0-9_-]{1,120}$/.test(id) ? (id as K2CallId) : null;
}

/** A DM call's room id: `dm:<conversation id>`. */
export const DM_ROOM_PREFIX = "dm:";

export function dmRoomId(conv: string): string {
  return `${DM_ROOM_PREFIX}${conv}`;
}

/** The conversation of a DM call's room id; null for a voice room. */
export function convOfDmRoom(roomId: string | null | undefined): string | null {
  return roomId && roomId.startsWith(DM_ROOM_PREFIX) ? roomId.slice(DM_ROOM_PREFIX.length) || null : null;
}

// ─── Live call state (frames) ───

/** Why a ring stopped (`ringing: false`). */
export type HomeChatRingReason = "accepted" | "declined" | "timeout" | "call_ended" | "cancelled";

/** A ring for this person (`call_ring` `d`, or a `hello.calls` entry). */
export interface HomeChatRing {
  callId: SewCallId;
  conv: string;
  /** The caller's Sew member id. */
  startedBy: string | null;
  /** False: the ring stopped (any reason): take the card down. */
  ringing: boolean;
  /** Busy in another call, Do Not Disturb, or a muted DM: no sound. */
  silent: boolean;
  reason: HomeChatRingReason | (string & {}) | null;
  /** Epoch ms when it times out (Sew's 45 s), when Sew said. */
  expiresAtMs: number | null;
}

export function parseRing(d: unknown): HomeChatRing | null {
  const o = obj(d);
  const callId = asSewCallId(o?.call_id);
  const conv = idOf(o?.channel_id);
  if (!o || !callId || !conv) return null;
  return {
    callId,
    conv,
    startedBy: idOf(o.started_by),
    ringing: o.ringing === true,
    silent: o.silent === true,
    reason: strOrNull(o.reason),
    expiresAtMs: msOf(o.expires_at),
  };
}

export type HomeChatRingState = "ringing" | "busy" | "accepted" | "declined" | "missed" | "cancelled";

/** A DM call as every member sees it (`call_updated` `d.call`). */
export interface HomeChatCall {
  callId: SewCallId;
  conv: string;
  startedBy: string | null;
  /** Sew's `state` (`ringing`, `active`, `ended`, …). */
  state: string;
  ended: boolean;
  endReason: string | null;
  participantIds: string[];
  rings: Array<{ memberId: string; state: HomeChatRingState | (string & {}) }>;
}

function ids(v: unknown): string[] {
  return arr(v)
    .map(idOf)
    .filter((x): x is string => x !== null);
}

/** `d` (or `d.call`) → the call; null without ids. */
export function parseCall(v: unknown): HomeChatCall | null {
  const o = obj(v);
  const call = obj(o?.call) ?? o;
  const callId = asSewCallId(call?.id);
  const conv = idOf(call?.channel_id);
  if (!call || !callId || !conv) return null;
  return {
    callId,
    conv,
    startedBy: idOf(call.started_by),
    state: str(call.state),
    ended: call.state === "ended",
    endReason: strOrNull(call.end_reason),
    participantIds: ids(call.participant_ids),
    rings: arr(call.rings)
      .map((r) => obj(r))
      .filter((r): r is Record<string, unknown> => r !== null)
      .map((r) => ({ memberId: idOf(r.member_id) ?? "", state: strOrNull(r.state) ?? "ringing" }))
      .filter((r) => r.memberId !== ""),
  };
}

/** One `hello.calls` entry: the calls already ringing when the socket
 *  opened (camelCase, `CallSeen::view`), with Sew's last `call`. */
export function parseHelloCall(v: unknown): { ring: HomeChatRing; call: HomeChatCall | null } | null {
  const c = obj(v);
  if (!c) return null;
  const ring = parseRing({
    call_id: c.callId,
    channel_id: c.conv,
    started_by: c.startedBy,
    ringing: c.ringing,
    silent: c.silent,
    expires_at: c.expiresAt,
  });
  return ring ? { ring, call: c.call ? parseCall(c.call) : null } : null;
}

// ─── The call's record (Sew's CallSummary on a message) ───

export interface HomeChatCallSummary {
  callId: SewCallId;
  startedBy: string | null;
  ended: boolean;
  endReason: string | null;
  durationMs: number | null;
  joinedIds: string[];
  rungIds: string[];
  declinedIds: string[];
  missedIds: string[];
}

export function parseCallSummary(v: unknown): HomeChatCallSummary | null {
  const o = obj(v);
  const callId = asSewCallId(o?.call_id);
  if (!o || !callId) return null;
  return {
    callId,
    startedBy: idOf(o.started_by),
    ended: typeof o.ended_at === "string" || typeof o.end_reason === "string",
    endReason: strOrNull(o.end_reason),
    durationMs: typeof o.duration_ms === "number" && Number.isFinite(o.duration_ms) ? o.duration_ms : null,
    joinedIds: ids(o.joined_ids),
    rungIds: ids(o.rung_ids),
    declinedIds: ids(o.declined_ids),
    missedIds: ids(o.missed_ids),
  };
}

/** `12:04`, or `1:02:03` past an hour. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export type CallRecordKind = "live" | "missed" | "declined" | "cancelled" | "answered" | "ended";

/** What a call's record line says to `me` (a Sew member id), as the
 *  desktop's `callRecordLine`: a line, not a bubble, with Call back once
 *  over. A cancelled ring is never "Missed call". */
export function callRecordLine(
  s: HomeChatCallSummary,
  me: string | null
): { kind: CallRecordKind; text: string; callBack: boolean } {
  if (!s.ended) return { kind: "live", text: "Call in progress", callBack: false };
  if (s.endReason === "cancelled") return { kind: "cancelled", text: "Cancelled", callBack: true };
  if (s.endReason === "declined" || (me !== null && s.declinedIds.includes(me)))
    return { kind: "declined", text: "Declined", callBack: true };
  if (s.joinedIds.length >= 2)
    return { kind: "answered", text: `Call · ${formatCallDuration(s.durationMs ?? 0)}`, callBack: true };
  if (s.endReason === "no_answer" || s.missedIds.length > 0) return { kind: "missed", text: "Missed call", callBack: true };
  return { kind: "ended", text: "Call ended", callBack: true };
}

// ─── Route answers ───

/** Sew's call join body (`join` in `POST /cli/voice/join {dm, join}`).
 *  K2 adds `call_credential: true` itself; `ring` left out rings unless a
 *  call already rings for you in that DM (then the join answers it). */
export interface DmJoinOptions {
  self_mute?: boolean;
  self_deaf?: boolean;
  self_video?: boolean;
  ring?: boolean;
  recording_notice?: unknown;
}

/** The body `POST /cli/voice/join` takes for a DM call. The native join
 *  provider (src-tauri `voice.rs` `join_body`) sends `{room, join}` for a
 *  room today; a DM call sends `{dm, join}` instead. */
export function dmJoinBody(conv: string, join: DmJoinOptions = {}, callAnswer?: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { dm: conv, join: { ...join } };
  if (callAnswer !== undefined) body.callAnswer = callAnswer;
  return body;
}

/** What the phone keeps from a DM join answer. Sew's join (`join`: the
 *  media token, the call credential, e2ee init) is deliberately NOT kept:
 *  media joins belong to the native engine, and no media token reaches the
 *  webview (K2's voice PRD §14.4). */
export interface DmJoinAnswer {
  /** K2's call record (`vc_…`): for leave. */
  callId: K2CallId;
  /** Sew's call (`call.id`): for decline, ring again, cancel. */
  sewCallId: SewCallId | null;
  dm: string;
  room: { id: string; kind: "dm"; channelId: string };
  call: HomeChatCall | null;
  /** Sew made a new call (you rang) rather than answering one. */
  created: boolean | null;
  relayOnly: boolean;
  heldMs: number | null;
  /** The server's label (`server` on the join answer). */
  server: string | null;
}

export function parseDmJoinAnswer(v: unknown): DmJoinAnswer | null {
  const o = obj(v);
  const callId = asK2CallId(o?.callId);
  const dm = idOf(o?.dm);
  if (!o || !callId || !dm) return null;
  const room = obj(o.room);
  const callObj = obj(o.call);
  return {
    callId,
    sewCallId: asSewCallId(callObj?.id),
    dm,
    room: { id: str(room?.id) || dmRoomId(dm), kind: "dm", channelId: idOf(room?.channelId) ?? dm },
    call: callObj ? parseCall(callObj) : null,
    created: typeof o.created === "boolean" ? o.created : null,
    relayOnly: o.relayOnly === true,
    heldMs: typeof o.heldMs === "number" && Number.isFinite(o.heldMs) ? o.heldMs : null,
    server: strOrNull(o.server),
  };
}

/** `call/cancel`: with Sew's `callCancel` a real cancel; without it the
 *  server left instead (`via: "leave"`) and the callee sees a missed call. */
export interface DmCancelAnswer {
  cancelled: boolean;
  via: "cancel" | "leave";
  callId: SewCallId | null;
  hint: string | null;
}

export function parseDmCancelAnswer(v: unknown): DmCancelAnswer {
  const o = obj(v) ?? {};
  return {
    cancelled: o.cancelled === true,
    via: o.via === "leave" ? "leave" : "cancel",
    callId: asSewCallId(o.callId),
    hint: strOrNull(o.hint),
  };
}

/** `call/leave` (today's leave): idempotent; `already` with `why` when the
 *  call had already ended for this login session. */
export interface DmLeaveAnswer {
  left: boolean;
  already: boolean;
  why: string | null;
  room: string | null;
}

export function parseDmLeaveAnswer(v: unknown): DmLeaveAnswer {
  const o = obj(v) ?? {};
  return { left: o.left === true, already: o.already === true, why: strOrNull(o.why), room: strOrNull(o.room) };
}
