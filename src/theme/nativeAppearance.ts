// Settings → Themes' mode on the native side (iOS): the keyboard, the
// status bar text and the colour behind the web view follow Light, Dark or
// Auto (src-tauri/src/appearance.rs, the `set_appearance` command).
//
// Native also saves what it is sent (NSUserDefaults), so the next launch's
// window starts in the right mode before any JS runs; this is re-sent at
// every startup (initTheme) so a stale save corrects itself at once.
//
// iOS only: Android's look is another owner's, and tests, the browser and
// desktop have no native side. A no-op there.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SchemeMode } from "./palettes";

/** What `set_appearance` takes: the mode, the page colour on screen now,
 *  and each side's page colour (for the next launch under Auto). */
export type NativeAppearance = { mode: SchemeMode; bg: string; darkBg: string; lightBg: string };

/** iPhone, iPod or iPad (iPadOS reports a desktop Safari UA). As
 *  lib/nativePicker's isIosWebView, without its imports. */
function iosWebView(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export function nativeAppearanceAvailable(): boolean {
  try {
    return isTauri() && iosWebView();
  } catch {
    return false;
  }
}

let lastSent: string | null = null;

/** Tell native the look (deduped: an unchanged look sends nothing). */
export function syncNativeAppearance(look: NativeAppearance): void {
  if (!nativeAppearanceAvailable()) return;
  const key = `${look.mode} ${look.bg} ${look.darkBg} ${look.lightBg}`;
  if (key === lastSent) return;
  lastSent = key;
  try {
    void Promise.resolve(invoke<boolean>("set_appearance", { ...look })).catch(() => {
      // Not delivered (an older shell without the command): try again next time.
      if (lastSent === key) lastSent = null;
    });
  } catch {
    lastSent = null;
  }
}

/** Tests: forget what was sent. */
export function resetNativeAppearanceForTests(): void {
  lastSent = null;
}
