import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isIosWebView } from "../../lib/nativePicker";

// Noise removal for calls (Settings → Calls → Noise removal; Riley's rule,
// Sew 0.10.2). One On/Off switch, default On:
//   - On  = Sew's "standard": DeepFilterNet3 (the weights the app bundles,
//     src-tauri/resources/dfn3), with RNNoise as Sew's automatic fallback;
//   - Off = Sew's "off": the full microphone audio with no noise filtering.
//     Echo cancellation and gain control stay on. On iOS the system's voice
//     processing keeps its own noise suppression until a later Sew update,
//     so Off is best effort there.
// The plugin stores nothing: the app keeps the choice and sets it on the
// engine (`plugin:sew-voice|set_noise_removal {mode}`) before each join and
// whenever the switch changes (mid-call it takes effect from the next 10 ms
// block).
//
// Stored on this phone only for now. K2's desktop (Settings → Voice → Noise
// removal) will name a per-user setting later; to move to it, replace
// `loadNoiseRemoval` / `saveNoiseRemoval` and keep the rest.

export const NOISE_REMOVAL_KEY = "k2.voice.noiseRemoval";

/** Sew's mode names (`NoiseRemoval`): what `set_noise_removal` takes. */
export type NoiseMode = "standard" | "off";

/** The plugin's answer and event (`NoiseRemovalState`). */
export type NoiseRemovalState = {
  mode: NoiseMode | string;
  active: NoiseMode | string;
  reason?: string;
  model?: string;
  model_reason?: string;
  step_downs?: number;
};

/** On unless "off" is stored. */
export function loadNoiseRemoval(): boolean {
  try {
    return localStorage.getItem(NOISE_REMOVAL_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveNoiseRemoval(on: boolean): void {
  try {
    localStorage.setItem(NOISE_REMOVAL_KEY, on ? "on" : "off");
  } catch {
    /* the choice lasts this session */
  }
}

/** The switch → Sew's mode. */
export function noiseMode(on: boolean): NoiseMode {
  return on ? "standard" : "off";
}

/** Whether this build has calls (the native engine: iOS for now). */
export function noiseRemovalAvailable(): boolean {
  return isIosWebView();
}

/** Sets the engine's noise removal to the stored choice (or `on`). Never
 *  throws: a plugin without the command (or off iOS) answers null, and the
 *  call goes on with the engine's default (Standard). */
export async function applyNoiseRemoval(on: boolean = loadNoiseRemoval()): Promise<NoiseRemovalState | null> {
  if (!noiseRemovalAvailable()) return null;
  try {
    return await invoke<NoiseRemovalState>("plugin:sew-voice|set_noise_removal", { mode: noiseMode(on) });
  } catch {
    return null;
  }
}

type NoiseRemovalStore = {
  on: boolean;
  setOn: (on: boolean) => void;
};

export const useNoiseRemovalStore = create<NoiseRemovalStore>((set) => ({
  on: loadNoiseRemoval(),
  setOn: (on) => {
    saveNoiseRemoval(on);
    set({ on });
    // Live: a call in progress switches from its next audio block.
    void applyNoiseRemoval(on);
  },
}));
