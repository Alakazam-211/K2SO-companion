import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));

import type { CallShim, ShimEvent } from "./callShim";
import {
  __resetVoiceCallForTests,
  __setCallShimForTests,
  __setSessionLeaverForTests,
  consentKey,
  setPhoneVoiceEngine,
  useVoiceCall,
  type ConsentSheet,
  type EngineEvents,
  type EngineNow,
  type EngineState,
  type PhoneVoiceEngine,
} from "./voiceCall";

const ROOM = { serverId: "s1", serverLabel: "skylab", roomId: "room-1", roomName: "Standup", limit: 25 };

function fakeShim(refuse: string | null = null, mic: "granted" | "denied" = "granted") {
  const calls: string[] = [];
  let listener: ((e: ShimEvent) => void) | null = null;
  const shim: CallShim = {
    label: (room, server) => void calls.push(`label:${room}:${server}`),
    start: vi.fn(async () => (calls.push("start"), refuse)),
    report: (s, r) => void calls.push(r ? `report:${s}:${r}` : `report:${s}`),
    setMuted: (on) => void calls.push(`mute:${on}`),
    setTitle: () => {},
    end: () => void calls.push("end"),
    setSpeaker: async () => null,
    microphone: vi.fn(async () => (calls.push("mic"), mic)),
    listen: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return { shim, calls, fire: (e: ShimEvent) => listener?.(e), listening: () => listener !== null };
}

function fakeEngine(native = false, now: EngineNow | null = null) {
  let onState: ((s: EngineState, reason?: string) => void) | null = null;
  let events: EngineEvents | null = null;
  let finish: { resolve(): void; reject(e: unknown): void } | null = null;
  const engine: PhoneVoiceEngine & { muted: boolean[]; systems: ShimEvent[]; consents: [boolean, number][] } = {
    available: true,
    drivesSystemCall: native,
    muted: [],
    systems: [],
    consents: [],
    join: vi.fn((_s, _r, e: EngineEvents) => {
      onState = e.onState;
      events = e;
      return new Promise<void>((resolve, reject) => (finish = { resolve, reject }));
    }),
    consent: vi.fn(async (granted: boolean, version: number) => void engine.consents.push([granted, version])),
    resync: vi.fn(async (e: EngineEvents) => {
      onState = e.onState;
      events = e;
      return now;
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
    events: () => events,
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
    expect(s.shim.start).toHaveBeenCalledWith("Standup", "skylab");
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
      "mic",
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
    expect(s.calls).toEqual(["mic", "start", "report:connecting", "report:ended:failed"]);
  });

  it("a join says how it went: taken, refused (with the server's own code), or superseded", async () => {
    const s = fakeShim();
    const e = fakeEngine(true);
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    const DM = { serverId: "s1", serverLabel: "box", roomId: "dm:900", roomName: "Alex", limit: 2, dm: { conv: "900" } };
    let joining = useVoiceCall.getState().join(DM);
    await flush();
    e.joined();
    await expect(joining).resolves.toEqual({ ok: true });
    expect(e.engine.join).toHaveBeenLastCalledWith("s1", "dm:900", expect.anything(), undefined);
    await useVoiceCall.getState().leave();
    // A DM call's refusal reads as a call's, not a room's.
    joining = useVoiceCall.getState().join(DM);
    await flush();
    e.refuse({ code: "unknown", hint: "", raw: "chat_unavailable" });
    await expect(joining).resolves.toEqual({ ok: false, code: "unknown", raw: "chat_unavailable", hint: "" });
    expect(useVoiceCall.getState().notice).toBe("Calls aren't available on box right now.");
    // A leave before the answer: superseded.
    joining = useVoiceCall.getState().join(DM);
    await flush();
    await useVoiceCall.getState().leave();
    e.joined();
    await expect(joining).resolves.toMatchObject({ ok: false, code: "superseded" });
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

  it("asks for the microphone before the system call; a refusal still joins, to listen", async () => {
    const s = fakeShim(null, "denied");
    const e = fakeEngine();
    __setCallShimForTests(s.shim);
    setPhoneVoiceEngine(e.engine);
    void useVoiceCall.getState().join(ROOM);
    await flush();
    expect(s.calls.slice(0, 2)).toEqual(["mic", "start"]);
    e.state("connected");
    expect(useVoiceCall.getState().phase).toBe("connected");
    expect(useVoiceCall.getState().muted).toBe(true);
    expect(useVoiceCall.getState().notice).toMatch(/You can still listen/);
  });

  describe("with the native engine (Rust drives the system call)", () => {
    const SHEET: ConsentSheet = {
      ask: "join",
      noticeVersion: 3141,
      title: "This call is being recorded",
      text: "Sew Notes records…",
      choices: [
        { label: "Join and allow recording", granted: true },
        { label: "Join without being recorded", granted: false },
        { label: "Cancel", granted: null },
      ],
    };

    it("Join with camera: the mic, then the camera's permission, then a join with the camera", async () => {
      const s = fakeShim();
      const e = fakeEngine(true);
      const asks: string[] = [];
      Object.assign(e.engine, {
        cameraJoin: true,
        cameraPermission: vi.fn(async () => (asks.push("camera"), { ok: true as const })),
      });
      __setCallShimForTests(s.shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM, { camera: true });
      await flush();
      expect(s.calls).toEqual(["mic", "label:Standup:skylab"]);
      expect(asks).toEqual(["camera"]);
      expect(e.engine.join).toHaveBeenCalledWith("s1", "room-1", expect.anything(), { camera: true });
      // A plain Join never asks for the camera.
      await useVoiceCall.getState().leave();
      void useVoiceCall.getState().join(ROOM);
      await flush();
      expect(asks).toEqual(["camera"]);
      expect(e.engine.join).toHaveBeenLastCalledWith("s1", "room-1", expect.anything(), undefined);
    });

    it("Join with camera refused: joins without it and says where to turn it on", async () => {
      const s = fakeShim();
      const e = fakeEngine(true);
      Object.assign(e.engine, {
        cameraJoin: true,
        cameraPermission: vi.fn(async () => ({ ok: false as const, code: "camera_permission_denied" as const })),
      });
      __setCallShimForTests(s.shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM, { camera: true });
      await flush();
      expect(e.engine.join).toHaveBeenCalledWith("s1", "room-1", expect.anything(), undefined);
      expect(useVoiceCall.getState().notice).toBe("Camera access is off. Turn it on in Settings › K2 › Camera.");
      e.state("connected");
      expect(useVoiceCall.getState().phase).toBe("connected");
    });

    it("names the call, asks for the mic, and never touches the system call itself", async () => {
      const s = fakeShim();
      const e = fakeEngine(true);
      __setCallShimForTests(s.shim);
      setPhoneVoiceEngine(e.engine);
      const joining = useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connecting");
      e.state("connected");
      e.joined();
      await joining;
      expect(useVoiceCall.getState().phase).toBe("connected");
      useVoiceCall.getState().setMuted(true);
      expect(e.engine.muted).toEqual([true]);
      e.state("ended", "removed_by_moderator");
      expect(useVoiceCall.getState().notice).toBe("You were removed from Standup.");
      expect(s.calls).toEqual(["mic", "label:Standup:skylab"]);
      expect(s.listening()).toBe(false);
    });

    it("deafen, and a moderator's holds: the call tile's rules", async () => {
      const e = fakeEngine(true);
      const deafens: [boolean, boolean | undefined][] = [];
      e.engine.setDeafened = (d, m) => void deafens.push([d, m]);
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connected");
      const st = () => useVoiceCall.getState();
      st().setDeafened(true);
      expect(deafens).toEqual([[true, undefined]]);
      expect([st().deafened, st().muted]).toEqual([true, true]);
      // Unmuting while deafened undeafens, in one step.
      st().setMuted(false);
      expect(deafens).toEqual([[true, undefined], [false, false]]);
      expect([st().deafened, st().muted]).toEqual([false, false]);
      expect(e.engine.muted).toEqual([]);
      // The engine's row: a moderator's mute; no unmute gets past it.
      e.events()?.onSelfMute?.(true, { deafened: false, muteLocked: true, deafLocked: false });
      expect([st().muted, st().muteLocked]).toEqual([true, true]);
      st().setMuted(false);
      expect(e.engine.muted).toEqual([]);
      // A moderator's deafen: no undeafen.
      e.events()?.onSelfMute?.(true, { deafened: true, muteLocked: true, deafLocked: true });
      st().setDeafened(false);
      expect(deafens).toHaveLength(2);
      // An engine without flags leaves them as they were; the call's end clears them.
      e.events()?.onSelfMute?.(false);
      expect([st().muted, st().deafened, st().deafLocked]).toEqual([false, true, true]);
      e.state("ended", "left");
      expect([st().deafened, st().muteLocked, st().deafLocked]).toEqual([false, false, false]);
    });

    it("follows a mute from the system's button", async () => {
      const e = fakeEngine(true);
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connected");
      e.events()?.onSelfMute?.(true);
      expect(useVoiceCall.getState().muted).toBe(true);
      expect(e.engine.muted).toEqual([]);
    });

    it("follows the call's video, and drops it when the call ends", async () => {
      const e = fakeEngine(true);
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connected");
      expect(useVoiceCall.getState().video).toBe(false);
      e.events()?.onVideo?.(true);
      expect(useVoiceCall.getState().video).toBe(true);
      e.state("ended", "left");
      expect(useVoiceCall.getState().video).toBe(false);
      // A late event from the old call changes nothing.
      e.events()?.onVideo?.(true);
      expect(useVoiceCall.getState().video).toBe(false);
    });

    it("back in the foreground: video that came while asleep shows", async () => {
      const e = fakeEngine(true, {
        state: "connected",
        serverId: "s1",
        roomId: "room-1",
        muted: false,
        consent: null,
        video: true,
      });
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connected");
      await useVoiceCall.getState().resync();
      expect(useVoiceCall.getState().video).toBe(true);
    });

    it("a held join shows the notice; an answer goes to the engine with its version", async () => {
      const e = fakeEngine(true);
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("held");
      e.events()?.onConsent?.(SHEET);
      expect(useVoiceCall.getState().phase).toBe("joining");
      expect(useVoiceCall.getState().consent).toEqual(SHEET);
      await useVoiceCall.getState().answerConsent(false);
      expect(e.engine.consents).toEqual([[false, 3141]]);
      expect(useVoiceCall.getState().consent).toBeNull();
    });

    it("a changed notice shows the new one, not a failure", async () => {
      const e = fakeEngine(true);
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.events()?.onConsent?.(SHEET);
      const next = { ...SHEET, noticeVersion: 3142 };
      vi.mocked(e.engine.consent!).mockImplementationOnce(async () => {
        e.events()?.onConsent?.(next);
        throw { code: "recording_consent_required" };
      });
      await useVoiceCall.getState().answerConsent(true);
      expect(useVoiceCall.getState().consent).toEqual(next);
      expect(useVoiceCall.getState().notice).toBeNull();
      vi.mocked(e.engine.consent!).mockRejectedValueOnce({ code: "unavailable" });
      await useVoiceCall.getState().answerConsent(true);
      expect(useVoiceCall.getState().notice).toMatch(/Couldn't send your answer/);
    });

    it("Cancel on a held join leaves", async () => {
      const e = fakeEngine(true);
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.events()?.onConsent?.(SHEET);
      await useVoiceCall.getState().answerConsent(null);
      expect(e.engine.leave).toHaveBeenCalled();
      expect(e.engine.consents).toEqual([]);
      expect(useVoiceCall.getState().phase).toBe("idle");
    });

    it("a refused join says why, with nothing to end", async () => {
      const s = fakeShim();
      const e = fakeEngine(true);
      __setCallShimForTests(s.shim);
      setPhoneVoiceEngine(e.engine);
      const joining = useVoiceCall.getState().join(ROOM);
      await flush();
      e.refuse({ code: "device_session_ended" });
      await joining;
      expect(useVoiceCall.getState().phase).toBe("idle");
      expect(useVoiceCall.getState().notice).toMatch(/Pair it again/);
      expect(s.calls.some((c) => c.startsWith("report"))).toBe(false);
    });

    it("back in the foreground: a call that ended while asleep ends here too", async () => {
      const e = fakeEngine(true, { state: "ended", reason: "removed_by_moderator", muted: false, consent: null });
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connected");
      await useVoiceCall.getState().resync();
      expect(useVoiceCall.getState().phase).toBe("idle");
      expect(useVoiceCall.getState().notice).toBe("You were removed from Standup.");
    });

    it("back in the foreground: a missed notice and mute show", async () => {
      const sheet = {
        ask: "in_call" as const,
        noticeVersion: 4,
        title: "t",
        text: "x",
        choices: [{ label: "Allow", granted: true }],
      };
      const e = fakeEngine(true, { state: "connected", serverId: "s1", roomId: "room-1", muted: true, consent: sheet });
      __setCallShimForTests(fakeShim().shim);
      setPhoneVoiceEngine(e.engine);
      void useVoiceCall.getState().join(ROOM);
      await flush();
      e.state("connected");
      await useVoiceCall.getState().resync();
      const st = useVoiceCall.getState();
      expect([st.phase, st.muted, st.consent, st.room?.roomName]).toEqual(["connected", true, sheet, "Standup"]);
    });

    it("after a reload mid-call, takes the call back and follows it", async () => {
      const e = fakeEngine(true, {
        state: "reconnecting",
        serverId: "s1",
        roomId: "room-1",
        muted: false,
        consent: null,
      });
      setPhoneVoiceEngine(e.engine);
      await useVoiceCall
        .getState()
        .resync((serverId) => ({
          serverLabel: serverId === "s1" ? "skylab" : "",
          roomName: "Voice room",
          limit: null,
        }));
      expect(useVoiceCall.getState().phase).toBe("reconnecting");
      expect(useVoiceCall.getState().room).toEqual({
        serverId: "s1",
        roomId: "room-1",
        serverLabel: "skylab",
        roomName: "Voice room",
        limit: null,
      });
      e.state("connected");
      expect(useVoiceCall.getState().phase).toBe("connected");
      e.state("ended", "left");
      expect(useVoiceCall.getState().phase).toBe("idle");
    });

    it("no call anywhere: nothing changes", async () => {
      const e = fakeEngine(true, { state: "idle", muted: false, consent: null });
      setPhoneVoiceEngine(e.engine);
      await useVoiceCall.getState().resync();
      expect(useVoiceCall.getState().phase).toBe("idle");
      expect(useVoiceCall.getState().notice).toBeNull();
    });
  });
});

// K2's answers §4: after any leave of the engine, `session/leave {callId}`
// with K2's `vc_…` id, fire and forget; never without the id.
describe("K2's record after the engine leaves", () => {
  function withIds(e: ReturnType<typeof fakeEngine>, ids: { room: string; callId: string } | null) {
    e.engine.callId = vi.fn(async () => ids);
    return e;
  }

  function leaves(order?: string[]) {
    const sent: Array<[string, string]> = [];
    __setSessionLeaverForTests((serverId, callId) => {
      sent.push([serverId, callId]);
      order?.push("k2");
    });
    return sent;
  }

  async function joined(e: ReturnType<typeof fakeEngine>) {
    setPhoneVoiceEngine(e.engine);
    __setCallShimForTests(fakeShim().shim);
    const out = useVoiceCall.getState().join(ROOM);
    await flush();
    e.joined();
    await out;
    await flush();
  }

  it("Hang up: the engine's leave first, then K2's with the join's vc_ id, once", async () => {
    const order: string[] = [];
    const sent = leaves(order);
    const e = withIds(fakeEngine(true), { room: "room-1", callId: "vc_r1" });
    vi.mocked(e.engine.leave).mockImplementation(async () => void order.push("engine"));
    await joined(e);
    e.state("connected");
    await useVoiceCall.getState().leave();
    expect(order).toEqual(["engine", "k2"]);
    expect(sent).toEqual([["s1", "vc_r1"]]);
    await useVoiceCall.getState().leave();
    expect(sent).toHaveLength(1);
  });

  it("the other side ended (or a drop, an error): K2's record goes too; a re-join's newer id wins", async () => {
    const sent = leaves();
    const e = withIds(fakeEngine(true), { room: "room-1", callId: "vc_r1" });
    await joined(e);
    // The engine re-joined (a lost admit): K2 keeps a new record.
    e.events()!.onCallId!("room-1", "vc_r2");
    e.state("ended", "call_ended");
    expect(sent).toEqual([["s1", "vc_r2"]]);
    expect(useVoiceCall.getState().phase).toBe("idle");
  });

  it("never without K2's id: none, or Sew's digits, sends nothing", async () => {
    const sent = leaves();
    const e = withIds(fakeEngine(true), null);
    await joined(e);
    e.events()!.onCallId!("room-1", "4455");
    e.state("ended", "network");
    expect(sent).toEqual([]);
  });

  it("a join that answers after its call was left is left too", async () => {
    const sent = leaves();
    const e = withIds(fakeEngine(true), null);
    setPhoneVoiceEngine(e.engine);
    __setCallShimForTests(fakeShim().shim);
    const out = useVoiceCall.getState().join(ROOM);
    await flush();
    const late = e.events()!;
    await useVoiceCall.getState().leave();
    expect(sent).toEqual([]);
    late.onCallId!("room-1", "vc_late");
    expect(sent).toEqual([["s1", "vc_late"]]);
    e.joined();
    expect(await out).toMatchObject({ code: "superseded" });
  });

  it("a call that ended while the webview slept: its id from the engine, then K2's leave", async () => {
    const sent = leaves();
    const now: EngineNow = { state: "connected", serverId: "s1", roomId: "room-1", muted: false, consent: null };
    const e = withIds(fakeEngine(true, now), { room: "room-1", callId: "vc_r9" });
    setPhoneVoiceEngine(e.engine);
    await useVoiceCall.getState().resync();
    expect(useVoiceCall.getState().phase).toBe("connected");
    vi.mocked(e.engine.resync!).mockResolvedValue({ state: "ended", reason: "network", muted: false, consent: null });
    await useVoiceCall.getState().resync();
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(sent).toEqual([["s1", "vc_r9"]]);
  });
});

describe("which recording notice is up", () => {
  it("a new recording or version is a new key; the same notice read again is not", () => {
    const sheet = {
      ask: "in_call" as const,
      recordingId: "77",
      noticeVersion: 3,
      title: "t",
      text: "x",
      choices: [{ label: "Allow", granted: true }],
    };
    expect(consentKey(null)).toBeNull();
    expect(consentKey(sheet)).toBe(consentKey({ ...sheet, text: "x" }));
    expect(consentKey(sheet)).not.toBe(consentKey({ ...sheet, noticeVersion: 4 }));
    expect(consentKey(sheet)).not.toBe(consentKey({ ...sheet, recordingId: "78" }));
  });
});
