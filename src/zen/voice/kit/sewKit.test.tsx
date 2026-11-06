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
vi.mock("@tauri-apps/api/core", () => ({ invoke: plugin.invoke, addPluginListener: vi.fn() }));
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
import { __setTileSenderForTests, HIDDEN, type TileFrame } from "../videoTile";
import { __resetVoiceNamesForTests, useVoiceNames } from "../voiceNames";
import { VoiceRoomsOverlay } from "../VoiceRooms";
import KitCall, { kitNames } from "./KitCall";
import { shownOf } from "./layerVideo";
import {
  __resetSewKitForTests,
  k2Bridge,
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
    // Our video hook, not the kit's PluginVideo: no sinks, no caps asked.
    expect(calls("video_caps")).toEqual([]);
    expect(calls("video_sink")).toEqual([]);
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
      // Never yourself, whatever is said: the picture alone meanwhile.
      act(() => plugin.emit("k2-voice://pip_speaker", { member_id: "m-me", track: null }));
      expect(hostTile()).toBeUndefined();
      expect(screen.getByTestId("voice-video-tile")).toBeTruthy();
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
    });
  });
});
