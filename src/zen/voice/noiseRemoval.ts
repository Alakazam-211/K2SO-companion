import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isIosWebView } from "../../lib/nativePicker";

// Noise removal for calls (Settings → Calls → Noise removal; the owner's rule,
// Sew 0.10.4). One On/Off switch, default On:
//   - On  = Sew's "standard": the system's voice processing, then
//     DeepFilterNet3 (the weights the app bundles, src-tauri/resources/dfn3).
//     The model loads when a call first needs it: until it's ready the call
//     runs on the system's processing alone (`reason: loading`), then steps
//     up; if the phone can't keep up it steps down to RNNoise by itself
//     (not while a grace window is open: about 3 s at the call's start, a
//     route change, a camera starting, an app switch; `in_grace`);
//   - Off = Sew's "off": the full microphone audio with no noise filtering.
//     On iPhone the system's voice processing is off too (raw capture,
//     `phone_mode: raw`); echo cancellation and gain control stay on.
// The plugin stores nothing: the app keeps the choice and sets it on the
// engine (`plugin:sew-voice|set_noise_removal {mode}`) before each join and
// whenever the switch changes. Mid-call on iPhone the microphone reopens in
// the other capture, with a short pause (`phone_mode_gap_ms`).
//
// Stored on this phone only for now. K2's desktop (Settings → Voice → Noise
// removal) will name a per-user setting later; to move to it, replace
// `loadNoiseRemoval` / `saveNoiseRemoval` and keep the rest.

export const NOISE_REMOVAL_KEY = "k2.voice.noiseRemoval";

/** Sew's mode names (`NoiseRemoval`): what `set_noise_removal` takes. */
export type NoiseMode = "standard" | "off";

/** The plugin's answer and event (`NoiseRemovalState`). Every field but
 *  `mode` and `active` is absent when unset. */
export type NoiseRemovalState = {
  mode: NoiseMode | string;
  active: NoiseMode | string;
  /** Why `active` is less than `mode`: `budget` / `fault` (the capture
   *  stage was bypassed), `unavailable`, `loading` (phones: the model is
   *  loading for this call). */
  reason?: string;
  /** `dfn3` or `rnnoise` (with DeepFilterNet3's weights given). */
  model?: string;
  /** Why the model isn't DeepFilterNet3: `budget`, `fault`, `loading`,
   *  `unavailable`. */
  model_reason?: string;
  /** This call's step-downs from DeepFilterNet3. */
  step_downs?: number;
  /** Phones: how the microphone is captured, `os` (the system's voice
   *  processing) or `raw` (Off). */
  phone_mode?: "os" | "raw" | string;
  /** Phones: `switch_failed` while the capture couldn't follow the setting. */
  phone_mode_reason?: string;
  /** Phones: this call's capture switches. */
  phone_mode_switches?: number;
  /** Phones: how long the microphone paused for the last switch, ms. */
  phone_mode_gap_ms?: number;
  // The stage's timing, for the call log (Sew 0.10.4; where DeepFilterNet3
  // is in play and a call runs). The counters ride along with each change.
  /** The rule at the latest step-down from DeepFilterNet3. */
  step_down_reason?: "slow_block" | "slow_window" | "heavy" | "fault" | "forced" | string;
  /** How long ago (in the call's audio) the latest step-down was, ms. */
  last_step_down_ms_ago?: number;
  /** The call's slowest stage block so far, µs. */
  slowest_block_us?: number;
  /** The call's stage blocks over the stage's budget so far. */
  blocks_over_budget?: number;
  /** A grace window is open: the timing rules are held back while the
   *  phone is busy with something else (absent when false). */
  in_grace?: boolean;
  /** The audio pipeline's budget strikes and faults against the stage. */
  capture_stage_strikes?: number;
  /** Why the audio pipeline last bypassed the stage (kept after a retry
   *  brought it back; `reason` says whether it's bypassed now). */
  capture_stage_bypassed?: "budget" | "fault" | string;
  /** The pipeline's 99th percentile of the stage's last 100 blocks, µs. */
  capture_stage_p99_us?: number;
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
    // Live: a call in progress switches at once (on iPhone the microphone
    // reopens, with a short pause).
    void applyNoiseRemoval(on);
  },
}));
