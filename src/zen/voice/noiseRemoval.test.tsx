// @vitest-environment jsdom
// Noise removal (Sew 0.10.4; Riley's rule): one On/Off switch in Settings →
// Calls, default On (Sew's "standard": DeepFilterNet3, RNNoise its fallback),
// Off = Sew's "off" (on iPhone, raw capture: `phone_mode: raw`). Stored on
// this phone; set on the engine before each join and live when switched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ios = vi.hoisted(() => ({ on: true }));
vi.mock("../../lib/nativePicker", async (orig) => ({
  ...(await orig<typeof import("../../lib/nativePicker")>()),
  isIosWebView: () => ios.on,
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));
vi.mock("../../lib/push", () => ({
  pushAvailability: vi.fn(async () => ({ available: true, platform: "apns" })),
  getPushEnabled: vi.fn(async () => false),
  setPushEnabled: vi.fn(async () => undefined),
  registerAllSignedIn: vi.fn(async () => undefined),
  unregisterAll: vi.fn(async () => undefined),
}));

import {
  NOISE_REMOVAL_KEY,
  applyNoiseRemoval,
  loadNoiseRemoval,
  noiseMode,
  saveNoiseRemoval,
  useNoiseRemovalStore,
} from "./noiseRemoval";
import { noiseWords, sewVoiceEngine } from "./sewVoice";
import { ZenSettings } from "../ZenSettings";

const SET = "plugin:sew-voice|set_noise_removal";
const standard = { mode: "standard", active: "standard", model: "dfn3" };

beforeEach(() => {
  localStorage.clear();
  ios.on = true;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { mode?: string }) =>
    cmd === SET ? { mode: args?.mode, active: args?.mode } : { call_id: "c1" }
  );
  handlers.clear();
  useNoiseRemovalStore.setState({ on: loadNoiseRemoval() });
});
afterEach(cleanup);

describe("the setting", () => {
  it("is On by default, and only an explicit Off turns it off", () => {
    expect(loadNoiseRemoval()).toBe(true);
    localStorage.setItem(NOISE_REMOVAL_KEY, "on");
    expect(loadNoiseRemoval()).toBe(true);
    localStorage.setItem(NOISE_REMOVAL_KEY, "off");
    expect(loadNoiseRemoval()).toBe(false);
  });

  it("persists under k2.voice.noiseRemoval", () => {
    saveNoiseRemoval(false);
    expect(localStorage.getItem("k2.voice.noiseRemoval")).toBe("off");
    saveNoiseRemoval(true);
    expect(localStorage.getItem("k2.voice.noiseRemoval")).toBe("on");
  });

  it("maps On to Sew's standard and Off to Sew's off", () => {
    expect(noiseMode(true)).toBe("standard");
    expect(noiseMode(false)).toBe("off");
  });

  it("the store keeps the choice and sets it on the engine at once (live in a call)", async () => {
    useNoiseRemovalStore.getState().setOn(false);
    expect(useNoiseRemovalStore.getState().on).toBe(false);
    expect(localStorage.getItem(NOISE_REMOVAL_KEY)).toBe("off");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(SET, { mode: "off" }));
    useNoiseRemovalStore.getState().setOn(true);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith(SET, { mode: "standard" }));
  });
});

