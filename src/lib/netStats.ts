import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

// Network counters for Diagnostics (Plan - Phone Speed and Battery PRD, A0).
// Instruments can't see our requests (reqwest in the Rust process) or our
// sockets (WebKit's network process), so the app counts its own:
//   - every HTTP request by host and route (`netFetch`, the one wrapper
//     around the HTTP plugin's fetch that every caller uses);
//   - socket opens and frames by host and kind (`openSocket`);
//   - each return to the foreground: what went out in the 10 s after it.
// In memory, this session only. Cheap: a counter bump and a timestamp.

export type SocketKind = "hub" | "chat" | "terminal" | "project" | "tickets";

const WINDOW_MS = 5 * 60_000;
const RETURN_WINDOW_MS = 10_000;
const KEEP_RETURNS = 10;
const KEEP_STAMPS = 2_000;

type Host = {
  /** route → total this session. */
  routes: Map<string, number>;
  /** Request times (newest last), for the per-minute rate. */
  stamps: number[];
  errors: number;
  opens: Map<SocketKind, number>;
  /** frame kind → total this session. */
  frames: Map<string, number>;
  frameStamps: number[];
};

export type NetReturn = { at: number; awayMs: number; requests: number; opens: number; routes: Record<string, number> };

const hosts = new Map<string, Host>();
const returns: NetReturn[] = [];
let current: NetReturn | null = null;
let hiddenAt: number | null = null;
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

function hostOf(url: string): { host: string; route: string } {
  try {
    const u = new URL(url);
    return { host: u.host.toLowerCase(), route: routeOf(u.pathname) };
  } catch {
    return { host: "", route: "?" };
  }
}

/** `/cli/thread/3f2a…/x` → `/cli/thread/:id/x`: ids collapse so routes group. */
export function routeOf(path: string): string {
  return (
    path
      .split("/")
      .map((p) => (/^[0-9a-f-]{16,}$/i.test(p) || /^\d{3,}$/.test(p) ? ":id" : p))
      .join("/") || "/"
  );
}

function entry(host: string): Host {
  let h = hosts.get(host);
  if (!h) {
    h = { routes: new Map(), stamps: [], errors: 0, opens: new Map(), frames: new Map(), frameStamps: [] };
    hosts.set(host, h);
  }
  return h;
}

function stamp(list: number[], now: number): void {
  list.push(now);
  if (list.length > KEEP_STAMPS) list.splice(0, list.length - KEEP_STAMPS);
}

function inReturn(now: number): NetReturn | null {
  if (current && now - current.at > RETURN_WINDOW_MS) current = null;
  return current;
}

export function noteRequest(url: string, now = Date.now()): void {
  const { host, route } = hostOf(url);
  const h = entry(host);
  h.routes.set(route, (h.routes.get(route) ?? 0) + 1);
  stamp(h.stamps, now);
  const r = inReturn(now);
  if (r) {
    r.requests += 1;
    r.routes[route] = (r.routes[route] ?? 0) + 1;
  }
  changed();
}

export function noteRequestError(url: string): void {
  entry(hostOf(url).host).errors += 1;
  changed();
}

export function noteSocketOpen(kind: SocketKind, url: string, now = Date.now()): void {
  const h = entry(hostOf(url).host);
  h.opens.set(kind, (h.opens.get(kind) ?? 0) + 1);
  const r = inReturn(now);
  if (r) r.opens += 1;
  changed();
}

/** A frame's kind, read cheaply from the start of a JSON text frame. */
export function frameKind(data: unknown): string {
  if (typeof data !== "string") return "binary";
  const m = /"(?:kind|t|type)"\s*:\s*"([^"]{1,40})"/.exec(data.slice(0, 300));
  return m ? m[1] : "other";
}

export function noteFrame(kind: SocketKind, url: string, data: unknown, now = Date.now()): void {
  const h = entry(hostOf(url).host);
  const k = `${kind}:${frameKind(data)}`;
  h.frames.set(k, (h.frames.get(k) ?? 0) + 1);
  stamp(h.frameStamps, now);
  // Frames are frequent: no `changed()` per frame; the panel polls while open.
}

/** The app came back to the foreground (`visibilitychange`). */
export function noteForeground(now = Date.now()): void {
  const awayMs = hiddenAt == null ? 0 : now - hiddenAt;
  hiddenAt = null;
  const r: NetReturn = { at: now, awayMs, requests: 0, opens: 0, routes: {} };
  current = r;
  returns.unshift(r);
  if (returns.length > KEEP_RETURNS) returns.length = KEEP_RETURNS;
  changed();
}

export function noteBackground(now = Date.now()): void {
  hiddenAt = now;
  current = null;
}

let installed = false;
/** Watch visibility once (App). */
export function installNetStats(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") noteForeground();
    else noteBackground();
  });
}

/** The HTTP plugin's fetch, counted. Every caller uses this. */
export const netFetch: typeof tauriFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  noteRequest(url);
  try {
    return await tauriFetch(input, init);
  } catch (e) {
    noteRequestError(url);
    throw e;
  }
};

/** `new WebSocket(url)`, counted (opens and frames by kind). */
export function openSocket(kind: SocketKind, url: string): WebSocket {
  noteSocketOpen(kind, url);
  const ws = new WebSocket(url);
  try {
    ws.addEventListener?.("message", (e: MessageEvent) => noteFrame(kind, url, e.data));
  } catch {
    /* a test double without listeners */
  }
  return ws;
}

// ─── Read side (Diagnostics) ───

export type NetSummary = {
  requestsPerMin: number;
  framesPerMin: number;
  total: number;
  errors: number;
  topRoutes: { route: string; count: number }[];
  opens: Partial<Record<SocketKind, number>>;
  topFrames: { kind: string; count: number }[];
  returns: NetReturn[];
};

function perMin(list: number[], now: number): number {
  const since = now - WINDOW_MS;
  let n = 0;
  for (let i = list.length - 1; i >= 0 && list[i] >= since; i--) n++;
  // Over the part of the window this session has covered.
  const first = list.length ? list[0] : now;
  const span = Math.max(60_000, Math.min(WINDOW_MS, now - first));
  return Math.round((n * 60_000 * 10) / span) / 10;
}

export function netSummary(host: string, now = Date.now()): NetSummary | null {
  const h = hosts.get(host.toLowerCase());
  if (!h) return null;
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    requestsPerMin: perMin(h.stamps, now),
    framesPerMin: perMin(h.frameStamps, now),
    total: [...h.routes.values()].reduce((a, b) => a + b, 0),
    errors: h.errors,
    topRoutes: sorted(h.routes).map(([route, count]) => ({ route, count })),
    opens: Object.fromEntries(h.opens) as Partial<Record<SocketKind, number>>,
    topFrames: sorted(h.frames).map(([kind, count]) => ({ kind, count })),
    returns: returns.map((r) => ({ ...r, routes: { ...r.routes } })),
  };
}

export function subscribeNetStats(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function netStatsVersion(): number {
  return version;
}

export function __resetNetStatsForTests(): void {
  hosts.clear();
  returns.length = 0;
  current = null;
  hiddenAt = null;
  version = 0;
}
