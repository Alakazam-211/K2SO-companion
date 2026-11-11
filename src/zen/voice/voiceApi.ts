import type { ServerScope } from "../../api/scope";
import { scopedFetch } from "../../api/scopedFetch";
import { parseRecordingControlsAnswer, parseVoiceRooms, type RecordingControlsAnswer, type VoiceRoomsList } from "./voiceWire";

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

/** `voice_rooms_changed {rev}`: re-read the list. */
export function isVoiceRoomsChanged(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "voice_rooms_changed";
}

export type RecordingControlsResult =
  | { ok: true; answer: RecordingControlsAnswer }
  /** `unsupported`: a K2 before 0.46.11 (no route): no Record button. */
  | { ok: false; code: "unsupported" | "failed" };

/** `POST /cli/voice/recording/controls {room}` (K2 0.46.11): the person's
 *  own rights in the room, for the plugin's Record and Stop. No boot flag:
 *  an older server answers 404. */
export async function fetchRecordingControls(scope: ServerScope, roomId: string): Promise<RecordingControlsResult> {
  try {
    const out = await scopedFetch(scope, "/cli/voice/recording/controls", {
      method: "POST",
      body: JSON.stringify({ room: roomId }),
      headers: { "Content-Type": "application/json" },
      priority: "user",
    });
    if (out.status === 404 || out.status === 405) return { ok: false, code: "unsupported" };
    if (!out.ok) return { ok: false, code: "failed" };
    return { ok: true, answer: parseRecordingControlsAnswer(JSON.parse(out.text), roomId) };
  } catch {
    return { ok: false, code: "failed" };
  }
}
