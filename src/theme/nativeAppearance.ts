// Settings → Themes on the native side (iOS): the keyboard, the status bar
// text, native sheets and alerts, and the colour behind the web view take
// the scheme of the palette ON SCREEN (src-tauri/src/appearance.rs, the
// `set_appearance` command). Obsidian or Dusk picked for the day side keep
// the keyboard dark (Riley 2026-11-17).
//
// So native's override is always light or dark, Auto included, and the web
// view's `prefers-color-scheme` reports that override, not the iPhone. Under
// Auto the page learns the iPhone's own appearance from native instead:
// `window.__k2SystemAppearance("light" | "dark")`, after every
// `set_appearance`, when the app becomes active, on a scene trait change
// (iOS 17+) and on input focus. The last answer is kept on the device so
// the first paint of the next launch picks the right side before native
// speaks.
//
// Native also saves what it is sent (NSUserDefaults), so the next launch's
// window starts in the right look before any JS runs; this is re-sent at
// every startup (initTheme) so a stale save corrects itself at once.
//
// iOS only: Android's look is another owner's, and tests, the browser and
// desktop have no native side (they keep the media query). A no-op there.

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SchemeMode, StyleScheme } from "./palettes";

/** What `set_appearance` takes: the mode, the page colour on screen now,
 *  and each side's page colour and palette scheme (native resolves Auto
 *  against the iPhone, and starts the next launch from them). */
export type NativeAppearance = {
  mode: SchemeMode;
  bg: string;
  darkBg: string;
  lightBg: string;
  darkScheme: StyleScheme;
  lightScheme: StyleScheme;
};

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
  installReceiver();
  const key = `${look.mode} ${look.bg} ${look.darkBg} ${look.lightBg} ${look.darkScheme} ${look.lightScheme}`;
  if (key === lastSent) return;
  lastSent = key;
  try {
    void Promise.resolve(invoke<boolean>("set_appearance", { ...look })).catch(() => {
      // Not delivered: try again next time.
      if (lastSent === key) lastSent = null;
    });
  } catch {
    lastSent = null;
  }
}

// ─── The iPhone's own appearance, from native ───────────────────────────

/** The last appearance native reported, kept for the next launch's first
 *  paint ("light" | "dark"). */
export const SYSTEM_SCHEME_KEY = "k2.systemScheme";

declare global {
  interface Window {
    /** Native (appearance.rs) calls this with the iPhone's appearance. */
    __k2SystemAppearance?: (scheme: string) => void;
  }
}

/** undefined: not read yet; null: nothing known. */
let systemLight: boolean | null | undefined;
const listeners = new Set<() => void>();

function readCached(): boolean | null {
  try {
    const raw = localStorage.getItem(SYSTEM_SCHEME_KEY);
    return raw === "light" ? true : raw === "dark" ? false : null;
  } catch {
    return null;
  }
}

function receive(scheme: unknown): void {
  if (scheme !== "light" && scheme !== "dark") return;
  systemLight = scheme === "light";
  try {
    localStorage.setItem(SYSTEM_SCHEME_KEY, scheme);
  } catch {
    /* kept for this session only */
  }
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* one listener's failure doesn't stop the rest */
    }
  }
}

function installReceiver(): void {
  if (typeof window === "undefined" || window.__k2SystemAppearance) return;
  window.__k2SystemAppearance = receive;
}

/** True when native last said the iPhone shows light (false: dark); null
 *  when it hasn't said yet on this device, or off iOS. */
export function nativeSystemLight(): boolean | null {
  if (!nativeAppearanceAvailable()) return null;
  installReceiver();
  if (systemLight === undefined) systemLight = readCached();
  return systemLight;
}

/** Call `fn` whenever native reports the iPhone's appearance (it may be
 *  unchanged: the listener decides). iOS only; a no-op elsewhere. */
export function onNativeSystemAppearance(fn: () => void): () => void {
  if (!nativeAppearanceAvailable()) return () => {};
  installReceiver();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests: forget what was sent and heard. */
export function resetNativeAppearanceForTests(): void {
  lastSent = null;
  systemLight = undefined;
  listeners.clear();
  if (typeof window !== "undefined") delete window.__k2SystemAppearance;
}
