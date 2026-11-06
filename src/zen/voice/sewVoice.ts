import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isIosWebView } from "../../lib/nativePicker";
import { shareOrSaveBytes, type ShareOutcome } from "../files/shareFile";
import type { ConsentSheet, EngineEvents, EngineNow, PhoneVoiceEngine } from "./voiceCall";
import { nativeJoinErrorCode } from "./voiceWire";

// The call engine in this build (iOS): Sew's native voice plugin, in Rust
// (src-tauri/src/voice.rs). Rust drives the system call (CallKit) and joins
// with the Keychain's token; the webview only asks and follows:
//   - commands `plugin:sew-voice|join` / `leave` / `mute` / `consent`;
//   - events `sew-voice://state` (the call), `sew-voice://participants`
//     (your own mute, which the system's button can change) and
//     `k2-voice://consent` (the recording notice, already in the kit's words).

const CMD = "plugin:sew-voice|";

type StatePayload = { state?: string; reason?: string };

/** The plugin's `ErrorInfo`: `{code, message?, detail?}`. */
function joinError(err: unknown): { code: string; hint?: string } {
  const e = err && typeof err === "object" ? (err as { code?: unknown; detail?: unknown }) : {};
  const code = typeof e.code === "string" ? e.code : "unknown";
  const detail = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : null;
  const hint = typeof detail?.hint === "string" ? detail.hint : undefined;
  return { code: nativeJoinErrorCode(code, detail), ...(hint ? { hint } : {}) };
}

export function parseConsentSheet(body: unknown): ConsentSheet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string" || typeof b.text !== "string" || typeof b.noticeVersion !== "number") return null;
  const choices = Array.isArray(b.choices)
    ? b.choices.flatMap((c) => {
        const x = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
        if (typeof x.label !== "string") return [];
        return [{ label: x.label, granted: typeof x.granted === "boolean" ? x.granted : null }];
      })
    : [];
  if (choices.length === 0) return null;
  return {
    ask: b.ask === "join" ? "join" : "in_call",
    ...(typeof b.recordingId === "string" ? { recordingId: b.recordingId } : {}),
    noticeVersion: b.noticeVersion,
    title: b.title,
    text: b.text,
    choices,
  };
}

type Snapshot = {
  state?: string;
  reason?: string;
  target?: string;
  room?: string;
  participants?: { is_self?: boolean; muted?: boolean; deafened?: boolean }[];
};

/** The plugin's `state` answer as the store reads it. */
export function parseSnapshot(snap: unknown, consent: unknown): EngineNow {
  const s = snap && typeof snap === "object" ? (snap as Snapshot) : {};
  const state =
    s.state === "connecting" || s.state === "connected" || s.state === "reconnecting" || s.state === "ended"
      ? s.state
      : s.state === "consent_required"
        ? "held"
        : "idle";
  const me = Array.isArray(s.participants) ? s.participants.find((p) => p?.is_self) : undefined;
  return {
    state,
    ...(typeof s.reason === "string" ? { reason: s.reason } : {}),
    ...(typeof s.target === "string" ? { serverId: s.target } : {}),
    ...(typeof s.room === "string" ? { roomId: s.room } : {}),
    muted: me?.muted === true || me?.deafened === true,
    consent: parseConsentSheet(consent),
  };
}

/** The engine says `left` for any leave: K2's own (a held re-join nobody
 *  answered) has its reason in Rust. */
export async function endReason(reason: string | undefined): Promise<string | undefined> {
  if (reason !== "left") return reason;
  try {
    const why = await invoke<unknown>("voice_ended_why");
    return typeof why === "string" && why ? why : reason;
  } catch {
    return reason;
  }
}

/** "Send call log": the last call events (codes and times only) to the
 *  Share sheet as a text file. */
export async function shareCallLog(): Promise<ShareOutcome> {
  let text: string;
  try {
    text = await invoke<string>("voice_call_log");
  } catch {
    return "failed";
  }
  if (!text) return "failed";
  return shareOrSaveBytes(new TextEncoder().encode(text), "K2 call log.txt", "text/plain");
}

export function sewVoiceEngine(): PhoneVoiceEngine {
  let events: EngineEvents | null = null;
  let listening: Promise<UnlistenFn[]> | null = null;

  function follow(): Promise<UnlistenFn[]> {
    listening ??= Promise.all([
      listen<StatePayload>("sew-voice://state", ({ payload }) => {
        const s = payload?.state;
        if (s === "connecting" || s === "connected" || s === "reconnecting") events?.onState(s);
        else if (s === "consent_required") events?.onState("held");
        else if (s === "ended") {
          const e = events;
          void endReason(payload.reason).then((why) => e?.onState("ended", why));
        }
      }),
      listen<unknown>("k2-voice://consent", ({ payload }) => events?.onConsent?.(parseConsentSheet(payload))),
      listen<{ is_self?: boolean; muted?: boolean; deafened?: boolean }[]>(
        "sew-voice://participants",
        ({ payload }) => {
          const me = Array.isArray(payload) ? payload.find((p) => p?.is_self) : undefined;
          if (me) events?.onSelfMute?.(me.muted === true || me.deafened === true);
        }
      ),
    ]);
    return listening;
  }

  return {
    available: true,
    drivesSystemCall: true,
    async join(serverId, roomId, e) {
      events = e;
      await follow();
      try {
        await invoke(`${CMD}join`, { target: serverId, room: roomId });
      } catch (err) {
        throw joinError(err);
      }
    },
    async leave() {
      await invoke(`${CMD}leave`).catch(() => {});
    },
    setMuted(muted) {
      void invoke(`${CMD}mute`, { muted }).catch(() => {});
    },
    async consent(granted, noticeVersion) {
      await invoke(`${CMD}consent`, { granted, notice_version: noticeVersion });
    },
    // Rust hears the system call itself.
    system: () => {},
    async resync(e) {
      events = e;
      await follow();
      try {
        const [snap, consent] = await Promise.all([invoke(`${CMD}state`), invoke("voice_consent")]);
        const now = parseSnapshot(snap, consent);
        return now.state === "ended" ? { ...now, reason: await endReason(now.reason) } : now;
      } catch {
        return null;
      }
    },
  };
}

/** This build's engine, where it has one. */
export function phoneVoiceEngine(): PhoneVoiceEngine | null {
  return isIosWebView() ? sewVoiceEngine() : null;
}
