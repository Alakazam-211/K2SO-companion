import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

import { askCamera, parseConsentSheet, parseSnapshot, sewVoiceEngine, shareCallLog } from "./sewVoice";

beforeEach(() => {
  handlers.clear();
  invoke.mockReset();
});

describe("Sew's native engine, from the webview", () => {
  it("joins by server id and room, and follows the plugin's events", async () => {
    invoke.mockResolvedValue({ call_id: "c1" });
    const states: string[] = [];
    const muted: boolean[] = [];
    const e = sewVoiceEngine();
    await e.join("s1", "room-1", {
      onState: (s, r) => void states.push(r ? `${s}:${r}` : s),
      onSelfMute: (m) => void muted.push(m),
    });
    expect(invoke).toHaveBeenCalledWith("plugin:sew-voice|join", { target: "s1", room: "room-1" });
    handlers.get("sew-voice://state")?.({
      payload: { state: "consent_required", recording_id: "7", notice_version: 3 },
    });
    handlers.get("sew-voice://state")?.({ payload: { state: "connected", target: "s1", room: "room-1" } });
    handlers.get("sew-voice://participants")?.({
      payload: [
        { is_self: false, muted: true },
        { is_self: true, muted: false, deafened: true },
      ],
    });
    handlers.get("sew-voice://state")?.({ payload: { state: "ended", reason: "left" } });
    await vi.waitFor(() => expect(states).toEqual(["held", "connected", "ended:left"]));
    expect(muted).toEqual([true]);
  });

  it("Join with camera goes through K2's voice_join_camera (Sew's join_with, a video call)", async () => {
    invoke.mockResolvedValue({ call_id: "c1" });
    const e = sewVoiceEngine();
    expect(e.cameraJoin).toBe(true);
    await e.join("s1", "room-1", { onState: () => {} }, { camera: true });
    expect(invoke).toHaveBeenCalledWith("voice_join_camera", { target: "s1", room: "room-1" });
    expect(invoke).not.toHaveBeenCalledWith("plugin:sew-voice|join", expect.anything());
    invoke.mockRejectedValueOnce({ code: "room_full", detail: null });
    await expect(e.join("s1", "room-1", { onState: () => {} }, { camera: true })).rejects.toMatchObject({ code: "room_full" });
  });

  it("the camera permission: asks iOS only when never asked", async () => {
    const answer = (perm: string, after?: string) =>
      invoke.mockReset().mockImplementation(async (cmd: string) => (cmd.endsWith("|request_camera_permission") ? after : perm));
    answer("granted");
    expect(await askCamera()).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    answer("prompt", "granted");
    expect(await askCamera()).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith("plugin:sew-voice|request_camera_permission");
    answer("prompt", "denied");
    expect(await askCamera()).toEqual({ ok: false, code: "camera_permission_denied" });
    answer("prompt", "prompt");
    expect(await askCamera()).toEqual({ ok: false, code: "camera_permission_not_determined" });
    answer("denied");
    expect(await askCamera()).toEqual({ ok: false, code: "camera_permission_denied" });
    expect(invoke).not.toHaveBeenCalledWith("plugin:sew-voice|request_camera_permission");
  });

  it("a leave K2 made itself ends with K2's reason, live and on resync", async () => {
    const why = (cmd: string) => (cmd === "voice_ended_why" ? "recording_consent_timeout" : null);
    invoke.mockImplementation(async (cmd: string) => why(cmd) ?? { call_id: "c1" });
    const states: string[] = [];
    const e = sewVoiceEngine();
    await e.join("s1", "room-1", { onState: (s, r) => void states.push(r ? `${s}:${r}` : s) });
    handlers.get("sew-voice://state")?.({ payload: { state: "ended", reason: "left" } });
    await vi.waitFor(() => expect(states).toEqual(["ended:recording_consent_timeout"]));
    // Any other reason is the engine's own; no ask.
    invoke.mockClear();
    handlers.get("sew-voice://state")?.({ payload: { state: "ended", reason: "kicked" } });
    await vi.waitFor(() => expect(states).toContain("ended:kicked"));
    expect(invoke).not.toHaveBeenCalledWith("voice_ended_why");

    invoke.mockImplementation(async (cmd: string) =>
      cmd === "plugin:sew-voice|state" ? { state: "ended", reason: "left" } : why(cmd)
    );
    const now = await e.resync?.({ onState: () => {} });
    expect(now).toMatchObject({ state: "ended", reason: "recording_consent_timeout" });
  });

  it("Send call log shares Rust's text as a file", async () => {
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { share, canShare: () => true });
    invoke.mockResolvedValue("K2 call log (K2 4.2.0, iOS). Times are UTC.\n");
    await expect(shareCallLog()).resolves.toBe("shared");
    expect(invoke).toHaveBeenCalledWith("voice_call_log");
    const files = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files;
    expect(files[0].name).toBe("K2 call log.txt");
    expect(await files[0].text()).toContain("K2 call log");
    invoke.mockRejectedValue(new Error("no command"));
    await expect(shareCallLog()).resolves.toBe("failed");
  });

  it("a refusal comes back as the app's code, with the server's hint", async () => {
    invoke.mockRejectedValue({ code: "room_full", detail: { hint: "full", details: null } });
    await expect(sewVoiceEngine().join("s1", "r", { onState: () => {} })).rejects.toEqual({
      code: "room_full",
      hint: "full",
    });
    invoke.mockRejectedValue({ code: "device_session_ended", detail: { hint: null } });
    await expect(sewVoiceEngine().join("s1", "r", { onState: () => {} })).rejects.toEqual({
      code: "device_session_ended",
    });
  });

  it("consent sends the version the person saw", async () => {
    invoke.mockResolvedValue(null);
    await sewVoiceEngine().consent?.(true, 3141);
    expect(invoke).toHaveBeenCalledWith("plugin:sew-voice|consent", { granted: true, notice_version: 3141 });
  });

  it("reads Rust's notice facts (K2's own notice), and nothing else", () => {
    const sheet = {
      ask: "join",
      noticeVersion: 3141,
      startedByName: "Alice",
      required: true,
      audioKeepDays: 7,
      appReaders: ["Notes", 4],
      agentReaders: true,
    };
    expect(parseConsentSheet(sheet)).toEqual({ ...sheet, appReaders: ["Notes"] });
    expect(parseConsentSheet({ ...sheet, recordingId: "77" })).toMatchObject({ recordingId: "77" });
    expect(parseConsentSheet({ ask: "in_call", noticeVersion: 1 })).toEqual({
      ask: "in_call",
      noticeVersion: 1,
      startedByName: null,
      required: false,
      audioKeepDays: 0,
      appReaders: [],
      agentReaders: false,
    });
    expect(parseConsentSheet(null)).toBeNull();
    expect(parseConsentSheet({ ...sheet, noticeVersion: "3" })).toBeNull();
  });

  it("reads the plugin's state snapshot (Sew's contract fixtures)", () => {
    const speakDenied = {
      state: "connected",
      participants: [{ member_id: "9", is_self: true, muted: true, deafened: false, speak_denied: true }],
      call_id: "r_x",
      target: "k2:acme",
      room: "48831765147549698",
    };
    expect(parseSnapshot(speakDenied, null)).toEqual({
      state: "connected",
      serverId: "k2:acme",
      roomId: "48831765147549698",
      muted: true,
      consent: null,
      // No SPEAK: a mute no button of yours undoes.
      muteLocked: true,
    });
    expect(parseSnapshot({ state: "consent_required", participants: [], call_id: null }, null).state).toBe("held");
    expect(parseSnapshot({ state: "idle", participants: [] }, null)).toEqual({
      state: "idle",
      muted: false,
      consent: null,
    });
    expect(parseSnapshot(null, null).state).toBe("idle");
    // `has_video` rides the state only while true.
    expect(parseSnapshot({ state: "connected", participants: [], has_video: true }, null).video).toBe(true);
  });

  it("your own row's deafen and a moderator's holds; deafen goes as mute {deafened}", async () => {
    invoke.mockResolvedValue({ call_id: "c1" });
    const seen: unknown[] = [];
    const e = sewVoiceEngine();
    await e.join("s1", "room-1", { onState: () => {}, onSelfMute: (m, f) => void seen.push([m, f]) });
    handlers.get("sew-voice://participants")?.({
      payload: [{ is_self: true, muted: false, deafened: false, server_muted: true, server_deafened: false }],
    });
    handlers.get("sew-voice://participants")?.({
      payload: [{ is_self: true, muted: true, deafened: true, server_deafened: true, speak_denied: false }],
    });
    expect(seen).toEqual([
      [false, { deafened: false, muteLocked: true, deafLocked: false }],
      [true, { deafened: true, muteLocked: false, deafLocked: true }],
    ]);
    e.setDeafened?.(true);
    e.setDeafened?.(false, false);
    expect(invoke).toHaveBeenCalledWith("plugin:sew-voice|mute", { deafened: true });
    expect(invoke).toHaveBeenCalledWith("plugin:sew-voice|mute", { muted: false, deafened: false });
    expect(parseSnapshot({ state: "connected", participants: [{ is_self: true, muted: true, deafened: true }] }, null)).toMatchObject({
      muted: true,
      deafened: true,
    });
  });

  it("follows the call's video (k2-voice://video, Sew's video_changed)", async () => {
    invoke.mockResolvedValue({ call_id: "c1" });
    const video: boolean[] = [];
    await sewVoiceEngine().join("s1", "room-1", { onState: () => {}, onVideo: (on) => void video.push(on) });
    handlers.get("k2-voice://video")?.({ payload: true });
    handlers.get("k2-voice://video")?.({ payload: false });
    expect(video).toEqual([true, false]);
  });

  it("resync asks for the state and the notice together", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "voice_consent" ? null : { state: "connected", participants: [] }
    );
    const now = await sewVoiceEngine().resync?.({ onState: () => {} });
    expect(now?.state).toBe("connected");
    expect(invoke).toHaveBeenCalledWith("plugin:sew-voice|state");
    expect(invoke).toHaveBeenCalledWith("voice_consent");
  });
});
