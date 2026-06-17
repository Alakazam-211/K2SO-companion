import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { ws } from "./websocket";

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AuthResponse {
  token: string;
  expiresAt: string;
}

export interface FocusGroup {
  id: string;
  name: string;
  color: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  iconUrl: string | null;
  agentMode: string;
  pinned: boolean;
  tabOrder: number;
  focusGroup: FocusGroup | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  color: string;
  agentMode: string;
  agentsRunning: number;
  reviewsPending: number;
  pinned?: boolean;
  tabOrder?: number;
  focusGroup?: FocusGroup | null;
}

export interface Agent {
  name: string;
  role: string;
  isManager: boolean;
  agentType: string;
  inboxCount: number;
  activeCount: number;
  doneCount: number;
}

export interface RunningTerminal {
  terminalId: string;
  command: string | null;
  cwd: string;
}

export interface GlobalSession {
  workspaceName: string;
  workspaceId: string;
  workspaceColor: string;
  agentName: string;
  terminalId: string;
  label: string;
  command?: string | null;
  cwd: string;
}

export interface CliPreset {
  id: string;
  name: string;
  command: string;
  icon?: string;
}

export interface Review {
  id: string;
  agent: string;
  branch: string;
  title: string;
  summary?: string;
}

// 0.40.x: the companion now talks DIRECTLY to the K2 daemon's `/cli/*`
// routes (no legacy `/companion/*` ngrok proxy). `baseUrl` is the daemon
// origin — `https://<sub>.k2.dev` over the K2 Connect tunnel, or
// `http://127.0.0.1:<daemon.port>` for localhost dev. `sessionToken` is
// the token from `POST /cli/auth/login`; it authenticates every `/cli/*`
// call as the `?token=` query param (the same param the daemon's grid-WS
// and CLI use). See docs/companion-revival.md for the full mapping.
let baseUrl = "";
let sessionToken = "";

export function configure(url: string) {
  baseUrl = url.replace(/\/+$/, "");
}

export function getBaseUrl() {
  return baseUrl;
}

export function getToken() {
  return sessionToken;
}

export function setToken(token: string) {
  sessionToken = token;
}

export function clearSession() {
  baseUrl = "";
  sessionToken = "";
}

// ─── HTTP via Tauri plugin (bypasses WKWebView restrictions) ───
//
// The daemon's `/cli/*` routes return RAW JSON (the payload directly —
// an array or object), NOT a `{ok,data,error}` envelope. We wrap a 2xx
// body as `{ok:true, data}` and map non-2xx to `{ok:false, error}` so
// the rest of the app keeps its `ApiResponse<T>` contract.

async function httpRequest<T>(
  path: string,
  options: { method?: string; body?: string; project?: string } = {},
  timeoutMs = 15000,
  extraParams?: Record<string, string>
): Promise<ApiResponse<T>> {
  if (!baseUrl) return { ok: false, error: "Not connected" };

  // Build query: project + extra params + the auth token.
  let url = `${baseUrl}${path}`;
  const params: string[] = [];
  if (options.project) {
    params.push(`project=${encodeURIComponent(options.project)}`);
  }
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) {
      params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  if (sessionToken) {
    params.push(`token=${encodeURIComponent(sessionToken)}`);
  }
  if (params.length > 0) {
    url += `?${params.join("&")}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  try {
    const res = await Promise.race([
      tauriFetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body || undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs)
      ),
    ]);
    if (res.status === 401) return { ok: false, error: "Unauthorized" };
    if (!res.ok) {
      // Daemon error bodies are `{error: "..."}` on non-2xx.
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: msg };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not reach server: ${msg}` };
  }
}

// ─── Request wrapper ───
//
// WS-first is kept as a dormant path: the daemon has no companion RPC
// WebSocket, so `ws.isConnected` stays false here and every data call
// goes over HTTP. The grid-WS (`/cli/sessions/grid`) is a dedicated
// per-session terminal stream used directly by TerminalView, not this
// RPC wrapper. (Phase 4 wires that.)

