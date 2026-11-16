import type { ServerScope } from "../../api/scope";
import { scopedFetch } from "../../api/scopedFetch";
import { parseVoiceRooms, type VoiceRoomsList } from "./voiceWire";

// The rooms list, read from each hosting server with its own login (as Home
// gathers agents). Joining, renewal and leaving don't come through here: the
// native engine's join provider makes those calls, so no media token or call
// credential ever reaches the webview (K2's PRD §14.4).

export const FEATURE_VOICE_ROOMS = "voice-rooms-v1";

export type VoiceRoomsResult =
  | { ok: true; list: VoiceRoomsList }
  | { ok: false; code: "unreachable" | "signin_required" | "device_session_ended" | "failed"; status: number };

export async function fetchVoiceRooms(scope: ServerScope): Promise<VoiceRoomsResult> {
  try {
    const out = await scopedFetch(scope, "/cli/voice/rooms", { method: "GET", priority: "background" });
    if (!out.ok) {
      // A paired phone's session ended: "Pair again", never a sign-in (K2 0.46.9).
      if (out.status === 403 && /device_session_ended/.test(out.text)) {
        return { ok: false, code: "device_session_ended", status: 403 };
      }
      return {
        ok: false,
        code: out.status === 401 || out.status === 403 ? "signin_required" : "failed",
        status: out.status,
      };
    }
    return { ok: true, list: parseVoiceRooms(JSON.parse(out.text)) };
  } catch {
    return { ok: false, code: "unreachable", status: 0 };
  }
}

/** A session leave's own deadline: it never holds the UI up. */
export const SESSION_LEAVE_TIMEOUT_MS = 8_000;

/** K2's call ids are `vc_…` (Sew's are digits: never these). */
export function isK2CallId(v: unknown): v is string {
  return typeof v === "string" && /^vc_[A-Za-z0-9_-]+$/.test(v);
}

/** `POST /cli/voice/session/leave {callId}` after the engine left a room
 *  or a DM call (K2's answers §4): ends K2's record of this login's call,
 *  and Sew's seat if Sew still has one. Idempotent (`already: true` is a
 *  success). Never without K2's `vc_…` id: without one K2 leaves whatever
 *  call the person is in, which could be their desktop's. Fire and forget:
 *  `true` when K2 took it. */
export async function leaveVoiceSession(scope: ServerScope, callId: string): Promise<boolean> {
  if (!isK2CallId(callId)) return false;
  try {
    const out = await scopedFetch(scope, "/cli/voice/session/leave", {
      method: "POST",
      body: JSON.stringify({ callId }),
      priority: "background",
      timeoutMs: SESSION_LEAVE_TIMEOUT_MS,
    });
    return out.ok;
  } catch {
    return false;
  }
}

/** `voice_rooms_changed {rev}`: re-read the list. */
export function isVoiceRoomsChanged(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "voice_rooms_changed";
}
