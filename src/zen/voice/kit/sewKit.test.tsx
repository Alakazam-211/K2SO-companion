// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One fake plugin behind both the call store's engine and the kit: its
// commands (`invoke`) and its events, with every listener of a name.
const plugin = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
  const answers: Record<string, unknown> = {};
  const invoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd in answers) return answers[cmd];
    if (cmd === "plugin:sew-voice|state") return { state: "idle", participants: [], call_id: null };
    if (cmd === "plugin:sew-voice|call_details") return { security: null, quality: { quality: "unknown" }, roster: [], incoming: null };
    return null;
  });
  return {
    listeners,
    answers,
    invoke,
    emit(name: string, payload: unknown) {
      for (const cb of [...(listeners.get(name) ?? [])]) cb({ payload });
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: plugin.invoke,
  addPluginListener: vi.fn(),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const set = plugin.listeners.get(name) ?? new Set();
    set.add(cb);
    plugin.listeners.set(name, set);
    return () => set.delete(cb);
  }),
}));
// The native path must never load the browser's media stack.
vi.mock("livekit-client", () => {
  throw new Error("livekit-client loaded on the native path");
});
vi.mock("@sew/e2ee", () => {
  throw new Error("@sew/e2ee loaded on the native path");
});
const api = vi.hoisted(() => ({ rooms: vi.fn() }));
vi.mock("../voiceApi", async (orig) => ({ ...(await orig<typeof import("../voiceApi")>()), fetchVoiceRooms: api.rooms }));
vi.mock("../../ticketEvents", () => ({ subscribeAppEvents: () => ({ stop() {} }) }));
vi.mock("../../../api/scope", async (orig) => ({
  ...(await orig<typeof import("../../../api/scope")>()),
  scopeFor: (id: string) => ({ id, supports: (f: string) => f === "voice-rooms-v1" && id === "s1" }),
}));

import { NativeVoiceController } from "@sew/voice";
import { useServersStore, type ServerEntry } from "../../../stores/servers";
import type { CallShim } from "../callShim";
import { sewVoiceEngine } from "../sewVoice";
import { __resetVoiceCallForTests, __setCallShimForTests, setPhoneVoiceEngine, useVoiceCall } from "../voiceCall";
import { __resetPipForTests, __setTileSenderForTests, HIDDEN, onPipEvent, type TileFrame } from "../videoTile";
import { __resetVoiceNamesForTests, useVoiceNames } from "../voiceNames";
import { VoiceRoomsOverlay } from "../VoiceRooms";
import { CallTile } from "../callTile";
import KitCall, { kitNames } from "./KitCall";
import { facingOf, LAYER_HANDLE, liveOf, mirrorFor, shownOf, STARTING_MS } from "./layerVideo";
import {
  __resetSewKitForTests,
  k2Bridge,
  phoneSnapshot,
  kitChannelId,
  kitRoomOf,
  NOT_THROUGH_KIT,
  SEW_API_UNAVAILABLE,
  sewKit,
  type BaseBridge,
} from "./sewKit";

const ROOM = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
const CHANNEL = kitChannelId("s1", "room-1");
const OCCUPANTS = [
  { user: "baden", name: "Baden", memberId: "m-baden", role: null, color: "#5e5ce6", muted: false, deafened: false, speaking: false },
  { user: "owner", name: null, memberId: "m-me", role: null, color: null, muted: false, deafened: false, speaking: false },
];
const ROOMS = [
  { id: "room-1", name: "Standup", channelId: "4883", limit: 25, occupants: OCCUPANTS, closing: false, closesAt: null, unavailable: null },
];
const PEOPLE = [
  { member_id: "m-me", is_self: true, muted: false, deafened: false, server_muted: false, server_deafened: false },
  { member_id: "m-baden", is_self: false, muted: true, deafened: false, server_muted: false, server_deafened: false },
];

const shim: CallShim = {
  label: vi.fn(),
  start: vi.fn(async () => null),
  report: vi.fn(),
  setMuted: vi.fn(),
  end: vi.fn(),
  microphone: vi.fn(async () => "granted" as const),
  listen: vi.fn(() => () => {}),
} as unknown as CallShim;

const calls = (name: string) =>
  plugin.invoke.mock.calls.filter(([cmd]) => cmd === `plugin:sew-voice|${name}`).map(([, args]) => args);

/** The store joins (as Join in the rooms list does) and the plugin says so. */
async function storeJoinsAndConnects() {
  await act(async () => {
    await useVoiceCall.getState().join(ROOM);
  });
  act(() => {
    plugin.emit("sew-voice://state", { state: "connecting", target: "s1", room: "room-1" });
    plugin.emit("sew-voice://participants", PEOPLE);
    plugin.emit("sew-voice://state", { state: "connected", target: "s1", room: "room-1" });
  });
}

