// Theme preview only (preview/vite.config.ts points the app's imports of
// `@tauri-apps/api/core` here). Everything is the real module except
// `invoke`, which answers the few native calls a screen draws from (push
// is available, as on an iPhone with the entitlement) and refuses the rest,
// as a plain browser would. `isTauri()` stays false.

import { notePreviewRequest } from "./netStub";

export * from "@tauri-apps/api/core";

const ANSWERS: Record<string, unknown> = {
  "plugin:k2-push|is_available": { available: true, platform: "ios" },
};

export async function invoke<T>(cmd: string, _args?: unknown, _options?: unknown): Promise<T> {
  notePreviewRequest("invoke", cmd);
  if (cmd in ANSWERS) return ANSWERS[cmd] as T;
  throw new Error(`No native ${cmd} in the theme preview`);
}
