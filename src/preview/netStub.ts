// Theme preview only: no network. Imported first by ThemePreview.tsx, before
// any app module, so nothing the app starts can reach a server:
//   - window.fetch to another origin never answers (same-origin, i.e. the
//     dev server's own modules and assets, passes through);
//   - WebSocket / EventSource never open;
//   - storage starts empty on every load, so a run is the fixtures alone.
// What the app tried is kept on `window.__previewNet` (scripts/theme-shots.mjs
// prints a count).

type PreviewNet = { kind: string; url: string }[];

declare global {
  interface Window {
    __previewNet?: PreviewNet;
    __previewReady?: boolean;
  }
}

const log: PreviewNet = (window.__previewNet = []);

export function notePreviewRequest(kind: string, url: string): void {
  if (log.length < 500) log.push({ kind, url });
}

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url, location.href).origin === location.origin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return realFetch(input, init);
  notePreviewRequest("fetch", url);
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
};

/** A socket that stays CONNECTING: no open, no close, no frames. */
class SilentSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  constructor(readonly url: string) {
    super();
    notePreviewRequest("socket", String(url));
  }
  send(): void {}
  close(): void {}
}

window.WebSocket = SilentSocket as unknown as typeof WebSocket;

class SilentEventSource extends EventTarget {
  readyState = 0;
  withCredentials = false;
  onopen = null;
  onmessage = null;
  onerror = null;
  constructor(readonly url: string) {
    super();
    notePreviewRequest("event-source", String(url));
  }
  close(): void {}
}
window.EventSource = SilentEventSource as unknown as typeof EventSource;

try {
  localStorage.clear();
  sessionStorage.clear();
} catch {
  /* storage blocked: the fixtures still set the stores */
}
