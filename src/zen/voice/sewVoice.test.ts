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

import { parseConsentSheet, parseSnapshot, sewVoiceEngine, shareCallLog } from "./sewVoice";

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

  it("reads Rust's consent sheet, and nothing else", () => {
    const sheet = {
      ask: "join",
      noticeVersion: 3141,
      title: "This call is being recorded",
      text: "a\nb",
      choices: [
        { label: "Join and allow recording", granted: true },
        { label: "Cancel", granted: null },
      ],
    };
    expect(parseConsentSheet(sheet)).toEqual(sheet);
    expect(parseConsentSheet({ ...sheet, recordingId: "77" })).toEqual({ ...sheet, recordingId: "77" });
    expect(parseConsentSheet(null)).toBeNull();
    expect(parseConsentSheet({ ...sheet, choices: [] })).toBeNull();
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
    });
    expect(parseSnapshot({ state: "consent_required", participants: [], call_id: null }, null).state).toBe("held");
    expect(parseSnapshot({ state: "idle", participants: [] }, null)).toEqual({
      state: "idle",
      muted: false,
      consent: null,
    });
    expect(parseSnapshot(null, null).state).toBe("idle");
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
