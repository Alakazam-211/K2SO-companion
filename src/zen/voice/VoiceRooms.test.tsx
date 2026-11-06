// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));
const api = vi.hoisted(() => ({ rooms: vi.fn() }));
vi.mock("./voiceApi", async (orig) => ({ ...(await orig<typeof import("./voiceApi")>()), fetchVoiceRooms: api.rooms }));
const hub = vi.hoisted(() => ({ subscribe: vi.fn(() => ({ stop() {} })) }));
vi.mock("../ticketEvents", () => ({ subscribeAppEvents: hub.subscribe }));
const ios = vi.hoisted(() => ({ on: false, share: vi.fn() }));
vi.mock("../../lib/nativePicker", async (orig) => ({
  ...(await orig<typeof import("../../lib/nativePicker")>()),
  isIosWebView: () => ios.on,
}));
vi.mock("./sewVoice", async (orig) => ({
  ...(await orig<typeof import("./sewVoice")>()),
  shareCallLog: ios.share,
}));
const scopes = vi.hoisted(() => ({ hosts: new Set<string>() }));
vi.mock("../../api/scope", async (orig) => ({
  ...(await orig<typeof import("../../api/scope")>()),
  scopeFor: (id: string) => ({ id, supports: (f: string) => f === "voice-rooms-v1" && scopes.hosts.has(id) }),
}));

import { useServersStore, type ServerEntry } from "../../stores/servers";
import { __resetPipForTests, __setTileSenderForTests, HIDDEN, onPipEvent, type TileFrame } from "./videoTile";
import type { CallShim } from "./callShim";
import { __resetVoiceCallForTests, __setCallShimForTests, setPhoneVoiceEngine, useVoiceCall } from "./voiceCall";
import { voiceServers, VoiceRoomsOverlay } from "./VoiceRooms";

const server = (id: string, nickname: string) =>
  ({ id, nickname, url: `https://${id}.k2.dev` }) as unknown as ServerEntry;
const LIST = {
  ok: true,
  list: {
    hosting: { state: "ok", line: null, detail: null },
    rev: 1,
    canManage: false,
    feedLive: true,
    me: null as unknown,
    rooms: [
      {
        id: "room-1",
        name: "Standup",
        limit: 25,
        closing: false,
        closesAt: null,
        unavailable: null,
        occupants: [
          { user: "baden", name: "Baden", role: null, color: null, muted: false, deafened: false, speaking: false },
        ],
      },
      {
        id: "room-2",
        name: "Full one",
        limit: 1,
        closing: false,
        closesAt: null,
        unavailable: "room_full",
        occupants: [],
      },
    ],
  },
};

beforeEach(() => {
  __resetVoiceCallForTests();
  __resetPipForTests();
  scopes.hosts = new Set(["s1"]);
  api.rooms.mockReset();
  api.rooms.mockResolvedValue(LIST);
  useServersStore.setState({
    servers: [server("s1", "sewlab"), server("s2", "akzm")],
    tokens: { s1: "t1", s2: "t2" },
    activeServerId: "s2",
  });
});
afterEach(cleanup);

