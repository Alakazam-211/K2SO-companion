import { create } from "zustand";
import { callShim, type CallShim, type ShimEvent } from "./callShim";
import {
  callEndedText,
  cameraRefusalText,
  joinErrorText,
  MIC_DENIED_LINE,
  type CameraRefusal,
  type VoiceErrorCode,
} from "./voiceWire";

// The phone's one voice-room call (rooms only for now: Rosson 2026-11-04).
// The engine is the truth (Sew's sew-call-client over K2's kessel-audio, in
// Rust); this store mirrors it for the UI and keeps the system call UI
// (CallKit) in step, in both directions:
//   - Join starts the system call first: CallKit owns the audio session and
//     activates it, and the engine starts audio only then.
//   - The engine's state goes to the system call (connecting, connected,
//     reconnecting, ended).
//   - The system's End and Mute come back as requests the engine carries out.
// With the native engine (this build on iOS: Sew's plugin, `sewVoice.ts`)
// Rust does both directions itself, so a call keeps working with the
// webview asleep; the store then only names the call for the system UI,
// asks for the microphone, and follows.

export type CallPhase = "idle" | "joining" | "connected" | "reconnecting";

/** `held`: a recorded room waits for the person's answer (no mic yet). */
export type EngineState = "connecting" | "connected" | "reconnecting" | "held" | "ended";

/** A recording notice waiting for an answer, in Sew's kit's words. */
export type ConsentSheet = {
  /** `join`: the join is held; `in_call`: a recording started mid-call. */
  ask: "join" | "in_call";
  /** Sew's recording id (with the version: which notice this is). */
  recordingId?: string;
  noticeVersion: number;
  title: string;
  text: string;
  /** In order; `granted: null` gives up the held join. */
  choices: { label: string; granted: boolean | null }[];
};

/** Which notice a sheet is (`null`: none): a new recording or version is
 *  a new key, the same notice read again is not. */
export function consentKey(sheet: ConsentSheet | null): string | null {
  return sheet ? `${sheet.recordingId ?? ""}:${sheet.ask}:${sheet.noticeVersion}` : null;
}

/** Your own call state past the mic: deafened, and what a moderator (or a
 *  lost SPEAK) holds, which no button of yours can undo. */
export type SelfFlags = {
  deafened: boolean;
  /** Muted by a moderator, or no SPEAK here: no unmute. */
  muteLocked: boolean;
  /** Deafened by a moderator: no undeafen. */
  deafLocked: boolean;
};

const NO_FLAGS: SelfFlags = { deafened: false, muteLocked: false, deafLocked: false };

export type EngineEvents = {
  onState(s: EngineState, reason?: string): void;
  onConsent?(sheet: ConsentSheet | null): void;
  /** Your own mute, from any source (the system's button, a moderator);
   *  `flags` from an engine that knows them. */
  onSelfMute?(muted: boolean, flags?: SelfFlags): void;
  /** The call has video (a camera or a shared screen), or no longer. */
  onVideo?(on: boolean): void;
};

/** How a join starts: `camera`, your camera on once connected and in front. */
export type JoinOptions = { camera?: boolean };

/** The camera permission, asked if never asked: granted, or the refusal. */
export type CameraAsk = { ok: true } | { ok: false; code: CameraRefusal };

export interface PhoneVoiceEngine {
  /** False until this build carries call audio. */
  readonly available: boolean;
  /** The engine starts and updates the system call itself (native). */
  readonly drivesSystemCall?: boolean;
  /** "Join with camera": the engine can join with the camera on. */
  readonly cameraJoin?: boolean;
  /** Resolves once the join was taken (held or in); rejects with `{code, hint?}`. */
  join(serverId: string, roomId: string, events: EngineEvents, options?: JoinOptions): Promise<void>;
  /** The camera permission, showing the system's prompt the first time:
   *  only from the person's own tap. */
  cameraPermission?(): Promise<CameraAsk>;
  leave(): Promise<void>;
  setMuted(muted: boolean): void;
  /** Deafen or undeafen (`muted`: the mic as well, in the same step). */
  setDeafened?(deafened: boolean, muted?: boolean): void;
  /** The person's answer to the recording notice. */
  consent?(granted: boolean, noticeVersion: number): Promise<void>;
  /** The audio session and interruptions (kessel-audio's phone hooks). */
  system(e: ShimEvent): void;
  /** The call as the engine has it now, following it from here with
   *  `events`: for a webview that slept through events, or reloaded mid-call. */
  resync?(events: EngineEvents): Promise<EngineNow | null>;
}

/** The engine's call right now. */
export type EngineNow = {
  state: "idle" | EngineState;
  reason?: string;
  serverId?: string;
  roomId?: string;
  muted: boolean;
  consent: ConsentSheet | null;
  /** The call has video. */
  video?: boolean;
  /** Each of `SelfFlags`, only while true. */
  deafened?: boolean;
  muteLocked?: boolean;
  deafLocked?: boolean;
};

