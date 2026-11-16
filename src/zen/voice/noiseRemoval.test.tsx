// @vitest-environment jsdom
// Noise removal (Sew 0.10.2; Riley's rule): one On/Off switch in Settings →
// Calls, default On (Sew's "standard": DeepFilterNet3, RNNoise its fallback),
// Off = Sew's "off". Stored on this phone; set on the engine before each join
// and live when switched.
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
});

describe("Settings → Calls → Noise removal", () => {
  const sw = () => screen.getByRole("switch", { name: "Noise removal" });

  it("shows one switch, On by default, with the plain iPhone footnote", () => {
    render(<ZenSettings onClose={() => {}} />);
    const group = screen.getByTestId("settings-calls");
    expect(group.textContent).toContain("Calls");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(group.textContent).toContain("On iPhone, Off can still filter some noise for now");
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
