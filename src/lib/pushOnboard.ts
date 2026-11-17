import {
  notificationState,
  openNotificationSettings,
  osAllowsNotifications,
  pushAvailability,
  registerAllSignedIn,
  requestPushPermission,
  setPushEnabled,
} from "./push";

// The one-time push onboarding prompt (4.3.0, Riley): "Would you like
// push notifications from your agents?" before iOS's own alert, so nobody
// meets the system alert cold. The UI is zen/PushOnboardPrompt.tsx.
//
// Who sees it, once: anyone without the flag below (a fresh install, and
// everyone updating from before 4.3.0) whose iOS notification permission
// is not yet granted (`notDetermined`, or `denied`: then the yes opens
// iOS Settings, since the system alert can't show again). Already granted
// → the flag is set silently. iOS only: Android's native side can't read
// the permission without asking (state "unknown"), so it never shows
// there. A dormant build (push unavailable) shows nothing and keeps no
// flag, so a later build can still ask.

/** Set once the prompt was answered (or wasn't needed). Per device. */
export const PUSH_ONBOARD_KEY = "k2.push.onboard.v1";

export type OnboardOutcome = "granted" | "yes" | "refused" | "settings" | "notNow";

export function pushOnboardDone(): boolean {
  try {
    return !!localStorage.getItem(PUSH_ONBOARD_KEY);
  } catch {
    // No storage: never nag.
    return true;
  }
}

export function markPushOnboardDone(outcome: OnboardOutcome): void {
  try {
    localStorage.setItem(PUSH_ONBOARD_KEY, JSON.stringify({ outcome, at: Date.now() }));
  } catch {
    // Storage gone: it may ask again next launch, which is fine.
  }
}

export type OnboardDecision = { show: false } | { show: true; denied: boolean };

/** Whether to show the prompt now (see the top of this file). Never
 *  throws. */
export async function decidePushOnboard(): Promise<OnboardDecision> {
  if (pushOnboardDone()) return { show: false };
  try {
    const a = await pushAvailability();
    if (a.platform !== "ios" || !a.available) return { show: false };
    const state = await notificationState();
    if (osAllowsNotifications(state)) {
      markPushOnboardDone("granted");
      return { show: false };
    }
    if (state === "notDetermined") return { show: true, denied: false };
    if (state === "denied") return { show: true, denied: true };
    return { show: false };
  } catch {
    return { show: false };
  }
}

/** "Turn on notifications": the push preference on, then iOS's alert and
 *  the usual registration on every signed-in server; or, when iOS says
 *  denied, this app's notification settings in iOS Settings (it registers
 *  on the next foreground once they're on there). Never throws. */
export async function acceptPushOnboard(denied: boolean): Promise<OnboardOutcome> {
  markPushOnboardDone("yes");
  try {
    await setPushEnabled(true);
  } catch {
    // The preference store failed; asking iOS still helps (a granted
    // permission registers under the default-on preference).
  }
  if (denied) {
    await openNotificationSettings();
    markPushOnboardDone("settings");
    return "settings";
  }
  const granted = await requestPushPermission();
  markPushOnboardDone(granted ? "granted" : "refused");
  if (granted) await registerAllSignedIn();
  return granted ? "granted" : "refused";
}

/** "Not now" (or Back, or a tap outside): never shown again on its own;
 *  Settings → Push Notifications still turns it on. */
export function dismissPushOnboard(): void {
  markPushOnboardDone("notNow");
}
