import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useServersStore } from "./stores/servers";
import "./styles/index.css";

// Android's WebView reports env(safe-area-inset-bottom) as 0 while the
// app draws edge-to-edge behind the system nav — bottom bars need an
// explicit lift there (--android-nav-lift, 0 on iOS). Class on <html>
// so plain CSS can branch per-OS.
if (/android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("platform-android");
}

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
