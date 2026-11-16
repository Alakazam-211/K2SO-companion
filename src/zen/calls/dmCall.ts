import { create } from "zustand";
import { scopeFor } from "../../api/scope";
import {
  cancelDmCall as apiCancel,
  declineDmCall as apiDecline,
  fetchHomeChatPeople,
  homeChatGateNow,
  homeChatGateStale,
  leaveDmCall as apiLeave,
  openHomeChatDm,
  refreshHomeChatGate,
  ringDmCallAgain as apiRingAgain,
} from "../../api/homeChat";
import { isSewId, type HomeChatRefusal } from "../../api/homeChatPure";
import {
  asK2CallId,
  asSewCallId,
  dmRoomId,
  type HomeChatCall,
  type HomeChatRing,
  type K2CallId,
  type SewCallId,
} from "../../api/homeChatCallsPure";
import type { HomeChatFrame } from "../../api/homeChatEvents";
import { useVoiceCall, type CallRoom, type JoinOutcome } from "../voice/voiceCall";
import { listenDmCallIds, readDmCallIds, type NativeDmCallIds } from "../voice/sewVoice";
import { cancelFellBackText, dmCallRetryable, dmJoinErrorText, endReasonState, type CallingState } from "./dmCallText";
import { requestOpenHomeChat } from "./homeChatOpen";

// DM calls on the phone (K2 0.46.13, brief §3; desktop
// `HomeChatCallControls.tsx`): one person calling another from Home or a DM.
//
// Media is the voice call's (voiceCall.ts, the native engine): a DM call is
// the room `dm:<conversation id>`, and the engine's join sends `{dm, join}`
// (src-tauri voice.rs `join_body`). That join rings, or answers the ring
// already there for this person. One join only: K2 keeps one voice entry
// per person, so a DM call ends any voice room you're in (the voice store
// leaves it first).
//
// THE TWO CALL IDS (K2 brief §3, desktop decision 11):
//   - K2's `vc_…` (the join answer's top-level `callId`): leave
//     (`/cli/voice/call/leave`). From the native join (Rust keeps the ids
//     only: `k2-voice://dm-call`, `voice_dm_call`).
//   - Sew's (digits; `call.id`, `call_ring.call_id`, the push's `callId`):
//     decline, ring again, cancel. From the native join, else the first
//     `call_updated` frame.
// The branded types keep them apart.
//
// Live state from the Home chat socket (homeChatEvents.ts), one per server
// that offers Home chat (`startDmCallWatch`): `call_ring` puts up or takes
// down a ring card (`ringing: false` for any reason stops it; a silent ring
// has no sound), `call_updated` drives the caller's bar and ends the media
// when the call ended, `hello.calls` brings back rings already going.

/** The caller's "Declined" / "No answer" line stays this long. */
export const CALL_ENDED_SHOW_MS = 4_000;
/** Sew lets a caller ring each person 3 times. */
export const RING_AGAIN_MAX = 3;
/** A ring with no `expires_at` comes down after this (Sew's own is 45 s). */
export const RING_FALLBACK_MS = 60_000;
/** The people list (callers' names) is read again after this. */
const PEOPLE_FRESH_MS = 5 * 60_000;

export type DmCallRole = "caller" | "answerer";
export type DmCallPhase = Exclude<CallingState, "joining"> | "joining" | "connected";

export interface DmCallTarget {
  serverId: string;
  conv: string;
  name: string;
}

export interface ActiveDmCall extends DmCallTarget {
  serverLabel: string;
  role: DmCallRole;
  phase: DmCallPhase;
  /** K2's call record (`vc_…`): leave. */
  k2CallId: K2CallId | null;
  /** Sew's call: cancel, ring again. */
  sewCallId: SewCallId | null;
  /** Rings sent again so far. */
  ringsAgain: number;
  /** When it ended (the final line's clock). */
  endedAt: number | null;
}

export interface IncomingRing {
  /** `<serverId>|<Sew call id>`. */
  key: string;
  serverId: string;
  serverLabel: string;
  callId: SewCallId;
  conv: string;
  callerName: string;
  /** No sound (busy, Do Not Disturb, a muted DM). */
  silent: boolean;
  expiresAtMs: number | null;
  busy: "accepting" | "declining" | null;
}

export interface DmCallNotice {
  text: string;
  /** "Try again" calls this again. */
  retry: DmCallTarget | null;
}

