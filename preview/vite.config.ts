// Theme preview dev server (development only; never part of `vite build`).
//
//   npx vite --config preview/vite.config.ts
//   open http://localhost:1430/preview/theme.html?palette=veil&screen=thread
//
// Its own config, so the app's vite.config.ts (and the production build,
// whose only input is index.html) never sees any of this. It serves the
// same source with three changes, all in this file:
//   - `@tauri-apps/plugin-http` resolves to a stub whose fetch never answers
//     (nothing reaches a server; the fixtures stay on screen), and the
//     app's `@tauri-apps/api/core` to one whose `invoke` fakes the few
//     native answers a screen draws from (src/preview/tauri*Stub.ts);
//   - `env(safe-area-inset-*)` in the app's CSS and inline styles reads
//     `--preview-safe-*` instead, so a desktop browser shows an iPhone's
//     status-bar and home-indicator insets (ThemePreview.tsx sets them);
//   - port 1430, so it runs beside `vite` / `tauri dev` on 1420.

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const httpStub = path.join(root, "src/preview/tauriHttpStub.ts");
const coreStub = path.join(root, "src/preview/tauriCoreStub.ts");

/** `env(safe-area-inset-top)` / `env(safe-area-inset-bottom, 0px)` → the
 *  preview's own variable (the browser's env() is always 0). */
const SAFE_AREA = /env\(\s*safe-area-inset-(top|bottom|left|right)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g;

function previewStubs(): Plugin {
  return {
    name: "k2-theme-preview-stubs",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === "@tauri-apps/plugin-http") return httpStub;
      // The stub itself re-exports the real module.
      if (id === "@tauri-apps/api/core" && importer?.split("?")[0] !== coreStub) return coreStub;
      return null;
    },
  };
}

function previewSafeArea(): Plugin {
  return {
    name: "k2-theme-preview-safe-area",
    enforce: "post",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.startsWith(path.join(root, "src"))) return null;
      if (!code.includes("safe-area-inset")) return null;
      return { code: code.replace(SAFE_AREA, (_m, side) => `var(--preview-safe-${side}, 0px)`), map: null };
    },
  };
}

export default defineConfig({
  root,
  plugins: [previewStubs(), react(), tailwindcss(), previewSafeArea()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  optimizeDeps: {
    entries: ["preview/theme.html"],
  },
});