beforeEach(() => {
  localStorage.clear();
  __resetPipForTests();
  plugin.listeners.clear();
  plugin.invoke.mockClear();
  for (const k of Object.keys(plugin.answers)) delete plugin.answers[k];
  __resetSewKitForTests();
  __resetVoiceCallForTests();
  __resetVoiceNamesForTests();
  __setCallShimForTests(shim);
  setPhoneVoiceEngine(sewVoiceEngine());
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "sewlab", url: "https://s1.k2.dev", username: "rosson" } as unknown as ServerEntry],
    tokens: { s1: "t1" },
    activeServerId: "s1",
  });
  api.rooms.mockReset().mockResolvedValue({
    ok: true,
    list: { hosting: { state: "ok", line: null, detail: null }, rev: 1, canManage: false, feedLive: true, me: null, rooms: ROOMS },
  });
});
afterEach(() => {
  cleanup();
  __resetSewKitForTests();
});

describe("Sew's call kit on the phone", () => {
  it("is the native controller, on our bridge, over the plugin", async () => {
    const { controller } = sewKit();
    expect(controller).toBeInstanceOf(NativeVoiceController);
    await (controller as NativeVoiceController).started;
    // It read the call as the plugin has it, and its details (sew-voice:allow-call-details).
    expect(calls("state").length).toBeGreaterThanOrEqual(1);
    expect(calls("call_details")).toHaveLength(1);
    expect(plugin.listeners.get("sew-voice://state")?.size).toBe(1);
    // Our video hook over the kit's PluginVideo: it reads the camera's caps,
    // and opens no sinks (no remote ones ever; yours only with your camera).
    await waitFor(() => expect(calls("video_caps")).toHaveLength(1));
    expect(calls("video_sink")).toEqual([]);
    // It never asks for the camera on its own.
    expect(calls("request_camera_permission")).toEqual([]);
    expect(calls("camera")).toEqual([]);
  });

  it("adopts the call the store started; the kit never joins", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    // One join, the store's, by K2 server id; after the mic and the CallKit label.
    expect(calls("join")).toEqual([{ target: "s1", room: "room-1" }]);
    expect(shim.microphone).toHaveBeenCalled();
    expect(shim.label).toHaveBeenCalledWith("Standup", "sewlab");
    const v = controller.snapshot();
    expect(v.phase).toBe("connected");
    expect(v.channelId).toBe(CHANNEL);
    expect(v.participants.map((p) => [p.memberId, p.local, p.micMuted])).toEqual([
      ["m-me", true, false],
      ["m-baden", false, true],
    ]);
    expect(controller.me()).toBe("m-me");
  });

  it("also adopts a call already up when the call screen first opens", async () => {
    plugin.answers["plugin:sew-voice|state"] = { state: "connected", target: "s1", room: "room-1", participants: PEOPLE, call_id: null };
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    expect(controller.snapshot().phase).toBe("connected");
    expect(controller.snapshot().channelId).toBe(CHANNEL);
  });

  it("Mute, Deafen and Leave reach the plugin; Leave goes through the store", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    useVoiceNames.getState().put("s1", ROOMS);
    render(<KitCall />);
    fireEvent.click(screen.getByTestId("voice-mute"));
    await waitFor(() => expect(calls("mute")).toEqual([{ muted: true }]));
    fireEvent.click(screen.getByTestId("voice-deafen"));
    await waitFor(() => expect(calls("mute")).toEqual([{ muted: true }, { deafened: true }]));
    fireEvent.click(screen.getByTestId("voice-leave"));
    await waitFor(() => expect(useVoiceCall.getState().phase).toBe("idle"));
    expect(calls("leave")).toHaveLength(1);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("never rings: no call_ring is dispatched, and the bridge refuses the kit's join and rings", async () => {
    const { controller } = sewKit();
    const dispatch = vi.spyOn(controller, "dispatch");
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect(await screen.findByTestId("voice-kit")).toBeTruthy();
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls("ring")).toEqual([]);

    const base: BaseBridge = { invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) };
    const bridge = k2Bridge(base);
    for (const cmd of ["join", "ring", "ring_ended"]) {
      await expect(bridge.invoke(`plugin:sew-voice|${cmd}`, {})).rejects.toMatchObject({ code: NOT_THROUGH_KIT });
    }
    expect(base.invoke).not.toHaveBeenCalled();
  });

  it("shows our recording notice, never the kit's", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    const prompt = {
      recording_id: "r1",
      notice_version: 3,
      decline_mode: "join_unrecorded",
      feature_label: "Sew Notes",
      recorder_name: "Bobbin",
      room: { channel_id: "4883", kind: "voice", name: "Standup" },
      started_by: null,
      transcript: { readable_by: ["channel_members"], posted_to_channel: true, e2ee: false },
      audio_keep_days: 30,
      admin_download: false,
      recorded_now: [],
    };
    await act(async () => {
      await useVoiceCall.getState().join(ROOM);
    });
    act(() => {
      plugin.emit("sew-voice://state", { state: "consent_required", target: "s1", room: "room-1", recording_id: "r1", notice_version: 3 });
      plugin.emit("sew-voice://recording", { recording_id: "r1", auto: true, my_consent: "pending", consent_prompt: prompt, participants: [], recorder_present: true });
      plugin.emit("k2-voice://consent", {
        ask: "join",
        recordingId: "r1",
        noticeVersion: 3,
        title: "This room is recorded",
        text: "Sew Notes records the call in Standup.",
        choices: [
          { label: "Join and allow recording", granted: true },
          { label: "Join without being recorded", granted: false },
          { label: "Cancel", granted: null },
        ],
      });
    });
    // The kit would ask: its controller has the held join's notice.
    expect(controller.snapshot().consent?.mode).toBe("join");
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect(await screen.findByTestId("voice-kit")).toBeTruthy();
    expect(screen.getByTestId("voice-consent").textContent).toContain("This room is recorded");
    expect(screen.queryByTestId("recording-consent")).toBeNull();
    expect(document.querySelectorAll("dialog")).toHaveLength(0);
  });

  it("the device check never opens (it would open the webview's own mic and camera)", async () => {
    const gum = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gum, enumerateDevices: vi.fn() }, configurable: true });
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    render(<KitCall />);
    fireEvent.click(screen.getByTestId("voice-devices"));
    expect(screen.queryByTestId("device-settings")).toBeNull();
    expect(gum).not.toHaveBeenCalled();
  });

  it("hides what needs Sew's API or a gateway: camera, screen, recording", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    render(<KitCall />);
    expect(screen.getByTestId("call-bar")).toBeTruthy();
    for (const id of ["voice-camera", "voice-screen", "recording-start", "recording-badge", "voice-members"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    await expect(
      (controller as unknown as { host: { send: (m: string, p: string) => Promise<unknown> } }).host.send("GET", "/members?ids=1")
    ).rejects.toMatchObject({ code: SEW_API_UNAVAILABLE });
  });

  it("names people and the room from the rooms list, yourself from your login", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    useVoiceNames.getState().put("s1", ROOMS);
    render(<KitCall />);
    expect(screen.getByTestId("call-channel").textContent).toBe("Standup · sewlab");
    const tiles = screen.getAllByTestId("voice-tile");
    expect(tiles.map((t) => t.getAttribute("data-member"))).toEqual(["m-me", "m-baden"]);
    // Yourself at once (the occupant has no display name: its user).
    expect(tiles[0].textContent).toContain("owner");

    const names = kitNames(ROOM, { s1: ROOMS }, () => "rosson");
    expect(names.memberName("m-baden")).toBe("Baden");
    expect(names.memberName("m-stranger")).toBe("Someone");
    // A moderator's move reports Sew's channel id: still the room's name.
    expect(names.channelName(kitChannelId("s1", "4883"))).toBe("Standup · sewlab");
    expect(kitNames(ROOM, {}, () => "rosson").memberName("m-me")).toBe("rosson");
    expect(kitRoomOf(kitChannelId("s/1", "room 1"))).toEqual({ serverId: "s/1", roomKey: "room 1" });
  });

  it("the call bar shows the call's time beside the room's name once connected, through a reconnect", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    useVoiceNames.getState().put("s1", ROOMS);
    await act(async () => {
      await useVoiceCall.getState().join(ROOM);
    });
    render(<KitCall />);
    // Joining: the room and its state, no time yet.
    expect(screen.getByTestId("voice-kit-joining").textContent).toContain("Joining…");
    expect(screen.queryByTestId("voice-call-duration")?.textContent ?? "").toBe("");
    act(() => {
      plugin.emit("sew-voice://state", { state: "connecting", target: "s1", room: "room-1" });
      plugin.emit("sew-voice://participants", PEOPLE);
      plugin.emit("sew-voice://state", { state: "connected", target: "s1", room: "room-1" });
    });
    await waitFor(() => expect(screen.getByTestId("voice-call-duration").textContent).toBe("\u00a0· 0:00"));
    // In the kit's text column, right after the room's name.
    const time = screen.getByTestId("voice-call-duration");
    expect(time.parentElement?.classList.contains("sv-bar-text")).toBe(true);
    expect(time.previousElementSibling).toBe(screen.getByTestId("call-channel"));
    expect(screen.getByTestId("call-channel").textContent).toBe("Standup · sewlab");
    act(() => useVoiceCall.setState({ startedAt: Date.now() - 754_000 }));
    expect(time.textContent).toBe("\u00a0· 12:34");
    // Reconnecting: the kit's status says so, the time stays.
    act(() => plugin.emit("sew-voice://state", { state: "reconnecting", target: "s1", room: "room-1" }));
    await waitFor(() => expect(useVoiceCall.getState().phase).toBe("reconnecting"));
    expect(screen.getByTestId("voice-call-duration").textContent).toBe("\u00a0· 12:34");
    act(() => plugin.emit("sew-voice://state", { state: "connected", target: "s1", room: "room-1" }));
    expect(screen.getByTestId("voice-call-duration").textContent).toBe("\u00a0· 12:34");
  });

  it("a speaking member's tile gets the ring", async () => {
    const { controller } = sewKit();
    await (controller as NativeVoiceController).started;
    await storeJoinsAndConnects();
    render(<KitCall />);
    act(() => plugin.emit("sew-voice://speaking", [{ member_id: "m-baden", level: 0.4 }]));
    const baden = screen.getAllByTestId("voice-tile").find((t) => t.getAttribute("data-member") === "m-baden");
    expect(baden?.getAttribute("data-speaking")).toBe("yes");
    expect(baden?.className).toContain("sv-speaking");
  });

  describe("the call's video on its person's tile", () => {
    const TRACKS = [
      { member_id: "m-baden", is_self: false, source: "camera", track: "TR_cam", codec: "h264", width: 640, height: 360, muted: false, paused: null },
      { member_id: "m-me", is_self: true, source: "camera", track: "local:camera", codec: "h264", width: 640, height: 360, muted: false, paused: null },
    ];
    const sent: TileFrame[] = [];
    let rect: () => DOMRect;
    beforeEach(() => {
      sent.length = 0;
      __setTileSenderForTests((f) => void sent.push(f));
      rect = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = () => ({ left: 20, top: 400, width: 320, height: 180, right: 340, bottom: 580, x: 20, y: 400, toJSON() {} }) as DOMRect;
    });
    afterEach(() => {
      __setTileSenderForTests(null);
      HTMLElement.prototype.getBoundingClientRect = rect;
    });

    async function inVideoCall() {
      useVoiceNames.getState().put("s1", ROOMS);
      const { controller } = sewKit();
      await (controller as NativeVoiceController).started;
      await storeJoinsAndConnects();
      act(() => {
        plugin.emit("sew-voice://video", TRACKS);
        plugin.emit("k2-voice://video", true);
        onPipEvent({ event: "pip_first_frame" });
      });
      return controller;
    }

    const hostTile = () => screen.getAllByTestId("voice-tile").find((t) => t.getAttribute("data-host") === "yes");

    it("the shown person's tile holds the layer: the kit's rect, our slot, the layer placed on it", async () => {
      await inVideoCall();
      render(<KitCall />);
      const tile = hostTile();
      expect(tile?.getAttribute("data-member")).toBe("m-baden");
      expect(tile?.querySelector('[data-testid="voice-host-slot"]')?.getAttribute("data-track")).toBe("TR_cam");
      expect(tile?.querySelector('[data-testid="voice-video-tile"]')).toBeTruthy();
      // Its name and mute mark below the picture, nothing over it.
      expect(tile?.querySelector('[data-testid="voice-tile-below"]')?.textContent).toContain("Baden");
      expect(sent[sent.length - 1]).toEqual({ visible: true, x: 20, y: 400, w: 320, h: 180, radius: 12 });
      // Never yourself: the sink never shows you.
      expect(screen.getAllByTestId("voice-tile").filter((t) => t.getAttribute("data-host") === "yes")).toHaveLength(1);
      // The tap is for Picture in Picture.
      expect(tile?.querySelector('[data-testid="voice-video-tile"]')?.getAttribute("aria-label")).toMatch(/Tap for Picture in Picture/);
    });

    it("follows Rust's speaker; the recording notice sends the layer under the page", async () => {
      await inVideoCall();
      render(<KitCall />);
      // Never yourself, whatever is said: no picture at all meanwhile.
      act(() => plugin.emit("k2-voice://pip_speaker", { member_id: "m-me", track: null }));
      expect(hostTile()).toBeUndefined();
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      act(() => plugin.emit("k2-voice://pip_speaker", { member_id: "m-baden", track: "TR_cam" }));
      expect(hostTile()?.getAttribute("data-member")).toBe("m-baden");
      act(() => useVoiceCall.setState({ consent: { ask: "in_call", noticeVersion: 1, title: "t", text: "x", choices: [{ label: "OK", granted: true }] } }));
      expect(sent[sent.length - 1]).toEqual(HIDDEN);
      act(() => useVoiceCall.setState({ consent: null }));
      expect(sent[sent.length - 1]?.visible).toBe(true);
      // Nobody left to show.
      act(() => plugin.emit("k2-voice://pip_speaker", { member_id: null, track: null }));
      expect(hostTile()).toBeUndefined();
    });

    it("video without a known person: the tile alone; no video: no tile", async () => {
      const { controller } = sewKit();
      await (controller as NativeVoiceController).started;
      await storeJoinsAndConnects();
      render(<KitCall />);
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      act(() => plugin.emit("k2-voice://video", true));
      // No frame yet: no empty tile.
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      act(() => onPipEvent({ event: "pip_first_frame" }));
      expect(screen.getByTestId("voice-video-tile")).toBeTruthy();
      expect(hostTile()).toBeUndefined();
      act(() => plugin.emit("k2-voice://video", false));
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
    });

    it("whose picture: Rust's word, else a screen share, else a camera; never without video", () => {
      const cam = TRACKS[0] as never;
      const scr = { ...TRACKS[0], member_id: "m-jer", source: "screen", track: "TR_scr" } as never;
      expect(shownOf([cam, scr], null, true)).toEqual({ memberId: "m-jer", source: "screen", track: "TR_scr" });
      expect(shownOf([cam], null, true)).toEqual({ memberId: "m-baden", source: "camera", track: "TR_cam" });
      expect(shownOf([cam, scr], { memberId: "m-baden", track: "TR_cam" }, true)?.memberId).toBe("m-baden");
      expect(shownOf([cam], { memberId: null, track: null }, true)).toBeNull();
      expect(shownOf([cam], null, false)).toBeNull();
      expect(shownOf([{ ...TRACKS[0], muted: true } as never], null, true)).toBeNull();
      // A switch that names only the track: its row says whose.
      expect(shownOf([cam], { memberId: null, track: "TR_cam" }, true)?.memberId).toBe("m-baden");
      expect(shownOf(TRACKS as never, { memberId: null, track: "local:camera" }, true)).toBeNull();
      // A paused camera (congestion, their app in the background) shows nothing either.
      expect(shownOf([{ ...TRACKS[0], paused: "background" } as never], null, true)).toBeNull();
      // Rust's speaker whose rows say muted or paused: nobody.
      expect(shownOf([{ ...TRACKS[0], muted: true } as never], { memberId: "m-baden", track: "TR_cam" }, true)).toBeNull();
      expect(shownOf([{ ...TRACKS[0], paused: "congestion" } as never], { memberId: "m-baden", track: "TR_cam" }, true)).toBeNull();
      // Never yourself, even if said.
      expect(shownOf(TRACKS as never, { memberId: "m-me", track: "local:camera" }, true)).toBeNull();
      // Live only with a frame on the layer, or in PiP.
      const s = shownOf([cam], null, true);
      expect(liveOf(s, { frame: false, active: false })).toBeNull();
      expect(liveOf(s, { frame: true, active: false })).toEqual(s);
      expect(liveOf(s, { frame: false, active: true })).toEqual(s);
    });

    it("a call screen opened after the sink's switch still puts the picture on that person's tile", async () => {
      plugin.answers["voice_pip_speaker"] = { member_id: "m-baden", track: "TR_cam" };
      // Video already on, rows already sent, before the kit existed.
      useVoiceCall.setState({ video: true });
      plugin.answers["plugin:sew-voice|state"] = { state: "connected", target: "s1", room: "room-1", participants: PEOPLE, call_id: "c1", video: TRACKS };
      await storeJoinsAndConnects();
      act(() => {
        plugin.emit("k2-voice://video", true);
        onPipEvent({ event: "pip_first_frame" });
      });
      useVoiceNames.getState().put("s1", ROOMS);
      const { controller, video } = sewKit();
      await (controller as unknown as NativeVoiceController).started;
      await waitFor(() => expect(video.shown()?.memberId).toBe("m-baden"));
      render(<KitCall />);
      await waitFor(() => expect(hostTile()?.getAttribute("data-member")).toBe("m-baden"));
      // On their tile, not a box of its own.
      expect(screen.getAllByTestId("voice-video-tile")).toHaveLength(1);
      expect(hostTile()?.querySelector('[data-testid="voice-video-tile"]')).toBeTruthy();
    });

    it("before the first frame: the person's avatar, 'Video starting…' for 3 s, then the plain avatar", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        useVoiceNames.getState().put("s1", ROOMS);
        const { controller } = sewKit();
        await (controller as NativeVoiceController).started;
        await storeJoinsAndConnects();
        render(<KitCall />);
        act(() => {
          plugin.emit("sew-voice://video", TRACKS);
          plugin.emit("k2-voice://video", true);
        });
        const baden = () => screen.getAllByTestId("voice-tile").find((t) => t.getAttribute("data-member") === "m-baden");
        expect(hostTile()).toBeUndefined();
        expect(baden()?.querySelector(".k2-kit-avatar")).toBeTruthy();
        expect(baden()?.querySelector('[data-testid="voice-avatar-note"]')?.textContent).toBe("Video starting…");
        expect(screen.queryByTestId("voice-video-tile")).toBeNull();
        act(() => void vi.advanceTimersByTime(STARTING_MS + 10));
        expect(baden()?.querySelector('[data-testid="voice-avatar-note"]')).toBeNull();
        expect(baden()?.querySelector(".k2-kit-avatar")).toBeTruthy();
        // The first frame: the picture on their tile.
        act(() => onPipEvent({ event: "pip_first_frame" }));
        expect(hostTile()?.getAttribute("data-member")).toBe("m-baden");
      } finally {
        vi.useRealTimers();
      }
    });

    it("back to the avatar when the video ends, their camera mutes or pauses, or frames stop", async () => {
      await inVideoCall();
      render(<KitCall />);
      expect(hostTile()?.getAttribute("data-member")).toBe("m-baden");
      // A stall (no frame for a while).
      act(() => onPipEvent({ event: "pip_stalled" }));
      expect(hostTile()).toBeUndefined();
      act(() => onPipEvent({ event: "pip_first_frame" }));
      expect(hostTile()).toBeTruthy();
      // Their camera muted.
      act(() => plugin.emit("sew-voice://video", [{ ...TRACKS[0], muted: true }, TRACKS[1]]));
      expect(hostTile()).toBeUndefined();
      // Paused.
      act(() => plugin.emit("sew-voice://video", [{ ...TRACKS[0], paused: "background" }, TRACKS[1]]));
      expect(hostTile()).toBeUndefined();
      act(() => plugin.emit("sew-voice://video", TRACKS));
      expect(hostTile()).toBeTruthy();
      // The layer cleared.
      act(() => onPipEvent({ event: "pip_cleared" }));
      expect(hostTile()).toBeUndefined();
      act(() => onPipEvent({ event: "pip_first_frame" }));
      // The video ended.
      act(() => plugin.emit("k2-voice://video", false));
      expect(hostTile()).toBeUndefined();
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
    });
  });

  describe("your camera", () => {
    const CAMERAS = {
      cameras: [
        { id: "cam-front", name: "Front Camera", facing: "front", default: true },
        { id: "cam-back", name: "Back Camera", facing: "back", default: false },
      ],
      camera: null,
      permission: { camera: "prompt", screen: "unsupported" },
    };
    const CAPS = {
      camera: true,
      screen: { supported: true, system_picker: true, list: false, windows: false },
      publish_codecs: ["vp8", "h264"],
      decode_codecs: ["vp8", "h264"],
      receive: true,
      backend: "apple",
    };
    const POLICY = { video_enabled: true, camera_allowed: true, screen_allowed: true };
    let rect: () => DOMRect;
    const sent: TileFrame[] = [];

    beforeEach(() => {
      plugin.answers["plugin:sew-voice|video_caps"] = CAPS;
      plugin.answers["plugin:sew-voice|video_devices"] = CAMERAS;
      plugin.answers["plugin:sew-voice|camera_permission"] = "granted";
      // A webview with WebCodecs: the self-view's sink can open.
      vi.stubGlobal("VideoDecoder", class {});
      vi.stubGlobal("EncodedVideoChunk", class {});
      sent.length = 0;
      __setTileSenderForTests((f) => void sent.push(f));
      rect = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = () => ({ left: 20, top: 400, width: 320, height: 180, right: 340, bottom: 580, x: 20, y: 400, toJSON() {} }) as DOMRect;
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      __setTileSenderForTests(null);
      HTMLElement.prototype.getBoundingClientRect = rect;
    });

    async function inCall() {
      useVoiceNames.getState().put("s1", ROOMS);
      const kit = sewKit();
      await (kit.controller as unknown as NativeVoiceController).started;
      await storeJoinsAndConnects();
      act(() => plugin.emit("sew-voice://policy", POLICY));
      await waitFor(() => expect(calls("video_caps")).toHaveLength(1));
      return kit;
    }
    const cameraButton = () => screen.queryByTestId("voice-camera");
    const selfTile = () => screen.getAllByTestId("voice-tile").find((t) => t.getAttribute("data-local") === "yes");

    it("the camera button shows when the room allows video; the screen button never does", async () => {
      await inCall();
      render(<KitCall />);
      await waitFor(() => expect(cameraButton()).toBeTruthy());
      expect(cameraButton()?.getAttribute("data-state")).toBe("off");
      expect(screen.queryByTestId("voice-screen")).toBeNull();
      // No switch while the camera is off.
      expect(screen.queryByTestId("voice-switch-camera")).toBeNull();
      // A room without video: no camera button.
      act(() => plugin.emit("sew-voice://policy", { ...POLICY, video_enabled: false }));
      expect(cameraButton()).toBeNull();
    });

    it("first use asks iOS (request_camera_permission), then turns the camera on", async () => {
      plugin.answers["plugin:sew-voice|camera_permission"] = "prompt";
      plugin.answers["plugin:sew-voice|request_camera_permission"] = "granted";
      await inCall();
      render(<KitCall />);
      await waitFor(() => expect(cameraButton()).toBeTruthy());
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(calls("camera")).toEqual([{ on: true }]));
      const order = plugin.invoke.mock.calls.map(([c]) => c).filter((c) => /camera/.test(c));
      expect(order.slice(0, 3)).toEqual(["plugin:sew-voice|camera_permission", "plugin:sew-voice|request_camera_permission", "plugin:sew-voice|camera"]);
      await waitFor(() => expect(cameraButton()?.getAttribute("data-state")).toBe("on"));
      // Off again: no prompt.
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(calls("camera")).toEqual([{ on: true }, { on: false }]));
      expect(calls("request_camera_permission")).toHaveLength(1);
    });

    it("a denial says where to turn it on (Settings › K2 › Camera), and the camera stays off", async () => {
      plugin.answers["plugin:sew-voice|camera_permission"] = "denied";
      await inCall();
      render(<KitCall />);
      await waitFor(() => expect(cameraButton()).toBeTruthy());
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(screen.getByTestId("voice-notice").textContent).toBe("Camera access is off. Turn it on in Settings › K2 › Camera."));
      expect(calls("camera")).toEqual([]);
      expect(calls("request_camera_permission")).toEqual([]);
      expect(cameraButton()?.getAttribute("data-state")).toBe("off");
      // Never answered (the prompt dismissed): the kit's own sentence.
      plugin.answers["plugin:sew-voice|camera_permission"] = "prompt";
      plugin.answers["plugin:sew-voice|request_camera_permission"] = "prompt";
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(screen.getByTestId("voice-notice").textContent).toBe("Allow camera access to turn your camera on."));
      expect(calls("camera")).toEqual([]);
    });

    it("the plugin's own refusal of a join's camera gets the same sentence", () => {
      const snap = { notice: { text: "Camera access is off. Turn it on in System Settings → Privacy & Security → Camera.", reason: "camera_permission_denied" } };
      expect(phoneSnapshot(snap as never).notice?.text).toBe("Camera access is off. Turn it on in Settings › K2 › Camera.");
      const other = { notice: { text: "x", reason: "media_busy" } };
      expect(phoneSnapshot(other as never)).toBe(other);
    });

    it("your self-view on your own tile, mirrored for the front camera; the flip switches to the back one, unmirrored", async () => {
      await inCall();
      render(<KitCall />);
      await waitFor(() => expect(cameraButton()).toBeTruthy());
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(calls("camera")).toEqual([{ on: true }]));
      act(() => plugin.emit("sew-voice://local_video", { camera: "on", screen: "off" }));
      await waitFor(() => expect(selfTile()?.querySelector('[data-testid="voice-self-view"]')).toBeTruthy());
      const view = () => selfTile()!.querySelector('[data-testid="voice-self-view"]')!;
      expect(view().getAttribute("data-mirrored")).toBe("yes");
      expect(selfTile()?.querySelector('[data-testid="voice-host-slot"]')?.getAttribute("data-track")).toBe("local:camera");
      // The flip: the camera facing the other way, live.
      fireEvent.click(await screen.findByTestId("voice-switch-camera"));
      await waitFor(() => expect(calls("set_video_device")).toEqual([{ camera: "cam-back" }]));
      await waitFor(() => expect(view().getAttribute("data-mirrored")).toBe("no"));
      fireEvent.click(screen.getByTestId("voice-switch-camera"));
      await waitFor(() => expect(calls("set_video_device")).toEqual([{ camera: "cam-back" }, { camera: "cam-front" }]));
      expect(facingOf(CAMERAS as never, null)).toBe("front");
      expect(facingOf({ ...CAMERAS, camera: "cam-back" } as never, null)).toBe("back");
      expect(mirrorFor("back")).toBe(false);
      expect(mirrorFor(null)).toBe(true);
    });

    it("your camera never goes on the native layer, so never into PiP", async () => {
      const kit = await inCall();
      render(<KitCall />);
      await waitFor(() => expect(cameraButton()).toBeTruthy());
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(calls("camera")).toEqual([{ on: true }]));
      act(() => {
        plugin.emit("sew-voice://local_video", { camera: "on", screen: "off" });
        plugin.emit("sew-voice://video", [{ member_id: "m-me", is_self: true, source: "camera", track: "local:camera", codec: "vp8", width: 1280, height: 720, muted: false, paused: null }]);
        // Only your camera: the call has video, and the sink has nobody to show.
        plugin.emit("k2-voice://video", true);
        plugin.emit("k2-voice://pip_speaker", { member_id: "m-me", track: "local:camera" });
        onPipEvent({ event: "pip_first_frame" });
      });
      await waitFor(() => expect(selfTile()?.querySelector('[data-testid="voice-self-view"]')).toBeTruthy());
      // Your tile draws you itself, in the page.
      expect(selfTile()?.querySelector('[data-testid="voice-video-tile"]')).toBeNull();
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      // The layer was never placed on your tile.
      expect(sent.filter((f) => f.visible)).toEqual([]);
      expect(kit.video.handles("me", true, "m-me").camera).not.toBe(LAYER_HANDLE);
      expect(kit.video.handles("me", false, "m-me")).toEqual({ camera: null, screen: null });
      expect(kit.video.live()).toBeNull();
      // No sink for anyone else ever opened through the kit.
      expect(calls("video_sink").every((a) => (a as { track?: string }).track === "local:camera")).toBe(true);
    });

    describe("on the floating tile (the call area closed)", () => {
      const tileCam = () => screen.queryByTestId("voice-call-tile-camera");
      const notes = () => plugin.invoke.mock.calls.filter(([c]) => c === "voice_note").map(([, a]) => (a as { words: string[] }).words);
      const press = (el: HTMLElement) => {
        fireEvent.pointerDown(el, { pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerUp(el, { pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.click(el);
      };

      it("the camera button: the kit's path through the permission step, logged as a person's tap", async () => {
        plugin.answers["plugin:sew-voice|camera_permission"] = "prompt";
        plugin.answers["plugin:sew-voice|request_camera_permission"] = "granted";
        await inCall();
        render(<CallTile callViewOpen={false} onOpen={() => {}} />);
        await waitFor(() => expect(tileCam()).toBeTruthy());
        // Camera on and off only: no switch, no screen share here.
        expect(screen.getByTestId("voice-call-tile").querySelectorAll("button")).toHaveLength(4);
        expect(tileCam()?.getAttribute("data-state")).toBe("off");
        press(tileCam()!);
        await waitFor(() => expect(calls("camera")).toEqual([{ on: true }]));
        const order = plugin.invoke.mock.calls.map(([c]) => c).filter((c) => /camera/.test(c));
        expect(order.slice(0, 3)).toEqual(["plugin:sew-voice|camera_permission", "plugin:sew-voice|request_camera_permission", "plugin:sew-voice|camera"]);
        expect(notes()).toContainEqual(["camera", "tap", "off"]);
        // On: you in the card's picture, "Camera on" until your first frame;
        // never on the native layer.
        act(() => plugin.emit("sew-voice://local_video", { camera: "on", screen: "off" }));
        await waitFor(() => expect(screen.getByTestId("voice-call-tile").getAttribute("data-picture")).toBe("self"));
        expect(tileCam()?.getAttribute("data-state")).toBe("on");
        expect(screen.getByTestId("voice-call-tile-camera-note").textContent).toBe("Camera on");
        expect(sent.filter((f) => f.visible)).toEqual([]);
        // Off again: the plain pill.
        press(tileCam()!);
        await waitFor(() => expect(calls("camera")).toEqual([{ on: true }, { on: false }]));
        expect(notes()).toContainEqual(["camera", "tap", "on"]);
        act(() => plugin.emit("sew-voice://local_video", { camera: "off", screen: "off" }));
        await waitFor(() => expect(screen.getByTestId("voice-call-tile").getAttribute("data-picture")).toBe("none"));
        // A room without video: no camera button.
        act(() => plugin.emit("sew-voice://policy", { ...POLICY, video_enabled: false }));
        await waitFor(() => expect(tileCam()).toBeNull());
      });

      it("a denied camera says so on the button, and nothing turns on", async () => {
        plugin.answers["plugin:sew-voice|camera_permission"] = "denied";
        await inCall();
        render(<CallTile callViewOpen={false} onOpen={() => {}} />);
        await waitFor(() => expect(tileCam()).toBeTruthy());
        press(tileCam()!);
        await waitFor(() => expect(tileCam()?.getAttribute("aria-label")).toBe("Camera access is off. Turn it on in Settings › K2 › Camera."));
        expect(calls("camera")).toEqual([]);
        expect(tileCam()?.getAttribute("data-state")).toBe("off");
      });
    });

    it("in the background: 'Camera paused' on your tile; after 5 minutes off, and the button says so", async () => {
      await inCall();
      render(<KitCall />);
      await waitFor(() => expect(cameraButton()).toBeTruthy());
      fireEvent.click(cameraButton()!);
      await waitFor(() => expect(calls("camera")).toEqual([{ on: true }]));
      act(() => plugin.emit("sew-voice://local_video", { camera: "on", screen: "off" }));
      act(() => plugin.emit("sew-voice://local_video", { camera: "paused", screen: "off", reason: "background" }));
      await waitFor(() => expect(selfTile()?.querySelector('[data-testid="voice-self-view"]')?.getAttribute("data-paused")).toBe("yes"));
      expect(selfTile()?.textContent).toContain("Camera paused");
      // The kit's bar says it too, and the button stays on (the track and tile stay).
      expect(screen.getByTestId("voice-video-paused").textContent).toMatch(/paused/i);
      expect(cameraButton()?.getAttribute("data-state")).toBe("on");
      // Back in front: on again.
      act(() => plugin.emit("sew-voice://local_video", { camera: "on", screen: "off" }));
      await waitFor(() => expect(selfTile()?.querySelector('[data-testid="voice-self-view"]')?.getAttribute("data-paused")).toBe("no"));
      // Five minutes away: off, and it stays off on return.
      act(() => plugin.emit("sew-voice://local_video", { camera: "paused", screen: "off", reason: "background" }));
      act(() => plugin.emit("sew-voice://local_video", { camera: "off", screen: "off", reason: "background" }));
      await waitFor(() => expect(cameraButton()?.getAttribute("data-state")).toBe("off"));
      expect(selfTile()?.querySelector('[data-testid="voice-self-view"]')).toBeNull();
      // Nothing of ours turns it back on.
      expect(calls("camera")).toEqual([{ on: true }]);
    });
  });
});
