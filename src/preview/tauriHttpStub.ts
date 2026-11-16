// Theme preview only (preview/vite.config.ts aliases `@tauri-apps/plugin-http`
// here). Every daemon request the app makes goes through this fetch: it is
// recorded and never answered, so loaders stay "in flight" and the
// fixtures the preview put in the stores stay on screen. An abort (the
// app's 15 s timeout) rejects, as a real fetch would.

import { notePreviewRequest } from "./netStub";

export async function fetch(input: URL | Request | string, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  notePreviewRequest("tauri-http", url);
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}
