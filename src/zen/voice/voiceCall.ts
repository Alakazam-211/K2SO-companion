import { create } from "zustand";
import { callShim, type CallShim, type ShimEvent } from "./callShim";
import { callEndedText, joinErrorText, type VoiceErrorCode } from "./voiceWire";

// The phone's one voice-room call (rooms only for now: Rosson 2026-11-04).
// The engine is the truth (Sew's sew-call-client over K2's kessel-audio, in
// Rust); this store mirrors it for the UI and keeps the system call UI
// (CallKit) in step, in both directions:
//   - Join starts the system call first: CallKit owns the audio session and
//     activates it, and the engine starts audio only then.
//   - The engine's state goes to the system call (connecting, connected,
//     reconnecting, ended).
//   - The system's End and Mute come back as requests the engine carries out.
// When the engine moves into Rust with a native listener (Sew's mobile
// hooks), the shim wiring moves with it; the store keeps the same shape.

export type CallPhase = "idle" | "joining" | "connected" | "reconnecting";

export type EngineState = "connecting" | "connected" | "reconnecting" | "ended";

export interface PhoneVoiceEngine {
  /** False until this build carries call audio. */
  readonly available: boolean;
  /** Resolves once joined; rejects with `{code, hint?}`. */
  join(serverId: string, roomId: string, events: { onState(s: EngineState, reason?: string): void }): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): void;
  /** The audio session and interruptions (kessel-audio's phone hooks). */
  system(e: ShimEvent): void;
}

/** This build: no call audio yet. Join explains, nothing else happens. */
export const UNAVAILABLE_ENGINE: PhoneVoiceEngine = {
  available: false,
  join: () => Promise.reject({ code: "e2ee_unsupported" }),
  leave: async () => {},
  setMuted: () => {},
  system: () => {},
};

export type CallRoom = { serverId: string; serverLabel: string; roomId: string; roomName: string; limit: number | null };

type CallState = {
  phase: CallPhase;
  room: CallRoom | null;
  muted: boolean;
  /** The last line worth showing: why a join failed or a call ended. */
  notice: string | null;
  join(room: CallRoom): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): void;
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
    shim.report("ended", reason);
    stopListening();
    set({
      phase: "idle",
      room: null,
      muted: false,
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

  return {
    phase: "idle",
    room: null,
    muted: false,
    notice: null,

    async join(room) {
      if (get().phase !== "idle") await get().leave();
      const id = ++attempt;
      set({ phase: "joining", room, muted: false, notice: null });
      if (!engine.available) {
        set({ phase: "idle", room: null, notice: joinErrorText("e2ee_unsupported", room.roomName, room.serverLabel, room.limit) });
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
        await engine.join(room.serverId, room.roomId, {
          onState: (s, reason) => {
            if (id !== attempt) return;
            if (s === "ended") return ended(reason, id);
            shim.report(s);
            if (s === "connected") set({ phase: "connected" });
            if (s === "reconnecting") set({ phase: "reconnecting" });
          },
        });
      } catch (err) {
        if (id !== attempt) return;
        const { code, hint } = codeOf(err);
        shim.report("ended", "failed");
        stopListening();
        set({ phase: "idle", room: null, notice: joinErrorText(code, room.roomName, room.serverLabel, room.limit, hint) });
      }
    },

    async leave() {
      if (get().phase === "idle") return;
      const id = attempt;
      await engine.leave().catch(() => {});
      ended("left", id);
    },

    setMuted(muted) {
      if (get().phase === "idle" || get().muted === muted) return;
      engine.setMuted(muted);
      shim.setMuted(muted);
      set({ muted });
    },

    clearNotice: () => set({ notice: null }),
  };
});

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
  useVoiceCall.setState({ phase: "idle", room: null, muted: false, notice: null });
}
