import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";

// Android's WebView reports env(safe-area-inset-bottom) as 0 while the
// app draws edge-to-edge behind the system nav — bottom bars need an
// explicit lift there (--android-nav-lift, 0 on iOS). Class on <html>
// so plain CSS can branch per-OS.
if (/android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("platform-android");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