/** This build: no call audio yet. Join explains, nothing else happens. */
export const UNAVAILABLE_ENGINE: PhoneVoiceEngine = {
  available: false,
  join: () => Promise.reject({ code: "e2ee_unsupported" }),
  leave: async () => {},
  setMuted: () => {},
  system: () => {},
};

export type CallRoom = {
  serverId: string;
  serverLabel: string;
  roomId: string;
  roomName: string;
  limit: number | null;
};

type CallState = SelfFlags & {
  phase: CallPhase;
  room: CallRoom | null;
  /** The mic is off: your own mute, or deafened (a deafen mutes too). */
  muted: boolean;
  /** The call has video: the call screen shows its tile. */
  video: boolean;
  /** The last line worth showing: why a join failed or a call ended. */
  notice: string | null;
  /** A recording notice waiting for this person's answer. */
  consent: ConsentSheet | null;
  /** `camera`: "Join with camera" (the permission first; refused, the call
   *  still joins, without it). */
  join(room: CallRoom, options?: JoinOptions): Promise<void>;
  /** A choice from `consent`: `null` gives up the held join. */
  answerConsent(granted: boolean | null): Promise<void>;
  /** Catch up with the engine (back in the foreground, or after a reload).
   *  `name` gives an adopted call its names. */
  resync(name?: (serverId: string, roomId: string) => Omit<CallRoom, "serverId" | "roomId">): Promise<void>;
  leave(): Promise<void>;
  /** Unmuting while deafened undeafens too; never past a moderator's mute. */
  setMuted(muted: boolean): void;
  /** Deafen or undeafen (an undeafen goes back to the mute from before). */
  setDeafened(deafened: boolean): void;
  clearNotice(): void;
};

let engine: PhoneVoiceEngine = UNAVAILABLE_ENGINE;
let shim: CallShim = callShim();
let unlisten: (() => void) | null = null;
/** Each join's id: an old join's late answer never touches a newer call. */
let attempt = 0;

function codeOf(err: unknown): { code: VoiceErrorCode; hint: string } {
  const e = err && typeof err === "object" ? (err as { code?: unknown; hint?: unknown }) : {};
  return {
    code: typeof e.code === "string" ? (e.code as VoiceErrorCode) : "unknown",
    hint: typeof e.hint === "string" ? e.hint : "",
  };
}