type State = {
  active: ActiveDmCall | null;
  /** Newest first. */
  rings: IncomingRing[];
  /** Each DM's last call as `call_updated` said (`<serverId>|<conv>`). */
  calls: Record<string, HomeChatCall>;
  notice: DmCallNotice | null;
};

const EMPTY: State = { active: null, rings: [], calls: {}, notice: null };

export const useDmCalls = create<State>(() => ({ ...EMPTY }));

const get = () => useDmCalls.getState();
const set = (p: Partial<State>) => useDmCalls.setState(p);

const FINAL: ReadonlySet<DmCallPhase> = new Set(["declined", "missed", "cancelled", "ended"]);

export function isFinalPhase(phase: DmCallPhase): boolean {
  return FINAL.has(phase);
}

function callKey(serverId: string, conv: string): string {
  return `${serverId}|${conv}`;
}

function labelOf(serverId: string): string {
  try {
    return scopeFor(serverId).label;
  } catch {
    return "";
  }
}

function isThis(a: ActiveDmCall | null, serverId: string, conv: string): a is ActiveDmCall {
  return !!a && a.serverId === serverId && a.conv === conv;
}

function patchActive(serverId: string, conv: string, patch: Partial<ActiveDmCall>): void {
  const a = get().active;
  if (isThis(a, serverId, conv)) set({ active: { ...a, ...patch } });
}

// ─── Native ids (Rust's DM join) ───

type IdsSource = {
  read: () => Promise<NativeDmCallIds | null>;
  listen: (fn: (ids: NativeDmCallIds | null) => void) => () => void;
};
let ids: IdsSource = { read: readDmCallIds, listen: listenDmCallIds };

function applyIds(v: NativeDmCallIds | null): void {
  const a = get().active;
  if (!v || !a || v.dm !== a.conv) return;
  const k2 = asK2CallId(v.callId) ?? a.k2CallId;
  const sew = asSewCallId(v.sewCallId) ?? a.sewCallId;
  if (k2 !== a.k2CallId || sew !== a.sewCallId) set({ active: { ...a, k2CallId: k2, sewCallId: sew } });
}

// ─── Callers' names ───

const people = new Map<string, { at: number; names: Promise<Map<string, string>> }>();

function namesOf(serverId: string): Promise<Map<string, string>> {
  const hit = people.get(serverId);
  if (hit && Date.now() - hit.at < PEOPLE_FRESH_MS) return hit.names;
  const names = fetchHomeChatPeople(scopeFor(serverId)).then((r) => {
    const m = new Map<string, string>();
    if (!r.ok) {
      // Asked again next time.
      people.delete(serverId);
      return m;
    }
    for (const p of r.people) {
      if (p.memberId) m.set(p.memberId, p.displayName);
    }
    return m;
  });
  people.set(serverId, { at: Date.now(), names });
  return names;
}

async function nameRing(key: string, serverId: string, memberId: string | null): Promise<void> {
  if (!memberId) return;
  const name = (await namesOf(serverId)).get(memberId);
  if (!name) return;
  set({ rings: get().rings.map((r) => (r.key === key ? { ...r, callerName: name } : r)) });
}

// ─── Notices ───

function noticeFor(t: DmCallTarget, raw: string, code: string, hint: string): DmCallNotice {
  return {
    text: dmJoinErrorText(raw, code, t.name, labelOf(t.serverId), hint),
    retry: dmCallRetryable(raw, code) ? { ...t } : null,
  };
}

function refusalRaw(r: HomeChatRefusal): string {
  // A plain 404 (older server) and the client's own kinds have no code of their own.
  return r.kind === "not_supported" || r.kind === "network" || r.kind === "not_connected" ? r.kind : r.code;
}

export function clearDmCallNotice(): void {
  set({ notice: null });
}

// ─── The media (voice store) ───

let followingVoice = false;

/** When the media ends while a DM call is up (the other side hung up, a
 *  drop, your own Hang up on the call tile): the call is over here, and
 *  K2's record is left with its `vc_…` id (idempotent). */
function followVoice(): void {
  if (followingVoice) return;
  followingVoice = true;
  useVoiceCall.subscribe((s, prev) => {
    if (prev.phase === "idle" || s.phase !== "idle") return;
    const room = prev.room;
    const a = get().active;
    if (!room?.dm || !a || !isThis(a, room.serverId, room.dm.conv)) return;
    if (a.phase === "joining" || isFinalPhase(a.phase)) return;
    if (a.k2CallId) void apiLeave(scopeFor(a.serverId), a.k2CallId);
    set({ active: null });
    if (s.notice) {
      set({ notice: { text: s.notice, retry: null } });
      useVoiceCall.getState().clearNotice();
    }
  });
}

