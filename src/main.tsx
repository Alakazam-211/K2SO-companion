import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useServersStore } from "./stores/servers";
import "./styles/index.css";
import { initZenFont } from "./zen/zenFont";
import { installAndroidBack } from "./lib/androidBack";
import { initKbDragRecorder } from "./lib/kbDragRecorder";

// Android's WebView reports env(safe-area-inset-bottom) as 0 while the
// app draws edge-to-edge behind the system nav — bottom bars need an
// explicit lift there (--android-nav-lift, 0 on iOS). Class on <html>
// so plain CSS can branch per-OS.
if (/android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("platform-android");
  // System Back closes the topmost Zen sheet/drawer/thread first
  // (MainActivity.kt → window.__k2Back; src/lib/androidBack.ts).
  installAndroidBack();

  // Zen surfaces pad with var(--safe-bottom) instead of the zero env()
  // value: MainActivity.kt exposes the real nav-bar inset (CSS px) via
  // the K2Insets bridge and fires `k2-insets` whenever it changes.
  const setSafeBottom = (px: number) =>
    document.documentElement.style.setProperty("--safe-bottom", `${px}px`);
  // 0 here means "not measured yet" — keep the CSS fallback. Events are
  // always real (0 while the on-screen keyboard is up).
  const bridge = (window as unknown as { K2Insets?: { safeBottom(): number } }).K2Insets;
  const initial = bridge?.safeBottom() ?? 0;
  if (initial > 0) setSafeBottom(initial);
  window.addEventListener("k2-insets", (e) =>
    setSafeBottom((e as CustomEvent<{ bottom: number }>).detail.bottom),
  );
}

// Zen UI font + text size prefs (Settings → Appearance): stamp them on
// <html> before the first render so Meslo users never see a system-font
// flash and text never jumps size.
initZenFont();

// Diagnostics → Keyboard drag recorder (off by default: one pref read).
initKbDragRecorder();

// Test hook for scripts/repro-nav-stress.mjs (dev builds only): lets the
// harness drive recovery-state churn straight into the store while it
// exercises the /servers ↔ /login boundary.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__serversStore = useServersStore;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
