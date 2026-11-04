import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));

import type { CallShim, ShimEvent } from "./callShim";
import {
  __resetVoiceCallForTests,
  __setCallShimForTests,
  setPhoneVoiceEngine,
  useVoiceCall,
  type EngineState,
  type PhoneVoiceEngine,
} from "./voiceCall";

const ROOM = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };

function fakeShim(refuse: string | null = null) {
  const calls: string[] = [];
  let listener: ((e: ShimEvent) => void) | null = null;
  const shim: CallShim = {
    start: vi.fn(async () => (calls.push("start"), refuse)),
    report: (s, r) => void calls.push(r ? `report:${s}:${r}` : `report:${s}`),
    setMuted: (on) => void calls.push(`mute:${on}`),
    setTitle: () => {},
    end: () => void calls.push("end"),
    setSpeaker: async () => null,
    listen: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return { shim, calls, fire: (e: ShimEvent) => listener?.(e), listening: () => listener !== null };
}

function fakeEngine() {
  let onState: ((s: EngineState, reason?: string) => void) | null = null;
  let finish: { resolve(): void; reject(e: unknown): void } | null = null;
  const engine: PhoneVoiceEngine & { muted: boolean[]; systems: ShimEvent[] } = {
    available: true,
    muted: [],
    systems: [],
    join: vi.fn((_s, _r, events) => {
      onState = events.onState;
      return new Promise<void>((resolve, reject) => (finish = { resolve, reject }));
    }),
    leave: vi.fn(async () => {}),
    setMuted(m) {
      engine.muted.push(m);
    },
    system(e) {
      engine.systems.push(e);
    },
  };
  return {
    engine,
    state: (s: EngineState, reason?: string) => onState?.(s, reason),
    joined: () => finish?.resolve(),
    refuse: (e: unknown) => finish?.reject(e),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetVoiceCallForTests());

describe("the phone's voice-room call", () => {
  it("without call audio in this build, Join only explains", async () => {
    const s = fakeShim();
    __setCallShimForTests(s.shim);
    await useVoiceCall.getState().join(ROOM);
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(useVoiceCall.getState().notice).toMatch(/later K2 update/);
    expect(s.calls).toEqual([]);
  });

  it("starts the system call first, then mirrors the engine's state to it", async () => {
    const s = fakeShim();
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    const joining = useVoiceCall.getState().join(ROOM);
    await flush();
    expect(s.shim.start).toHaveBeenCalledWith("Standup", "sewlab");
    expect(e.engine.join).toHaveBeenCalledWith("s1", "room-1", expect.anything());
    e.state("connected");
    e.joined();
    await joining;
    expect(useVoiceCall.getState().phase).toBe("connected");
    e.state("reconnecting");
    expect(useVoiceCall.getState().phase).toBe("reconnecting");
    e.state("ended", "removed_by_moderator");
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(useVoiceCall.getState().notice).toBe("You were removed from Standup.");
    expect(s.calls).toEqual([
      "start",
      "report:connecting",
      "report:connected",
      "report:reconnecting",
      "report:ended:removed_by_moderator",
    ]);
    expect(s.listening()).toBe(false);
  });

  it("the system's End and Mute reach the engine; the audio session's events pass through", async () => {
    const s = fakeShim();
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    void useVoiceCall.getState().join(ROOM);
    await flush();
    e.state("connected");
    s.fire({ event: "session_activated", route: "speaker" });
    s.fire({ event: "suspend", why: "hold" });
    expect(e.engine.systems.map((x) => x.event)).toEqual(["session_activated", "suspend"]);
    s.fire({ event: "mute_requested", muted: true });
    expect(e.engine.muted).toEqual([true]);
    expect(useVoiceCall.getState().muted).toBe(true);
    expect(s.calls).not.toContain("mute:true");
    s.fire({ event: "end_requested", why: "system" });
    await flush();
    expect(e.engine.leave).toHaveBeenCalled();
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(useVoiceCall.getState().notice).toBeNull();
  });

  it("mute in the app tells both the engine and the system", async () => {
    const s = fakeShim();
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    void useVoiceCall.getState().join(ROOM);
    await flush();
    e.state("connected");
    useVoiceCall.getState().setMuted(true);
    useVoiceCall.getState().setMuted(true);
    expect(e.engine.muted).toEqual([true]);
    expect(s.calls.filter((c) => c.startsWith("mute"))).toEqual(["mute:true"]);
  });

  it("a refused join ends the system call and says why", async () => {
    const s = fakeShim();
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    const joining = useVoiceCall.getState().join(ROOM);
    await flush();
    e.refuse({ code: "room_full" });
    await joining;
    expect(useVoiceCall.getState().notice).toBe("Standup is full (25).");
    expect(s.calls).toEqual(["start", "report:connecting", "report:ended:failed"]);
  });

  it("CallKit refusing the call leaves nothing behind", async () => {
    const s = fakeShim("call_in_progress");
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    await useVoiceCall.getState().join(ROOM);
    expect(e.engine.join).not.toHaveBeenCalled();
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(s.listening()).toBe(false);
  });

  it("leaving while joining ignores the join's late answer", async () => {
    const s = fakeShim();
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    const joining = useVoiceCall.getState().join(ROOM);
    await flush();
    await useVoiceCall.getState().leave();
    e.refuse({ code: "join_timeout" });
    await joining;
    expect(useVoiceCall.getState().notice).toBeNull();
    expect(s.calls.filter((c) => c.startsWith("report:ended"))).toEqual(["report:ended:left"]);
  });
});
