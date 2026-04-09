import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

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

export interface RunningAgent {
  name: string;
  terminal_id: string;
  project_path: string;
  started_at?: string;
}

export interface GlobalSession {
  workspaceName: string;
  workspaceId: string;
  workspaceColor: string;
  agentName: string;
  terminalId: string;
  command?: string;
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

export function configure(url: string, token?: string) {
  baseUrl = url.replace(/\/+$/, "");
  if (token) sessionToken = token;
}

export function getBaseUrl() {
  return baseUrl;
}

export function setSessionToken(token: string) {
  sessionToken = token;
}

export function clearSession() {
  sessionToken = "";
  baseUrl = "";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out")), ms)
    ),
  ]);
}

async function request<T>(
  path: string,
  options: { method?: string; body?: string } = {}
): Promise<ApiResponse<T>> {
  if (!baseUrl) return { ok: false, error: "Not connected" };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }

  try {
    const res = await withTimeout(tauriFetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? options.body : undefined,
    }), 10000);
    if (res.status === 401) return { ok: false, error: "Unauthorized" };
    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not reach server: ${msg}` };
  }
}

export async function login(
  serverUrl: string,
  username: string,
  password: string
): Promise<ApiResponse<AuthResponse>> {
  configure(serverUrl);
  try {
    const res = await withTimeout(tauriFetch(`${baseUrl}/companion/auth`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${username}:${password}`)}`,
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
    }), 10000);
    const text = await res.text();

    if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
      return { ok: false, error: "ngrok interstitial — open the URL in Safari first, then retry" };
    }

    const json = JSON.parse(text) as ApiResponse<AuthResponse>;
    if (res.status === 401 || !json.ok) {
      return { ok: false, error: json.error || "Invalid credentials" };
    }
    if (json.data) setSessionToken(json.data.token);
    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not connect: ${msg}` };
  }
}

// Global endpoints (no project param)
export const getProjects = () => request<Project[]>("/companion/projects");
export const getProjectsSummary = () => request<ProjectSummary[]>("/companion/projects/summary");
export const getAllSessions = () => request<GlobalSession[]>("/companion/sessions");

// Project-scoped endpoints
export const getAgents = (project: string) =>
  request<Agent[]>(`/companion/agents?project=${encodeURIComponent(project)}`);
export const getRunningAgents = (project: string) =>
  request<RunningAgent[]>(`/companion/agents/running?project=${encodeURIComponent(project)}`);
export const getAgentWork = (project: string, agent: string, folder = "inbox") =>
  request(`/companion/agents/work?project=${encodeURIComponent(project)}&agent=${encodeURIComponent(agent)}&folder=${folder}`);
export const wakeAgent = (project: string, agent: string) =>
  request("/companion/agents/wake", {
    method: "POST",
    body: JSON.stringify({ agent, project }),
  });
export const getReviews = (project: string) =>
  request<Review[]>(`/companion/reviews?project=${encodeURIComponent(project)}`);
export const readTerminal = (project: string, id: string, lines = 50) =>
  request<{ lines: string[] }>(`/companion/terminal/read?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}&lines=${lines}`);
export const writeTerminal = (project: string, id: string, message: string) =>
  request("/companion/terminal/write", {
    method: "POST",
    body: JSON.stringify({ id, message, project }),
  });
export const getStatus = (project: string) =>
  request(`/companion/status?project=${encodeURIComponent(project)}`);