export const useVoiceCall = create<CallState>((set, get) => {
  function ended(reason: string | undefined, id: number): void {
    if (id !== attempt || get().phase === "idle") return;
    // A join still in flight belongs to this call: its answer is ignored.
    attempt += 1;
    const room = get().room;
    if (!engine.drivesSystemCall) shim.report("ended", reason);
    stopListening();
    set({
      phase: "idle",
      room: null,
      muted: false,
      ...NO_FLAGS,
      video: false,
      consent: null,
      notice: room && reason && reason !== "left" ? callEndedText(reason, room.roomName, room.serverLabel, true) : null,
    });
  }

  function onShim(e: ShimEvent): void {
    switch (e.event) {
      case "end_requested":
        void get().leave();
        return;
      case "mute_requested":
        // The system's own button: the engine follows, the system already shows it.
        if (get().muted !== e.muted) {
          engine.setMuted(e.muted);
          set({ muted: e.muted });
        }
        return;
      default:
        engine.system(e);
    }
  }

  function stopListening(): void {
    unlisten?.();
    unlisten = null;
  }

  /** The engine's events for call `id`. */
  function follow(id: number, micDenied: boolean): EngineEvents {
    return {
      onState(s, reason) {
        if (id !== attempt) return;
        if (s === "ended") return ended(reason, id);
        if (!engine.drivesSystemCall && s !== "held") shim.report(s);
        if (s === "connected") set({ phase: "connected", ...(micDenied ? { muted: true } : {}) });
        if (s === "reconnecting") set({ phase: "reconnecting" });
      },
      onConsent(sheet) {
        if (id === attempt) set({ consent: sheet });
      },
      onSelfMute(muted, flags) {
        if (id === attempt && get().phase !== "idle") set(flags ? { muted, ...flags } : { muted });
      },
      onVideo(on) {
        if (id === attempt && get().phase !== "idle") set({ video: on });
      },
    };
  }

  return {
    phase: "idle",
    room: null,
    muted: false,
    ...NO_FLAGS,
    video: false,
    notice: null,
    consent: null,

    async join(room, options) {
      if (get().phase !== "idle") await get().leave();
      const id = ++attempt;
      set({ phase: "joining", room, muted: false, ...NO_FLAGS, video: false, notice: null });
      if (!engine.available) {
        set({
          phase: "idle",
          room: null,
          notice: joinErrorText("e2ee_unsupported", room.roomName, room.serverLabel, room.limit),
        });
        return;
      }
      // Before the system call, so its prompt never lands in CallKit's. A
      // refusal still joins: the person can listen.
      const mic = await shim.microphone();
      if (id !== attempt) return;
      if (mic === "denied") set({ notice: MIC_DENIED_LINE });
      // The camera's prompt too, before the system call. Refused: the call
      // joins without the camera and says why.
      let camera = options?.camera === true && !!engine.cameraJoin;
      if (camera && engine.cameraPermission) {
        const ask = await engine.cameraPermission();
        if (id !== attempt) return;
        if (!ask.ok) {
          camera = false;
          set({ notice: cameraRefusalText(ask.code) });
        }
      }
      const events = follow(id, mic === "denied");
      if (engine.drivesSystemCall) {
        // Rust starts the system call when the engine connects; it knows
        // only ids, so name the call first.
        shim.label(room.roomName, room.serverLabel);
        try {
          await engine.join(room.serverId, room.roomId, events, camera ? { camera: true } : undefined);
        } catch (err) {
          if (id !== attempt) return;
          const { code, hint } = codeOf(err);
          set({
            phase: "idle",
            room: null,
            consent: null,
            notice: joinErrorText(code, room.roomName, room.serverLabel, room.limit, hint),
          });
        }
        return;
      }
      unlisten = shim.listen(onShim);
      const refused = await shim.start(room.roomName, room.serverLabel);
      if (id !== attempt) return;
      if (refused) {
        stopListening();
        set({ phase: "idle", room: null, notice: `Couldn't start the call (${refused}).` });
        return;
      }
      shim.report("connecting");
      try {
        await engine.join(room.serverId, room.roomId, events);
      } catch (err) {
        if (id !== attempt) return;
        const { code, hint } = codeOf(err);
        shim.report("ended", "failed");
        stopListening();
        set({
          phase: "idle",
          room: null,
          notice: joinErrorText(code, room.roomName, room.serverLabel, room.limit, hint),
        });
      }
    },

    async leave() {
      if (get().phase === "idle") return;
      const id = attempt;
      await engine.leave().catch(() => {});
      ended("left", id);
    },

    setMuted(muted) {
      const s = get();
      if (s.phase === "idle" || s.muted === muted) return;
      if (!muted && s.muteLocked) return;
      if (!muted && s.deafened && engine.setDeafened) {
        // The kit's rule: the mic back on brings the sound back too.
        engine.setDeafened(false, false);
        if (!engine.drivesSystemCall) shim.setMuted(false);
        set({ muted: false, deafened: false });
        return;
      }
      engine.setMuted(muted);
      if (!engine.drivesSystemCall) shim.setMuted(muted);
      set({ muted });
    },

    setDeafened(deafened) {
      const s = get();
      if (s.phase === "idle" || s.deafened === deafened || s.deafLocked || !engine.setDeafened) return;
      engine.setDeafened(deafened);
      // A deafen mutes; an undeafen's mute is the engine's to say (the one
      // from before the deafen), on its next participants event.
      set(deafened ? { deafened, muted: true } : { deafened });
    },

    async answerConsent(granted) {
      const sheet = get().consent;
      if (!sheet) return;
      set({ consent: null });
      if (granted === null || !engine.consent) return get().leave();
      try {
        await engine.consent(granted, sheet.noticeVersion);
      } catch (err) {
        // A changed notice comes back as the new sheet; a stopped recording
        // has nothing left to answer.
        const code: string = codeOf(err).code;
        if (code === "recording_consent_required" || code === "recording_not_active") return;
        set({ notice: "Couldn't send your answer. Try again, or leave the room." });
      }
    },

    async resync(name) {
      if (!engine.resync || get().phase === "joining") return;
      const id = get().phase === "idle" ? ++attempt : attempt;
      const now = await engine.resync(follow(id, false));
      if (!now || id !== attempt) return;
      if (now.state === "idle" || now.state === "ended") {
        // The call ended while the webview slept.
        if (get().phase !== "idle") ended(now.reason, id);
        return;
      }
      let room = get().room;
      if (!room) {
        // The webview reloaded mid-call: take the call back.
        if (!now.serverId || !now.roomId) return;
        const names = name?.(now.serverId, now.roomId) ?? { serverLabel: "", roomName: "Voice room", limit: null };
        room = { serverId: now.serverId, roomId: now.roomId, ...names };
      }
      set({
        room,
        phase: now.state === "connected" ? "connected" : now.state === "reconnecting" ? "reconnecting" : "joining",
        muted: now.muted,
        deafened: now.deafened === true,
        muteLocked: now.muteLocked === true,
        deafLocked: now.deafLocked === true,
        video: now.video === true,
        consent: now.consent,
      });
    },

    clearNotice: () => set({ notice: null }),
  };
});

/** "Join with camera" is offered: this build's engine can. */
export function canJoinWithCamera(): boolean {
  return engine.available && !!engine.cameraJoin;
}

/** The native engine, once a build carries it. */
export function setPhoneVoiceEngine(next: PhoneVoiceEngine): void {
  engine = next;
}

export function __setCallShimForTests(next: CallShim): void {
  shim = next;
}

export function __resetVoiceCallForTests(): void {
  engine = UNAVAILABLE_ENGINE;
  shim = callShim();
  unlisten = null;
  attempt = 0;
  useVoiceCall.setState({ phase: "idle", room: null, muted: false, ...NO_FLAGS, video: false, notice: null, consent: null });
}