function inThisMedia(a: ActiveDmCall): boolean {
  const v = useVoiceCall.getState();
  return v.phase !== "idle" && v.room?.serverId === a.serverId && v.room?.dm?.conv === a.conv;
}

/** The call ended on the server: the media goes too (desktop: so the seat
 *  and the mic are let go), then the final line. */
function endActive(state: DmCallPhase): void {
  const a = get().active;
  if (!a) return;
  markEnded(state);
  if (inThisMedia(a) && useVoiceCall.getState().phase !== "joining") void useVoiceCall.getState().leave();
}

/** The final line, then nothing (unless something newer came). A call that
 *  was up just ends. */
function markEnded(state: DmCallPhase): void {
  const a = get().active;
  if (!a) return;
  if (state === "ended" && (a.phase === "connected" || a.role === "answerer")) {
    set({ active: null });
    return;
  }
  const endedAt = Date.now();
  set({ active: { ...a, phase: state, endedAt } });
  setTimeout(() => {
    const now = get().active;
    if (now && now.endedAt === endedAt) set({ active: null });
  }, CALL_ENDED_SHOW_MS);
}

/** What a live call says about the caller's bar. */
export function phaseFromCall(call: HomeChatCall, role: DmCallRole): DmCallPhase {
  if (call.ended) return endReasonState(call.endReason);
  if (role === "answerer") return "connected";
  const starter = call.startedBy;
  if (call.participantIds.some((p) => p !== starter)) return "connected";
  const other = call.rings.find((r) => r.memberId !== starter);
  switch (other?.state) {
    case "busy":
      return "busy";
    case "accepted":
      return "connected";
    case "declined":
      return "declined";
    case "missed":
      return "missed";
    case "cancelled":
      return "cancelled";
    default:
      return "ringing";
  }
}

// ─── Flows ───

export type DmCallOutcome = JoinOutcome | { ok: false; code: "usage" | "gate"; raw: string; hint: string };

/** Call the person in DM `conversationId` on `serverId` (or answer their
 *  ring there: the same join answers it). `name` is the other person's,
 *  for the bar and the call screen. A voice room you're in ends first. */
export async function startDmCall(
  serverId: string,
  conversationId: string,
  opts: { name?: string | null } = {}
): Promise<DmCallOutcome> {
  followVoice();
  const conv = String(conversationId ?? "").trim();
  const name = opts.name?.trim() || "them";
  const target: DmCallTarget = { serverId, conv, name };
  if (!serverId || !isSewId(conv)) {
    set({ notice: { text: `Couldn't call ${name}.`, retry: null } });
    return { ok: false, code: "usage", raw: "usage", hint: "" };
  }
  const cur = get().active;
  if (isThis(cur, serverId, conv) && !isFinalPhase(cur.phase)) return { ok: true };
  // Another DM call up: it ends with this one (one voice entry per person).
  if (cur && !isFinalPhase(cur.phase) && cur.k2CallId) void apiLeave(scopeFor(cur.serverId), cur.k2CallId);

  // The gate: this server offers Home chat (and so DM calls). Never assumed.
  const scope = scopeFor(serverId);
  let gate = homeChatGateNow(scope);
  if (!gate.offered || homeChatGateStale(scope)) gate = await refreshHomeChatGate(scope);
  if (!gate.offered) {
    const kind = gate.refusal?.kind;
    const raw = !gate.feature
      ? "not_supported"
      : kind === "network" || kind === "not_connected"
        ? "network"
        : kind === "auth"
          ? "auth"
          : "chat_unavailable";
    set({ notice: noticeFor(target, raw, raw, "") });
    return { ok: false, code: "gate", raw, hint: "" };
  }

  // A ring for you in this DM: this join answers it.
  const ringing = get().rings.filter((r) => r.serverId === serverId && r.conv === conv);
  const role: DmCallRole = ringing.length > 0 ? "answerer" : "caller";
  const serverLabel = labelOf(serverId);
  set({
    notice: null,
    rings: get().rings.filter((r) => !(r.serverId === serverId && r.conv === conv)),
    active: {
      ...target,
      serverLabel,
      role,
      phase: "joining",
      k2CallId: null,
      sewCallId: ringing[0]?.callId ?? null,
      ringsAgain: 0,
      endedAt: null,
    },
  });
  const room: CallRoom = { serverId, serverLabel, roomId: dmRoomId(conv), roomName: name, limit: 2, dm: { conv } };
  const out = await useVoiceCall.getState().join(room);
  const a = get().active;
  if (!isThis(a, serverId, conv)) return out;
  if (!out.ok) {
    if (out.code === "superseded") return out;
    set({ active: null, notice: noticeFor(target, out.raw, out.code, out.hint) });
    // Said here, where the person is; not again on the call screen.
    useVoiceCall.getState().clearNotice();
    return out;
  }
  applyIds(await ids.read());
  const after = get().active;
  if (!isThis(after, serverId, conv)) return out;
  if (isFinalPhase(after.phase)) {
    // It ended while the join was in flight (declined, cancelled).
    if (inThisMedia(after)) void useVoiceCall.getState().leave();
    return out;
  }
  const live = get().calls[callKey(serverId, conv)];
  const fits = live && !live.ended && (!after.sewCallId || live.callId === after.sewCallId);
  set({
    active: {
      ...after,
      sewCallId: after.sewCallId ?? (fits ? live.callId : null),
      phase: fits ? phaseFromCall(live, role) : role === "answerer" ? "connected" : "ringing",
    },
  });
  return out;
}

