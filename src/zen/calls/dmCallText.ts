import { joinErrorText, type VoiceErrorCode } from "../voice/voiceWire";

// DM calls' words (K2 0.46.13, brief §3): the gates and the call's ends as
// plain lines. Pure.

/** Refusals worth a "Try again": the server's voice lane restarting, a
 *  login still being set up, or no answer in time. */
const RETRYABLE = new Set([
  "voice_unavailable",
  "unavailable",
  "member_pending",
  "voice_member_pending",
  "chat_member_pending",
  "join_timeout",
  "network",
  "retry",
]);

export function dmCallRetryable(raw: string, code?: string): boolean {
  return RETRYABLE.has(raw) || (code !== undefined && RETRYABLE.has(code));
}

/** Why calling `name` on `serverLabel` didn't start. `raw` is the server's
 *  own code (or the engine's), `code` the voice rooms' reading of it. */
export function dmJoinErrorText(
  raw: string,
  code: VoiceErrorCode | string,
  name: string,
  serverLabel: string,
  hint = ""
): string {
  const where = serverLabel || "that server";
  switch (raw) {
    case "host_not_pro":
    case "plan":
      return "Calls need the Pro plan on that server.";
    case "voice_unavailable":
    case "unavailable":
      return `Calls on ${where} are restarting. Try again in a moment.`;
    case "chat_unavailable":
    case "home_chat_off":
    case "off":
      return `Calls aren't available on ${where} right now.`;
    case "dm_not_found":
    case "not_found":
      return `Your conversation with ${name} isn't on ${where}.`;
    case "not_supported":
      return `${where} is running an older K2 that can't make calls. Ask its owner to update it.`;
    case "member_pending":
    case "voice_member_pending":
    case "chat_member_pending":
      return `K2 is still setting up your login on ${where}. Try again in a moment.`;
    case "e2ee_unsupported":
      return "This build of K2 can't make calls yet.";
    case "network":
    case "not_connected":
      return `Can't reach ${where}. Check your connection and try again.`;
    case "join_timeout":
      return `${where} didn't answer in time. Try again in a moment.`;
    case "signin_required":
    case "unauthenticated":
    case "auth":
      return `Sign in to ${where} again to call.`;
    case "device_session_ended":
      return `This phone was signed out of ${where}. Pair it again to call.`;
  }
  switch (code) {
    case "unknown":
      return hint ? `Couldn't call ${name}: ${hint}` : `Couldn't call ${name}.`;
    case "e2ee_unsupported":
      return "This build of K2 can't make calls yet.";
    case "mic_denied":
    case "mic_unavailable":
    case "e2ee_refused":
    case "turn_unreachable":
    case "server_too_old":
    case "media_path_down":
    case "owner_token_cannot_join":
      return joinErrorText(code, name, where, 2, hint);
    default:
      return hint ? `Couldn't call ${name}: ${hint}` : `Couldn't call ${name}.`;
  }
}

/** Why a DM call's media ended, when the person didn't hang up. */
export function dmCallEndedText(reason: string, name: string, serverLabel: string): string {
  const where = serverLabel || "the server";
  switch (reason) {
    case "network":
    case "disconnected":
      return `The call with ${name} dropped: the connection was lost.`;
    case "unavailable":
      return `The call with ${name} ended: K2 lost contact with ${where}.`;
    case "e2ee_refused":
      return `The call with ${name} ended: the secure connection failed.`;
    case "session_revoked":
    case "signed_out":
    case "signin_required":
      return `You were signed out of ${where}.`;
    case "device_session_ended":
      return `This phone was signed out of ${where}. Pair it again to call.`;
    default:
      return `The call with ${name} ended.`;
  }
}

/** The caller's bar: what the other side is doing. */
export type CallingState = "joining" | "ringing" | "busy" | "declined" | "missed" | "cancelled" | "ended";

export function callingLine(state: CallingState, name: string): string {
  switch (state) {
    case "joining":
      return `Calling ${name}…`;
    case "ringing":
      return `Calling ${name}… Ringing`;
    case "busy":
      return `${name} is on another call`;
    case "declined":
      return `${name} declined`;
    case "missed":
      return `${name} didn't answer`;
    case "cancelled":
      return "Cancelled";
    case "ended":
      return "Call ended";
  }
}

/** Cancel without Sew's `callCancel`: the server left instead, and the
 *  other person sees a missed call. */
export function cancelFellBackText(name: string): string {
  return `Cancelled. ${name} will see a missed call: this server can't take a ring back yet.`;
}

/** What a ring stop or a call's end says on the caller's side. */
export function endReasonState(endReason: string | null): Extract<CallingState, "declined" | "missed" | "cancelled" | "ended"> {
  switch (endReason) {
    case "declined":
      return "declined";
    case "no_answer":
    case "timeout":
    case "missed":
    case "call_missed":
      return "missed";
    case "cancelled":
      return "cancelled";
    default:
      return "ended";
  }
}