describe("applyNoiseRemoval", () => {
  it("sends the stored choice and answers the plugin's state", async () => {
    saveNoiseRemoval(false);
    expect(await applyNoiseRemoval()).toEqual({ mode: "off", active: "off" });
    expect(invoke).toHaveBeenCalledWith(SET, { mode: "off" });
  });

  it("never throws: a plugin without the command answers null", async () => {
    invoke.mockRejectedValueOnce("command set_noise_removal not found");
    expect(await applyNoiseRemoval(true)).toBeNull();
  });

  it("does nothing where the build has no calls", async () => {
    ios.on = false;
    expect(await applyNoiseRemoval(true)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("a call", () => {
  it("sets the person's choice before the join, then joins", async () => {
    saveNoiseRemoval(false);
    await sewVoiceEngine().join("s1", "room-1", { onState: () => {} });
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds.indexOf(SET)).toBeGreaterThanOrEqual(0);
    expect(cmds.indexOf(SET)).toBeLessThan(cmds.indexOf("plugin:sew-voice|join"));
    expect(invoke).toHaveBeenCalledWith(SET, { mode: "off" });
    expect(invoke).toHaveBeenCalledWith("voice_note", { words: ["noise", "off", "off"] });
  });

  it("joins even when setting the mode fails (the engine's default, Standard)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === SET) throw { code: "noise_mode_unavailable" };
      return { call_id: "c1" };
    });
    await sewVoiceEngine().join("s1", "room-1", { onState: () => {} });
    expect(invoke).toHaveBeenCalledWith("plugin:sew-voice|join", { target: "s1", room: "room-1" });
  });

  it("logs the plugin's noise_removal events as codes (which model, why it stepped down)", async () => {
    await sewVoiceEngine().join("s1", "room-1", { onState: () => {} });
    handlers.get("sew-voice://noise_removal")?.({
      payload: { mode: "standard", active: "standard", model: "rnnoise", model_reason: "budget", step_downs: 2 },
    });
    expect(invoke).toHaveBeenCalledWith("voice_note", {
      words: ["noise", "standard", "standard", "rnnoise", "model_reason:budget", "step_downs:2"],
    });
    expect(noiseWords(standard)).toEqual(["noise", "standard", "standard", "dfn3"]);
    expect(noiseWords(null)).toBeNull();
  });

  it("logs the phone's capture: os/raw, a failed switch, the switches and the last pause", async () => {
    await sewVoiceEngine().join("s1", "room-1", { onState: () => {} });
    handlers.get("sew-voice://noise_removal")?.({
      payload: {
        mode: "off",
        active: "off",
        phone_mode: "os",
        phone_mode_reason: "switch_failed",
        phone_mode_switches: 3,
        phone_mode_gap_ms: 42,
      },
    });
    expect(invoke).toHaveBeenCalledWith("voice_note", {
      words: [
        "noise",
        "off",
        "off",
        "phone_mode:os",
        "phone_mode_reason:switch_failed",
        "phone_mode_switches:3",
        "phone_mode_gap_ms:42",
      ],
    });
    // A switch that reopened at once still says its pause.
    expect(noiseWords({ mode: "off", active: "off", phone_mode: "raw", phone_mode_switches: 1, phone_mode_gap_ms: 0 })).toEqual([
      "noise",
      "off",
      "off",
      "phone_mode:raw",
      "phone_mode_switches:1",
      "phone_mode_gap_ms:0",
    ]);
    expect(noiseWords({ ...standard, phone_mode: "os" })).toEqual(["noise", "standard", "standard", "dfn3", "phone_mode:os"]);
  });

  it("reads the model loading for the call plainly", () => {
    // Phones: the call starts on the system's processing alone while the model loads.
    expect(noiseWords({ mode: "standard", active: "off", reason: "loading", phone_mode: "os" })).toEqual([
      "noise",
      "standard",
      "off",
      "reason:loading",
      "phone_mode:os",
    ]);
    // Where RNNoise runs meanwhile.
    expect(noiseWords({ mode: "standard", active: "standard", model: "rnnoise", model_reason: "loading" })).toEqual([
      "noise",
      "standard",
      "standard",
      "rnnoise",
      "model_reason:loading",
    ]);
  });

  it("logs the stage's timing and grace window (Sew 0.10.4)", async () => {
    await sewVoiceEngine().join("s1", "room-1", { onState: () => {} });
    handlers.get("sew-voice://noise_removal")?.({
      payload: {
        mode: "standard",
        active: "standard",
        model: "rnnoise",
        model_reason: "budget",
        step_downs: 1,
        phone_mode: "os",
        step_down_reason: "slow_window",
        last_step_down_ms_ago: 1200,
        slowest_block_us: 9100,
        blocks_over_budget: 3,
        in_grace: true,
        capture_stage_strikes: 2,
        capture_stage_bypassed: "budget",
        capture_stage_p99_us: 6400,
      },
    });
    expect(invoke).toHaveBeenCalledWith("voice_note", {
      words: [
        "noise",
        "standard",
        "standard",
        "rnnoise",
        "model_reason:budget",
        "step_downs:1",
        "phone_mode:os",
        "step_down_reason:slow_window",
        "last_step_down_ms_ago:1200",
        "slowest_block_us:9100",
        "blocks_over_budget:3",
        "in_grace:true",
        "capture_stage_strikes:2",
        "capture_stage_bypassed:budget",
        "capture_stage_p99_us:6400",
      ],
    });
  });

  it("leaves out timing fields that are absent, and keeps a measured zero", () => {
    // A grace window open at the call's start, nothing slow yet.
    expect(noiseWords({ ...standard, in_grace: true, slowest_block_us: 0 })).toEqual([
      "noise",
      "standard",
      "standard",
      "dfn3",
      "slowest_block_us:0",
      "in_grace:true",
    ]);
    // A step-down just now, from a fault; the pipeline's p99 measured at 0.
    expect(noiseWords({ ...standard, step_down_reason: "fault", last_step_down_ms_ago: 0, capture_stage_p99_us: 0 })).toEqual([
      "noise",
      "standard",
      "standard",
      "dfn3",
      "step_down_reason:fault",
      "last_step_down_ms_ago:0",
      "capture_stage_p99_us:0",
    ]);
    // Not in grace, no counters: nothing new in the line.
    expect(noiseWords({ ...standard, in_grace: false, blocks_over_budget: 0, capture_stage_strikes: 0 })).toEqual([
      "noise",
      "standard",
      "standard",
      "dfn3",
    ]);
  });
});

describe("Settings → Calls → Noise removal", () => {
  const sw = () => screen.getByRole("switch", { name: "Noise removal" });

  it("shows one switch, On by default, with a plain footnote (Off is really off now)", () => {
    render(<ZenSettings onClose={() => {}} />);
    const group = screen.getByTestId("settings-calls");
    expect(group.textContent).toContain("Calls");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(group.textContent).toContain(
      "Removes background noise from your microphone in calls. Off sends the full sound, with echo cancellation still on. Only this phone."
    );
    expect(group.textContent).not.toContain("for now");
    expect(group.textContent).not.toMatch(/\d+\.\d+/);
  });

  it("turning it off stores Off and tells the engine", async () => {
    render(<ZenSettings onClose={() => {}} />);
    fireEvent.click(sw());
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(NOISE_REMOVAL_KEY)).toBe("off");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(SET, { mode: "off" }));
  });

  it("is hidden where the build has no calls", () => {
    ios.on = false;
    render(<ZenSettings onClose={() => {}} />);
    expect(screen.queryByTestId("settings-calls")).toBeNull();
  });
});
