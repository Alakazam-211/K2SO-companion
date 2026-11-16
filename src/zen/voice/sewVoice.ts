import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isIosWebView } from "../../lib/nativePicker";
import { shareOrSaveBytes, type ShareOutcome } from "../files/shareFile";
import type { CameraAsk, ConsentSheet, EngineEvents, EngineNow, PhoneVoiceEngine, SelfFlags } from "./voiceCall";
import { nativeJoinErrorCode } from "./voiceWire";
import { applyNoiseRemoval, type NoiseRemovalState } from "./noiseRemoval";

// The call engine in this build (iOS): Sew's native voice plugin, in Rust
// (src-tauri/src/voice.rs). Rust drives the system call (CallKit) and joins
// with the Keychain's token; the webview only asks and follows:
//   - commands `plugin:sew-voice|join` / `leave` / `mute` / `consent`;
//   - events `sew-voice://state` (the call), `sew-voice://participants`
//     (your own mute and deafen, which the system's button or a moderator
//     can change; the call tile's buttons send `mute {muted?, deafened?}`),
//     `k2-voice://consent` (the recording notice, already in the kit's words)
//     and `k2-voice://video` (the call has video: Sew's `video_changed`);
//   - "Join with camera": `camera_permission` / `request_camera_permission`
//     (the plugin never prompts on its own), then K2's `voice_join_camera`
//     (Sew's `join_with`: CallKit starts a video call);
//   - noise removal (Settings → Calls): `set_noise_removal {mode}` before
//     each join (noiseRemoval.ts), and `sew-voice://noise_removal` into the
//     call log (which model runs, and why it stepped down).

const CMD = "plugin:sew-voice|";

type StatePayload = { state?: string; reason?: string };

/** The plugin's `ErrorInfo`: `{code, message?, detail?}`. `raw` keeps the
 *  server's own code (a DM call's `chat_unavailable`, `dm_not_found`, …),
 *  which the voice rooms' codes fold into `unknown`. */
export function joinError(err: unknown): { code: string; hint?: string; raw: string } {
  const e = err && typeof err === "object" ? (err as { code?: unknown; detail?: unknown }) : {};
  const code = typeof e.code === "string" ? e.code : "unknown";
  const detail = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : null;
  const hint = typeof detail?.hint === "string" ? detail.hint : undefined;
  return { code: nativeJoinErrorCode(code, detail), ...(hint ? { hint } : {}), raw: code };
}

/** A DM call's ids once its native join is taken (Rust `voice.rs`
 *  `dm_call_ids`): K2's `vc_…` call record (leave) and Sew's call (cancel,
 *  ring again). Ids only. */
export type NativeDmCallIds = { room: string; dm: string; callId: string | null; sewCallId: string | null };

export function parseDmCallIds(v: unknown): NativeDmCallIds | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.room !== "string" || typeof o.dm !== "string" || !o.dm) return null;
  return {
    room: o.room,
    dm: o.dm,
    callId: typeof o.callId === "string" && o.callId ? o.callId : null,
    sewCallId: typeof o.sewCallId === "string" && o.sewCallId ? o.sewCallId : null,
  };
}

/** The last join's DM call ids (`null`: a voice room, none, or no native engine). */
export async function readDmCallIds(): Promise<NativeDmCallIds | null> {
  if (!isIosWebView()) return null;
  try {
    return parseDmCallIds(await invoke<unknown>("voice_dm_call"));
  } catch {
    return null;
  }
}

