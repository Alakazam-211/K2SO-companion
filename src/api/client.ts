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

export interface Review {
  id: string;
  agent: string;
  branch: string;
  title: string;
  summary?: string;
}

let baseUrl = "";
let sessionToken = "";

export function configure(url: string) {
  baseUrl = url.replace(/\/+$/, "");
}

export function getBaseUrl() {
  return baseUrl;
}

export function setToken(token: string) {
  sessionToken = token;
}

export function clearSession() {
  baseUrl = "";
  sessionToken = "";
}

// ─── HTTP via Tauri plugin (bypasses WKWebView restrictions) ───

async function httpRequest<T>(
  path: string,
  options: { method?: string; body?: string; project?: string } = {},
  timeoutMs = 15000
): Promise<ApiResponse<T>> {
  if (!baseUrl) return { ok: false, error: "Not connected" };

  // Build URL with project param if provided
  let url = `${baseUrl}${path}`;
  if (options.project) {
    const sep = url.includes("?") ? "&" : "?";
    url += `${sep}project=${encodeURIComponent(options.project)}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }

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
    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not reach server: ${msg}` };
  }
}

// ─── Smart request: try WS, fall back to HTTP ───

async function request<T>(
  wsMethod: string,
  httpPath: string,
  params: Record<string, unknown> = {},
  httpOptions: { method?: string } = {}
): Promise<ApiResponse<T>> {
  // Try WebSocket first
  if (ws.isConnected) {
    try {
      const result = await ws.request<ApiResponse<T>>(wsMethod, params);
      return result;
    } catch {
      // Fall through to HTTP
    }
  }

  // HTTP fallback via Tauri plugin
  const project = params.project as string | undefined;
  const body = httpOptions.method === "POST" ? JSON.stringify(params) : undefined;

  // Build query params for GET requests (exclude 'project' — handled separately)
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

// ─── Auth ───

export async function login(
  serverUrl: string,
  username: string,
  password: string
): Promise<ApiResponse<AuthResponse>> {
  configure(serverUrl);
  try {
    const res = await Promise.race([
      tauriFetch(`${baseUrl}/companion/auth`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${username}:${password}`)}`,
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 10000)
      ),
    ]);
    const text = await res.text();

    if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
      return { ok: false, error: "ngrok interstitial — open the URL in Safari first, then retry" };
    }

    const json = JSON.parse(text) as ApiResponse<AuthResponse>;
    if (res.status === 401 || !json.ok) {
      return { ok: false, error: json.error || "Invalid credentials" };
    }
    if (json.data) {
      sessionToken = json.data.token;
    }
    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not connect: ${msg}` };
  }
}

// ─── API endpoints ───

// Global (no project param)
export const getProjects = () =>
  request<Project[]>("projects.list", "/companion/projects", {});
export const getProjectsSummary = () =>
  request<ProjectSummary[]>("projects.summary", "/companion/projects/summary", {});
export const getAllSessions = () =>
  request<GlobalSession[]>("sessions.list", "/companion/sessions", {});

// Project-scoped
export const getAgents = (project: string) =>
  request<Agent[]>("agents.list", "/companion/agents", { project });
export const getRunningTerminals = (project: string) =>
  request<RunningTerminal[]>("agents.running", "/companion/agents/running", { project });
export const getAgentWork = (project: string, agent: string, folder = "inbox") =>
  request("agents.work", "/companion/agents/work", { project, agent, folder });
export const wakeAgent = (project: string, agent: string) =>
  request("agents.wake", "/companion/agents/wake", { project, agent }, { method: "POST" });
export const getReviews = (project: string) =>
  request<Review[]>("reviews.list", "/companion/reviews", { project });
export const readTerminal = (project: string, id: string, lines = 50) =>
  request<{ lines: string[] }>("terminal.read", "/companion/terminal/read", { project, id, lines });
export const writeTerminal = (project: string, id: string, message: string) =>
  request("terminal.write", "/companion/terminal/write", { project, id, message }, { method: "POST" });
export const getStatus = (project: string) =>
  request("status", "/companion/status", { project });
