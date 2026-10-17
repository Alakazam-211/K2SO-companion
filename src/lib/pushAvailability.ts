import { invoke } from "@tauri-apps/api/core";

// The k2-push plugin's availability probe, session-cached. Its own module
// (re-exported by `push.ts`) so callers like the notification avatar
// cache can gate on it without loading push.ts and its import-time
// server-store hooks.

export const PUSH_PLUGIN = "k2-push";

export interface Availability {
  available: boolean;
  /** "ios" | "android" | "desktop" ("unknown" when the probe threw). */
  platform: string;
  reason?: string | null;
}

let availabilityPromise: Promise<Availability> | null = null;

/** Full probe result (Settings shows the reason in the dormant state). */
export function pushAvailability(): Promise<Availability> {
  if (!availabilityPromise) {
    availabilityPromise = invoke<Availability>(`plugin:${PUSH_PLUGIN}|is_available`).catch(
      // No tauri runtime (browser dev) or plugin rejection — unavailable.
      (e) => ({ available: false, platform: "unknown", reason: String(e) })
    );
  }
  return availabilityPromise;
}

export async function pushIsAvailable(): Promise<boolean> {
  return (await pushAvailability()).available;
}