async function request<T>(
  wsMethod: string,
  httpPath: string,
  params: Record<string, unknown> = {},
  httpOptions: { method?: string } = {}
): Promise<ApiResponse<T>> {
  if (ws.isConnected) {
    try {
      return await ws.request<ApiResponse<T>>(wsMethod, params);
    } catch {
      /* fall through to HTTP */
    }
  }

  const project = params.project as string | undefined;
  const body = httpOptions.method === "POST" ? JSON.stringify(params) : undefined;

  // GET query params (exclude 'project' — appended by httpRequest).
  let path = httpPath;
  if (httpOptions.method !== "POST") {
    const queryParts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (k !== "project" && v !== undefined) {
        queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    if (queryParts.length > 0) {
      path += `?${queryParts.join("&")}`;
    }
  }

  return httpRequest<T>(path, { method: httpOptions.method, body, project });
}

// ─── Auth: K2 Connect login ───
//
// `POST /cli/auth/login {username,password}` (PUBLIC — no token gate) →
// `200 {token, username, expiresAt}` on success, `401 {error}` on
// failure. This is the K2 Connect account system (Owner/Admin/Member).
// `serverUrl` is the daemon origin (tunnel subdomain or localhost).

export async function login(
  serverUrl: string,
  username: string,
  password: string
): Promise<ApiResponse<AuthResponse>> {
  configure(serverUrl);
  try {
    const res = await Promise.race([
      tauriFetch(`${baseUrl}/cli/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 10000)
      ),
    ]);

    if (res.status === 401) {
      return { ok: false, error: "Invalid username or password" };
    }
    if (!res.ok) {
      return { ok: false, error: `Login failed (HTTP ${res.status})` };
    }

    const data = (await res.json()) as AuthResponse;
    if (!data?.token) {
      return { ok: false, error: "Login response missing token" };
    }
    sessionToken = data.token;
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not connect: ${msg}` };
  }
}

// ─── API endpoints (daemon `/cli/*`) ───

// Global (no project param)
export const getProjects = () =>
  request<Project[]>("projects.list", "/cli/companion/projects", {});
export const getProjectsSummary = () =>
  request<ProjectSummary[]>("projects.summary", "/cli/companion/projects-summary", {});
export const getPresets = () =>
  request<CliPreset[]>("presets.list", "/cli/companion/presets", {});
export const getAllSessions = () =>
  request<GlobalSession[]>("sessions.list", "/cli/companion/sessions", {});

// Project-scoped.
// NOTE: the PRIMARY path (sessions list + live terminal) uses the
// verified routes below — list-running / terminal read+write+spawn /
// companion sessions. The secondary screens (agents, work, wake,
// reviews) are mapped to the closest verified `/cli/*` route but their
// param shapes still need per-screen verification (Phase 4+). Tracked in
// docs/companion-revival.md.
export const getAgents = (project: string) =>
  request<Agent[]>("agents.list", "/cli/agents/list", { project });
export const getRunningTerminals = (project: string) =>
  request<RunningTerminal[]>("agents.running", "/cli/terminal/list-running", { project });
export const getAgentWork = (project: string, agent: string, folder = "inbox") =>
  request("agents.work", "/cli/inbox/list", { project, agent, folder });
// "Wake" = fire the workspace heartbeat. Param model differs from the old
// /companion/agents/wake (name vs project+agent) — needs reconciliation.
export const wakeAgent = (project: string, agent: string) =>
  request("agents.wake", "/cli/heartbeat/fire", { project, agent }, { method: "POST" });
export const getReviews = (project: string) =>
  request<Review[]>("reviews.list", "/cli/reviews", { project });
// HTTP for terminal read — needs the scrollback param.
export const readTerminal = (project: string, id: string, lines = 500) =>
  httpRequest<{ lines: string[] }>("/cli/terminal/read", {
    project,
    method: "GET",
  }, 15000, { id, lines: String(lines), scrollback: "true" });
export const spawnTerminal = (project: string, command: string, title?: string) =>
  request("terminal.spawn", "/cli/terminal/spawn", { project, command, title }, { method: "POST" });
export const spawnBackgroundTerminal = (project: string, command: string, cwd?: string) =>
  request<{ success: boolean; terminalId: string; command: string }>(
    "terminal.spawn_background", "/cli/terminal/spawn-background",
    { project, command, cwd: cwd || project }, { method: "POST" }
  );
export const writeTerminal = (project: string, id: string, message: string) =>
  request("terminal.write", "/cli/terminal/write", { project, id, message }, { method: "POST" });
export const getStatus = (project: string) =>
  request("status", "/cli/companion/status", { project });