/** Call back (a call's record line) and the Home row's long press. */
export interface CallablePerson {
  /** `k2:owner` or `k2:connect:<uuid>`. */
  ext: string;
  displayName?: string | null;
  username?: string | null;
  /** The DM's conversation id, when the row knows it. */
  conv?: string | null;
}

/** Call a person from their Home row (Riley: calling lives in a long
 *  press; a tap opens the DM). Opens (or makes) the DM first when the row
 *  doesn't know its conversation. */
export async function callPersonFromRow(serverId: string, person: CallablePerson): Promise<DmCallOutcome> {
  const name = person.displayName?.trim() || person.username?.trim() || "them";
  let conv = person.conv?.trim() || "";
  if (!isSewId(conv)) {
    const r = await openHomeChatDm(scopeFor(serverId), person.ext);
    if (!r.ok) {
      const raw = refusalRaw(r);
      set({ notice: noticeFor({ serverId, conv: "", name }, raw, raw, r.hint) });
      return { ok: false, code: "gate", raw, hint: r.hint };
    }
    conv = r.conv;
  }
  return startDmCall(serverId, conv, { name });
}

/** The caller's Cancel, while it rings. With Sew's id: K2's cancel (a real
 *  cancel with Sew's `callCancel`; without it the server leaves instead and
 *  the other person sees a missed call, which the line says). The media
 *  goes either way. */
export async function cancelOutgoingDmCall(): Promise<void> {
  const a = get().active;
  if (!a || a.role !== "caller" || !(a.phase === "joining" || a.phase === "ringing" || a.phase === "busy")) return;
  const live = get().calls[callKey(a.serverId, a.conv)];
  const sewId = a.sewCallId ?? (live && !live.ended ? live.callId : null);
  // The line first; the media only after the cancel, or the server would
  // read the caller leaving as an unanswered call.
  markEnded("cancelled");
  let fellBack = false;
  if (sewId) {
    const r = await apiCancel(scopeFor(a.serverId), a.conv, sewId);
    fellBack = r.ok ? !r.cancelled || r.via === "leave" : !homeChatGateNow(scopeFor(a.serverId)).flags.callCancel;
  } else {
    // No call id yet: the media's leave is all there is. Rung already, the
    // other side sees a missed call.
    fellBack = a.phase !== "joining";
  }
  if (inThisMedia(a)) await useVoiceCall.getState().leave();
  if (a.k2CallId) void apiLeave(scopeFor(a.serverId), a.k2CallId);
  if (fellBack) set({ notice: { text: cancelFellBackText(a.name), retry: null } });
}

/** Ring again, or call again once it ended. */
export async function callAgainDmCall(): Promise<void> {
  const a = get().active;
  if (!a || a.role !== "caller") return;
  if (isFinalPhase(a.phase)) {
    set({ active: null });
    await startDmCall(a.serverId, a.conv, { name: a.name });
    return;
  }
  if (!canRingAgain(a) || !a.sewCallId) return;
  patchActive(a.serverId, a.conv, { ringsAgain: a.ringsAgain + 1 });
  const r = await apiRingAgain(scopeFor(a.serverId), a.conv, a.sewCallId);
  if (!r.ok) {
    const raw = refusalRaw(r);
    set({ notice: noticeFor(a, raw, raw, r.hint) });
    return;
  }
  patchActive(a.serverId, a.conv, { phase: "ringing" });
}