/** Hear each DM call join's ids (`k2-voice://dm-call`). */
export function listenDmCallIds(fn: (ids: NativeDmCallIds | null) => void): () => void {
  if (!isIosWebView()) return () => {};
  let off: UnlistenFn | null = null;
  let stopped = false;
  void listen<unknown>("k2-voice://dm-call", ({ payload }) => fn(parseDmCallIds(payload))).then(
    (u) => {
      if (stopped) u();
      else off = u;
    },
    () => {}
  );
  return () => {
    stopped = true;
    off?.();
  };
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

/** One row of the plugin's roster (`Participant`, wire.rs). */
type Row = {
  is_self?: boolean;
  muted?: boolean;
  deafened?: boolean;
  server_muted?: boolean;
  server_deafened?: boolean;
  speak_denied?: boolean;
};

type Snapshot = {
  state?: string;
  reason?: string;
  target?: string;
  room?: string;
  participants?: Row[];
  has_video?: boolean;
};

/** Your own row's deafen and what a moderator (or a lost SPEAK) holds. */
export function selfFlags(me: Row): SelfFlags {
  return {
    deafened: me.deafened === true,
    muteLocked: me.server_muted === true || me.speak_denied === true,
    deafLocked: me.server_deafened === true,
  };
}

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
  const flags = me ? selfFlags(me) : null;
  return {
    state,
    ...(typeof s.reason === "string" ? { reason: s.reason } : {}),
    ...(typeof s.target === "string" ? { serverId: s.target } : {}),
    ...(typeof s.room === "string" ? { roomId: s.room } : {}),
    muted: me?.muted === true || me?.deafened === true,
    consent: parseConsentSheet(consent),
    ...(s.has_video === true ? { video: true } : {}),
    ...(flags?.deafened ? { deafened: true } : {}),
    ...(flags?.muteLocked ? { muteLocked: true } : {}),
    ...(flags?.deafLocked ? { deafLocked: true } : {}),
  };
}

/** The camera permission as the plugin reports it. */
type CameraPermission = "granted" | "denied" | "prompt" | "unsupported";

/** Read the camera permission and, never asked, ask (iOS's prompt). Only
 *  from the person's own tap. The kit's own gate (`ensureCameraPermission`)
 *  does the same for the call screen's camera button. */
export async function askCamera(): Promise<CameraAsk> {
  let p: CameraPermission;
  try {
    p = await invoke<CameraPermission>(`${CMD}camera_permission`);
  } catch {
    // An older plugin: the join's camera says itself.
    return { ok: true };
  }
  if (p === "prompt") {
    try {
      p = await invoke<CameraPermission>(`${CMD}request_camera_permission`);
    } catch {
      p = "prompt";
    }
  }
  if (p === "granted" || p === "unsupported") return { ok: true };
  return { ok: false, code: p === "denied" ? "camera_permission_denied" : "camera_permission_not_determined" };
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

/** The noise removal state as call log codes: `noise standard standard dfn3`. */
export function noiseWords(s: NoiseRemovalState | null | undefined): string[] | null {
  if (!s || typeof s !== "object" || typeof s.mode !== "string") return null;
  const words = ["noise", s.mode, String(s.active ?? "")];
  if (s.model) words.push(s.model);
  if (s.reason) words.push(`reason:${s.reason}`);
  if (s.model_reason) words.push(`model_reason:${s.model_reason}`);
  if (s.step_downs) words.push(`step_downs:${s.step_downs}`);
  return words;
}

function noteNoise(s: NoiseRemovalState | null | undefined): void {
  const words = noiseWords(s);
  if (words) void invoke("voice_note", { words }).catch(() => {});
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
      listen<unknown>("k2-voice://video", ({ payload }) => events?.onVideo?.(payload === true)),
      listen<NoiseRemovalState>("sew-voice://noise_removal", ({ payload }) => noteNoise(payload)),
      listen<Row[]>("sew-voice://participants", ({ payload }) => {
        const me = Array.isArray(payload) ? payload.find((p) => p?.is_self) : undefined;
        if (me) events?.onSelfMute?.(me.muted === true || me.deafened === true, selfFlags(me));
      }),
    ]);
    return listening;
  }

  return {
    available: true,
    drivesSystemCall: true,
    cameraJoin: true,
    async join(serverId, roomId, e, options) {
      events = e;
      await follow();
      // The person's choice, set before the call starts (on Android, Off at
      // the start is what turns off the system's own noise suppression).
      noteNoise(await applyNoiseRemoval());
      try {
        if (options?.camera) await invoke("voice_join_camera", { target: serverId, room: roomId });
        else await invoke(`${CMD}join`, { target: serverId, room: roomId });
      } catch (err) {
        throw joinError(err);
      }
    },
    cameraPermission: askCamera,
    async leave() {
      await invoke(`${CMD}leave`).catch(() => {});
    },
    setMuted(muted) {
      void invoke(`${CMD}mute`, { muted }).catch(() => {});
    },
    setDeafened(deafened, muted) {
      void invoke(`${CMD}mute`, muted === undefined ? { deafened } : { muted, deafened }).catch(() => {});
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
