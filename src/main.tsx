import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./styles/index.css";

// Listen for native iOS keyboard events and resize the app accordingly.
// The tauri-plugin-ios-keyboard gives us the exact keyboard height from UIKit,
// which we use to shrink #root so flexbox naturally pins header/input bar.
listen<{ eventType: string; keyboardHeight: number }>(
  "plugin:keyboard::ios-keyboard-event",
  (event) => {
    const root = document.getElementById("root");
    if (!root) return;
    const { eventType, keyboardHeight } = event.payload;
    if (eventType === "will-show" || eventType === "did-show") {
      root.style.height = `${window.innerHeight - keyboardHeight}px`;
    } else {
      root.style.height = "100%";
    }
  }
).catch(() => {
  // Not on iOS — no keyboard events, height stays 100%
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