/** "Call again" is offered: ringing out with rings left, or after a
 *  decline or no answer. */
export function canRingAgain(a: ActiveDmCall | null): boolean {
  if (!a || a.role !== "caller") return false;
  if (a.phase === "declined" || a.phase === "missed") return true;
  return (a.phase === "ringing" || a.phase === "busy") && !!a.sewCallId && a.ringsAgain < RING_AGAIN_MAX;
}

/** Hang up a connected DM call (the voice store's leave; K2's record is
 *  left by `followVoice`). */
export async function hangUpDmCall(): Promise<void> {
  const a = get().active;
  if (!a) return;
  if (inThisMedia(a)) await useVoiceCall.getState().leave();
  else set({ active: null });
}

// ─── Rings ───

const ringTimers = new Map<string, ReturnType<typeof setTimeout>>();

function dropRing(key: string): void {
  const t = ringTimers.get(key);
  if (t) clearTimeout(t);
  ringTimers.delete(key);
  if (get().rings.some((r) => r.key === key)) set({ rings: get().rings.filter((r) => r.key !== key) });
}

/** A ring for this person: put the card up (or update it), or take it down. */
export function noteRing(serverId: string, ring: HomeChatRing, callerName?: string | null): void {
  const key = `${serverId}|${ring.callId}`;
  if (!ring.ringing) {
    dropRing(key);
    return;
  }
  const now = Date.now();
  if (ring.expiresAtMs !== null && ring.expiresAtMs <= now) return dropRing(key);
  // Already in (or calling) this DM here: nothing to answer.
  const a = get().active;
  if (isThis(a, serverId, ring.conv) && !isFinalPhase(a.phase)) return;
  const prev = get().rings.find((r) => r.key === key);
  const card: IncomingRing = {
    key,
    serverId,
    serverLabel: labelOf(serverId),
    callId: ring.callId,
    conv: ring.conv,
    callerName: callerName?.trim() || prev?.callerName || "Someone",
    silent: ring.silent,
    expiresAtMs: ring.expiresAtMs,
    busy: prev?.busy ?? null,
  };
  set({ rings: [card, ...get().rings.filter((r) => r.key !== key)] });
  const t = ringTimers.get(key);
  if (t) clearTimeout(t);
  ringTimers.set(
    key,
    setTimeout(() => dropRing(key), Math.max(0, (ring.expiresAtMs ?? now + RING_FALLBACK_MS) - now))
  );
  if (!callerName) void nameRing(key, serverId, ring.startedBy);
}

/** Accept: join `{dm}` (it answers the ring). */
export async function acceptRing(key: string): Promise<DmCallOutcome | null> {
  const r = get().rings.find((x) => x.key === key);
  if (!r || r.busy) return null;
  set({ rings: get().rings.map((x) => (x.key === key ? { ...x, busy: "accepting" } : x)) });
  const out = await startDmCall(r.serverId, r.conv, { name: r.callerName });
  dropRing(key);
  return out;
}

/** Decline: `decline {dm, callId}` with Sew's call id. A failed decline
 *  keeps the card (try again); a call that's already gone takes it down. */
export async function declineRing(key: string): Promise<void> {
  const r = get().rings.find((x) => x.key === key);
  if (!r || r.busy) return;
  set({ rings: get().rings.map((x) => (x.key === key ? { ...x, busy: "declining" } : x)) });
  const res = await apiDecline(scopeFor(r.serverId), r.conv, r.callId);
  if (res.ok || res.kind === "not_found") {
    dropRing(key);
    return;
  }
  set({
    rings: get().rings.map((x) => (x.key === key ? { ...x, busy: null } : x)),
    notice: { text: `Couldn't decline the call from ${r.callerName}. Try again.`, retry: null },
  });
}

// ─── Frames ───

/** A DM call as every member sees it. */
export function noteCallUpdated(serverId: string, call: HomeChatCall): void {
  set({ calls: { ...get().calls, [callKey(serverId, call.conv)]: call } });
  if (call.ended) {
    for (const r of get().rings) if (r.serverId === serverId && r.callId === call.callId) dropRing(r.key);
  }
  const a = get().active;
  if (!isThis(a, serverId, call.conv) || isFinalPhase(a.phase)) return;
  if (a.sewCallId && a.sewCallId !== call.callId) return; // an older call in that DM
  if (!a.sewCallId && call.ended) return; // an older call's end, before this one's id
  const phase = phaseFromCall(call, a.role);
  if (call.ended) {
    set({ active: { ...a, sewCallId: call.callId } });
    endActive(phase);
    return;
  }
  // While the join is in flight, the join's answer decides the phase.
  set({ active: { ...a, sewCallId: call.callId, phase: a.phase === "joining" ? "joining" : phase } });
}

