import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { isIosWebView } from "../../lib/nativePicker";

// The system's view of a voice-room call (iOS CallKit, `K2CallShim.swift`):
// the green pill, the Dynamic Island, the Lock Screen and their buttons. It
// mirrors the call; it never decides its state.

const PLUGIN = "k2-push";

export type ShimState = "connecting" | "connected" | "reconnecting" | "ended";

/** What the system asks for, or tells us about the audio session. */
export type ShimEvent =
  | { event: "started" }
  | { event: "end_requested"; why: "system" | "reset" }
  | { event: "mute_requested"; muted: boolean }
  | { event: "suspend" | "resume"; why: "hold" | "interruption" }
  | { event: "session_activated"; route?: string }
  | { event: "session_deactivated" }
  | { event: "route_changed"; route: string }
  | { event: "media_reset" };

export interface CallShim {
  /** Resolves to null once the system took the call, else an error code. */
  start(room: string, server: string): Promise<string | null>;
  report(state: ShimState, reason?: string): void;
  setMuted(on: boolean): void;
  setTitle(title: string): void;
  end(): void;
  setSpeaker(on: boolean): Promise<string | null>;
  /** The microphone permission, asking the first time. */
  microphone(): Promise<"granted" | "denied">;
  listen(cb: (e: ShimEvent) => void): () => void;
}

function op(args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown>>(`plugin:${PLUGIN}|call_op`, args).catch(() => null);
}

const ios: CallShim = {
  async start(room, server) {
    const r = await op({ op: "start", room, server });
    if (!r) return "unavailable";
    return r.ok === true ? null : typeof r.error === "string" ? r.error : "failed";
  },
  report: (state, reason) => void op({ op: "report", state, ...(reason ? { reason } : {}) }),
  setMuted: (on) => void op({ op: "mute", on }),
  setTitle: (title) => void op({ op: "title", title }),
  end: () => void op({ op: "end" }),
  async setSpeaker(on) {
    const r = await op({ op: "speaker", on });
    return r && typeof r.route === "string" ? r.route : null;
  },
  async microphone() {
    const r = await op({ op: "mic" });
    return r?.mic === "denied" ? "denied" : "granted";
  },
  listen(cb) {
    let off: (() => void) | null = null;
    let stopped = false;
    void addPluginListener(PLUGIN, "call", (e: ShimEvent) => cb(e)).then(
      (l) => {
        if (stopped) void l.unregister();
        else off = () => void l.unregister();
      },
      () => {}
    );
    return () => {
      stopped = true;
      off?.();
    };
  },
};

/** No system call UI (Android until Jeremie's CallStyle shim, the browser). */
const none: CallShim = {
  start: async () => null,
  report: () => {},
  setMuted: () => {},
  setTitle: () => {},
  end: () => {},
  setSpeaker: async () => null,
  microphone: async () => "granted",
  listen: () => () => {},
};

export function callShim(): CallShim {
  return isIosWebView() ? ios : none;
}