describe("voice rooms on the phone", () => {
  it("lists only signed-in servers that host rooms, this one first", () => {
    scopes.hosts = new Set(["s1", "s2", "s3"]);
    const all = [server("s1", "zeta"), server("s2", "alpha"), server("s3", "beta")];
    expect(voiceServers(all, { s1: "a", s2: "b" }, "s1").map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("shows each room with who's in it; a full room can't be joined", async () => {
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect(await screen.findByText("Standup")).toBeTruthy();
    expect(screen.getByText("Baden")).toBeTruthy();
    const rows = screen.getAllByTestId("voice-room-join");
    expect(rows.map((b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([
      ["Join", false],
      ["Full", true],
    ]);
    expect(screen.queryByTestId("voice-server-s2")).toBeNull();
    expect(hub.subscribe).toHaveBeenCalled();
  });

  it("Join in a build without call audio says so, and no call starts", async () => {
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("voice-room-join"))[0]);
    await waitFor(() => expect(screen.getByTestId("voice-notice").textContent).toMatch(/later K2 update/));
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(screen.queryByTestId("voice-call-bar")).toBeNull();
  });

  it("says when a server needs signing in again", async () => {
    api.rooms.mockResolvedValue({ ok: false, code: "signin_required", status: 401 });
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect((await screen.findByTestId("voice-server-problem")).textContent).toBe(
      "Sign in to sewlab again to see its rooms."
    );
  });

  it("with no hosting server, says where rooms come from", () => {
    scopes.hosts = new Set();
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect(screen.getByTestId("voice-empty").textContent).toMatch(/Linux servers with Pro/);
  });

  it("offers to move a call from another device here, or to rejoin this phone's", async () => {
    api.rooms.mockResolvedValue({
      ...LIST,
      list: {
        ...LIST.list,
        me: {
          inCall: true,
          roomId: "room-1",
          roomName: "Standup",
          here: false,
          elsewhere: true,
          on: { kind: "login" },
          callId: null,
        },
      },
    });
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect((await screen.findByTestId("voice-me-offer")).textContent).toMatch(/You're in Standup on your computer/);
    expect(screen.getByTestId("voice-me-action").textContent).toBe("Move here");
    cleanup();
    api.rooms.mockResolvedValue({
      ...LIST,
      list: {
        ...LIST.list,
        me: {
          inCall: true,
          roomId: "room-1",
          roomName: "Standup",
          here: true,
          elsewhere: false,
          on: null,
          callId: "c1",
        },
      },
    });
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect((await screen.findByTestId("voice-me-action")).textContent).toBe("Rejoin");
  });

  it("an ended pairing says pair again, not sign in", async () => {
    api.rooms.mockResolvedValue({ ok: false, code: "device_session_ended", status: 403 });
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect((await screen.findByTestId("voice-server-problem")).textContent).toMatch(/Pair it again/);
  });

  it("shows a recording notice with the kit's answers, and sends the one picked", async () => {
    const answer = vi.fn(async () => {});
    useVoiceCall.setState({
      phase: "joining",
      room: { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 },
      consent: {
        ask: "join",
        noticeVersion: 3141,
        title: "This call is being recorded",
        text: "Sew Notes records this call.",
        choices: [
          { label: "Join and allow recording", granted: true },
          { label: "Join without being recorded", granted: false },
          { label: "Cancel", granted: null },
        ],
      },
      answerConsent: answer,
    });
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect(screen.getByTestId("voice-consent").textContent).toContain("This call is being recorded");
    expect(screen.getByTestId("voice-call-bar").textContent).toContain("Waiting for your answer…");
    const choices = screen.getAllByTestId("voice-consent-choice").map((b) => b.textContent);
    expect(choices).toEqual(["Join and allow recording", "Join without being recorded", "Cancel"]);
    fireEvent.click(screen.getAllByTestId("voice-consent-choice")[1]);
    expect(answer).toHaveBeenCalledWith(false);
  });

  it("in a call with video, shows the tile once a frame plays; the tap starts PiP; a stall takes it away", async () => {
    const { invoke, addPluginListener } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(addPluginListener)
      .mockReset()
      .mockResolvedValue({ unregister: vi.fn() } as never);
    __resetPipForTests();
    const room = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
    useVoiceCall.setState({ phase: "connected", room });
    ios.on = true;
    try {
      render(<VoiceRoomsOverlay onClose={() => {}} />);
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      // Video, but no frame yet: no empty tile.
      act(() => useVoiceCall.setState({ video: true }));
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      act(() => onPipEvent({ event: "pip_first_frame" }));
      expect(screen.getByTestId("voice-video-tile")).toBeTruthy();
      expect(screen.queryByTestId("voice-video-line")).toBeNull();
      // No new frame for a while (a muted camera, a lost stream): gone.
      vi.mocked(invoke).mockClear();
      act(() => onPipEvent({ event: "pip_stalled" }));
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
      // The layer went under the page with it.
      expect(invoke).toHaveBeenCalledWith("plugin:k2-push|call_op", { op: "pipFrame", visible: false });
      act(() => onPipEvent({ event: "pip_first_frame" }));
      fireEvent.click(screen.getByTestId("voice-video-tile"));
      expect(invoke).toHaveBeenCalledWith("plugin:k2-push|call_op", { op: "pip", on: true });
      act(() => onPipEvent({ event: "pip_started" }));
      expect(screen.getByTestId("voice-video-line").textContent).toBe("Playing in Picture in Picture");
      act(() => useVoiceCall.setState({ video: false }));
      expect(screen.queryByTestId("voice-video-tile")).toBeNull();
    } finally {
      ios.on = false;
    }
  });

  it("the recording sheet over the tile sends the layer under the page", async () => {
    const sent: TileFrame[] = [];
    __setTileSenderForTests((f) => void sent.push(f));
    const room = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
    const sheet = {
      ask: "in_call" as const,
      noticeVersion: 1,
      title: "t",
      text: "x",
      choices: [{ label: "OK", granted: true }],
    };
    useVoiceCall.setState({ phase: "connected", room, video: true });
    onPipEvent({ event: "pip_first_frame" });
    try {
      render(<VoiceRoomsOverlay onClose={() => {}} />);
      sent.length = 0;
      act(() => useVoiceCall.setState({ consent: sheet }));
      expect(screen.getByTestId("voice-video-tile")).toBeTruthy();
      expect(sent).toEqual([HIDDEN]);
    } finally {
      __setTileSenderForTests(null);
    }
  });

  it("Join with camera is offered beside Join where the engine can, and joins with the camera", async () => {
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    await screen.findAllByTestId("voice-room-join");
    // A build without camera joins: no button.
    expect(screen.queryByTestId("voice-room-join-camera")).toBeNull();
    cleanup();
    const join = vi.fn(async () => {});
    setPhoneVoiceEngine({
      available: true,
      drivesSystemCall: true,
      cameraJoin: true,
      join,
      cameraPermission: async () => ({ ok: true }),
      leave: async () => {},
      setMuted: () => {},
      system: () => {},
    });
    __setCallShimForTests({ label: vi.fn(), microphone: vi.fn(async () => "granted") } as unknown as CallShim);
    render(<VoiceRoomsOverlay onClose={() => {}} />);
    const buttons = await screen.findAllByTestId("voice-room-join-camera");
    // Not on the full room.
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute("aria-label")).toBe("Join Standup with camera");
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(join).toHaveBeenCalledWith("s1", "room-1", expect.anything(), { camera: true }));
  });

  it("Send call log shows on the phone's engine only, and says when it couldn't", async () => {
    ios.on = false;
    const { unmount } = render(<VoiceRoomsOverlay onClose={() => {}} />);
    expect(screen.queryByTestId("voice-send-log")).toBeNull();
    unmount();
    ios.on = true;
    ios.share.mockReset().mockResolvedValueOnce("shared").mockResolvedValueOnce("failed");
    try {
      render(<VoiceRoomsOverlay onClose={() => {}} />);
      fireEvent.click(screen.getByTestId("voice-send-log"));
      await waitFor(() => expect(ios.share).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("voice-call-log").textContent).not.toMatch(/Couldn't/);
      fireEvent.click(screen.getByTestId("voice-send-log"));
      await waitFor(() => expect(screen.getByTestId("voice-call-log").textContent).toMatch(/Couldn't get the call log/));
    } finally {
      ios.on = false;
    }
  });
});
