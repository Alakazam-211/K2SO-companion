import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { initZenFont } from "./zen/zenFont";
import { installAndroidBack } from "./lib/androidBack";
import { initKbDragRecorder } from "./lib/kbDragRecorder";
import { initKbDiag } from "./lib/kbDiag";
import { initLightBlur } from "./lib/lightBlur";
import { phoneVoiceEngine } from "./zen/voice/sewVoice";
import { setPhoneVoiceEngine } from "./zen/voice/voiceCall";
import { resyncVoiceCall } from "./zen/voice/VoiceRooms";
import { HIDDEN, placeTile } from "./zen/voice/videoTile";
import { onForegroundLater } from "./lib/foreground";

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
initKbDiag();

// Diagnostics → Light blur (A/B, off by default: one pref read).
initLightBlur();

// Voice rooms: this build's call engine (Sew's native plugin on iOS).
const voiceEngine = phoneVoiceEngine();
if (voiceEngine) {
  setPhoneVoiceEngine(voiceEngine);
  // The webview misses the engine's events while it sleeps, and loses the
  // call store if it reloads: catch up now and on every return.
  // Not staggered: the call bar is what the person looks at first.
  void resyncVoiceCall();
  onForegroundLater("voice-call", () => void resyncVoiceCall(), 0);
  // After a reload mid-call the video layer may still sit over a tile this
  // page no longer has: back under the webview until one shows.
  placeTile(HIDDEN);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