/** One Home chat frame from `serverId`'s socket. */
export function onHomeChatCallFrame(serverId: string, frame: HomeChatFrame): void {
  switch (frame.type) {
    case "hello": {
      // The rings going now replace what this server's cards said.
      const live = new Set(frame.rings.map((r) => `${serverId}|${r.callId}`));
      for (const r of get().rings) if (r.serverId === serverId && !live.has(r.key)) dropRing(r.key);
      for (const c of frame.calls) if (c.call) noteCallUpdated(serverId, c.call);
      for (const ring of frame.rings) noteRing(serverId, ring);
      return;
    }
    case "call_ring":
      noteRing(serverId, frame.ring);
      return;
    case "call_updated":
      noteCallUpdated(serverId, frame.call);
      return;
    default:
      return;
  }
}

// ─── Push ───

/** A call push's data (all strings), as the tap and `callPush` carry it. */
export interface CallPushData {
  kind?: string;
  callId?: string;
  conversationId?: string;
  callState?: string;
  /** The saved server whose key opened the sealed push (K2PushSealed). */
  k2ServerId?: string;
  subdomain?: string;
  badgeKey?: string;
  instanceId?: string;
  /** The notification's title: the caller's name. */
  title?: string;
  /** A button: `accept`, or a `decline` the native side couldn't send. */
  action?: string;
}

function savedServer(id: string | undefined, known: (id: string) => boolean): string | null {
  return id && known(id) ? id : null;
}

/** A call push while the app is in front (no banner): a ring card if the
 *  socket hasn't put one up, or the card down on the replacing push. */
export function noteCallPush(data: CallPushData, known: (id: string) => boolean): void {
  if (data.kind !== "call") return;
  const serverId = savedServer(data.k2ServerId, known);
  const callId = asSewCallId(data.callId);
  const conv = data.conversationId?.trim() ?? "";
  if (!serverId || !callId || !isSewId(conv)) return;
  if (data.callState === "ringing") {
    if (get().rings.some((r) => r.key === `${serverId}|${callId}`)) return;
    noteRing(
      serverId,
      { callId, conv, startedBy: null, ringing: true, silent: false, reason: null, expiresAtMs: null },
      data.title && data.title !== "K2" ? data.title : null
    );
    return;
  }
  dropRing(`${serverId}|${callId}`);
}

/** A call notification's tap or button. `resolve` finds the saved server
 *  the push names (push.ts `resolveTapServer`) when the sealed push's own
 *  key doesn't. Accept joins `{dm}`; a decline the native side couldn't
 *  send goes here; a tap opens the DM. */
export async function routeCallTap(
  tap: CallPushData,
  resolve: () => Promise<string | null>,
  known: (id: string) => boolean
): Promise<void> {
  const conv = tap.conversationId?.trim() ?? "";
  if (!isSewId(conv)) return;
  const serverId = savedServer(tap.k2ServerId, known) ?? (await resolve().catch(() => null));
  if (!serverId) return;
  const callId = asSewCallId(tap.callId);
  const name = tap.title && tap.title !== "K2" ? tap.title : null;
  if (tap.action === "accept") {
    // The ring may have stopped meanwhile: the join then rings them back.
    await startDmCall(serverId, conv, { name });
    return;
  }
  if (tap.action === "decline") {
    if (callId) {
      await apiDecline(scopeFor(serverId), conv, callId);
      dropRing(`${serverId}|${callId}`);
    }
    return;
  }
  requestOpenHomeChat(serverId, conv, "call-push");
}

/** The native join's ids as they come (installed by the watch). */
export function followNativeDmIds(): () => void {
  followVoice();
  return ids.listen(applyIds);
}

// ─── Tests ───

export function __setDmIdsSourceForTests(next: IdsSource | null): void {
  ids = next ?? { read: readDmCallIds, listen: listenDmCallIds };
}

export function __resetDmCallsForTests(): void {
  for (const t of ringTimers.values()) clearTimeout(t);
  ringTimers.clear();
  people.clear();
  useDmCalls.setState({ ...EMPTY });
}
