import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { scopeFor } from "../../api/scope";
import { fetchRecordingControls } from "./voiceApi";
import { recordingErrorText } from "./voiceWire";

// Record and Stop in a call (K2 0.46.11, Sew 0.9.2; Rosson 2026-11-11: as
// K2 desktop). Sew's plugin (0.6.1) decides which of the two to show from
// the rights K2 hands it: the phone reads them (`POST
// /cli/voice/recording/controls`), passes them on unchanged
// (`set_recording_rights`), and follows the plugin's `recording_controls`
// event (before its first one, the `recording` event's `can_record` /
// `can_stop`). K2 adds no rule of its own; no word from the plugin shows
// neither. Record and Stop go back through the plugin to the native join
// provider (voice.rs `recording`), which posts them to K2 with the phone's
// token. A K2 before 0.46.11 answers 404: no buttons.
//
// Rights are read again (as desktop's readRecordingPerms): on connecting,
// when the call's room changes (a moderator's move: the plugin forgets the
// old room's rights), and whenever the call's recording changes.

const CMD = "plugin:sew-voice|";

export type RecordingButtons = { canRecord: boolean; canStop: boolean };

/** The call's active recording (the plugin's `recording` event), as the
 *  call screen shows it. */
export type CallRecordingNow = {
  recordingId: string;
  /** Sew Notes is in the call's media: recording now. */
  live: boolean;
  required: boolean;
  canRecord: boolean;
  canStop: boolean;
};

type CallRecording = {
  /** The plugin's last `recording_controls` (null until its first). */
  controls: RecordingButtons | null;
  recording: CallRecordingNow | null;
  /** No Record or Stop here: an older K2, or a Voice & Chat only login. */
  off: boolean;
  /** Record or Stop on its way. */
  busy: boolean;
  /** A refusal to show, in K2's words. */
  error: string | null;
};

const CLEAN: CallRecording = { controls: null, recording: null, off: false, busy: false, error: null };

export const useCallRecording = create<CallRecording>(() => ({ ...CLEAN }));

/** A call ended or a new one starts: nothing carries over. */
export function resetCallRecording(): void {
  useCallRecording.setState({ ...CLEAN });
}

/** The plugin's `recording_controls` payload. */
export function parseRecordingControls(v: unknown): RecordingButtons | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.can_record !== "boolean" || typeof r.can_stop !== "boolean") return null;
  return { canRecord: r.can_record, canStop: r.can_stop };
}

/** The plugin's `recording` payload (null: no active recording). */
export function parseCallRecording(v: unknown): CallRecordingNow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.recording_id !== "string") return null;
  return {
    recordingId: r.recording_id,
    live: r.recorder_present === true,
    required: r.required === true,
    canRecord: r.can_record === true,
    canStop: r.can_stop === true,
  };
}

/** Which of Record and Stop to show (desktop's `recordingButtons`). */
export function recordingButtons(s: Pick<CallRecording, "controls" | "recording" | "off">): RecordingButtons {
  if (s.off) return { canRecord: false, canStop: false };
  if (s.controls) return s.controls;
  return { canRecord: s.recording?.canRecord === true, canStop: s.recording?.canStop === true };
}

export function onRecordingControls(v: unknown): void {
  const c = parseRecordingControls(v);
  if (c) useCallRecording.setState({ controls: c });
}

export function onRecordingEvent(v: unknown): void {
  useCallRecording.setState({ recording: parseCallRecording(v) });
}

/** Read this person's rights in the room and hand them to the plugin. A
 *  failed read leaves the buttons as they are; Sew still decides. */
export async function readRecordingRights(serverId: string, roomId: string): Promise<void> {
  const r = await fetchRecordingControls(scopeFor(serverId), roomId);
  if (!r.ok) {
    if (r.code === "unsupported") useCallRecording.setState({ off: true });
    return;
  }
  if (r.answer.voiceChatOnly || !r.answer.rights) {
    useCallRecording.setState({ off: r.answer.voiceChatOnly });
    return;
  }
  useCallRecording.setState({ off: false });
  try {
    await invoke(`${CMD}set_recording_rights`, { ...r.answer.rights });
  } catch {
    // The plugin refused them (not in that room any more): the next read
    // after the move or the recording's change tries again.
  }
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "failed";
}

/** Record or Stop, the person's own act (Sew decides who may). */
export async function recordingCommand(what: "start" | "stop"): Promise<void> {
  if (useCallRecording.getState().busy) return;
  useCallRecording.setState({ busy: true, error: null });
  try {
    await invoke(`${CMD}${what === "start" ? "start_recording" : "stop_recording"}`);
    useCallRecording.setState({ busy: false });
  } catch (err) {
    useCallRecording.setState({ busy: false, error: recordingErrorText(what, codeOf(err)) });
  }
}
