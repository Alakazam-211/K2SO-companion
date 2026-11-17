import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isIosWebView } from "../../lib/nativePicker";

// "Ring for incoming calls" (Settings → Calls; Riley 2026-11-17: "default
// to on like push notifications"). One switch, this phone only, default On:
//   - On  = the in-app ring tone (ringTone.ts, Web Audio) while a ring card
//     is up, and K2's ringtone on the call push (`k2-ring.caf`, the same
//     two tones as a 28 s file, scripts/gen-ringtone.mjs) at the
//     time-sensitive level (NotificationService.swift `callContent`);
//   - Off = no ring tone in the app (the card alone), and the Notification
//     Service Extension delivers the ring push with no sound at the normal
//     (active) level, still "Incoming call" with Accept / Decline.
// iOS's own silent switch and Focus apply either way; nothing here goes
// past them.
//
// The extension runs without the app, so the choice is copied to the App
// Group's UserDefaults (`call_op ring {on}` → K2CallPush.setRing, key
// `k2.call.ring.v1`): on every change and once at launch (`syncCallRing`),
// so a lost write heals. Never written, the extension rings (On).

export const CALL_RING_KEY = "k2.calls.ring";

/** On unless "off" is stored. */
export function loadCallRing(): boolean {
  try {
    return localStorage.getItem(CALL_RING_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveCallRing(on: boolean): void {
  try {
    localStorage.setItem(CALL_RING_KEY, on ? "on" : "off");
  } catch {
    /* the choice lasts this session */
  }
}

/** Copies the choice to the App Group for the Notification Service
 *  Extension. iOS only; never throws (an older native build without the
 *  op answers false, and its extension keeps ringing). */
export async function shareCallRing(on: boolean = loadCallRing()): Promise<boolean> {
  if (!isIosWebView()) return false;
  try {
    const r = await invoke<{ ok?: boolean }>("plugin:k2-push|call_op", { op: "ring", on });
    return r?.ok === true;
  } catch {
    return false;
  }
}

/** At launch: the stored choice to the extension. */
export function syncCallRing(): void {
  void shareCallRing();
}

type CallRingStore = {
  on: boolean;
  setOn: (on: boolean) => void;
};

export const useCallRingStore = create<CallRingStore>((set) => ({
  on: loadCallRing(),
  setOn: (on) => {
    saveCallRing(on);
    set({ on });
    void shareCallRing(on);
  },
}));
