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

export interface Agent {
  name: string;
  role: string;
  type: "pod-member" | "pod-leader";
  work_counts: {
    inbox: number;
    active: number;
    done: number;
  };
}

export interface RunningAgent {
  name: string;
  terminal_id: string;
  project_path: string;
  started_at?: string;
}

export interface Review {
  id: string;
  agent: string;
  branch: string;
  title: string;
  summary?: string;
  preview_port?: number;
  preview_path?: string;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  color: string;
  icon_url?: string;
  agent_mode: string;
  agent_status?: "working" | "permission" | "review" | "idle";
  agents_running: number;
  reviews_pending: number;
}

export interface WorkspaceStatus {
  mode: string;
  project_name: string;
  project_path: string;
  agents_running: number;
  reviews_pending: number;
}

export interface GlobalSession {
  workspace_name: string;
  workspace_id: string;
  workspace_color: string;
  agent_name: string;
  terminal_id: string;
  started_at?: string;
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

// Use Tauri's HTTP plugin — requests go through Rust, bypassing WKWebView restrictions
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

export const getAgents = () => request<Agent[]>("/companion/agents");
export const getRunningAgents = () => request<RunningAgent[]>("/companion/agents/running");
export const getAgentWork = (agent: string, folder = "inbox") =>
  request(`/companion/agents/work?agent=${encodeURIComponent(agent)}&folder=${folder}`);
export const getReviews = () => request<Review[]>("/companion/reviews");
export const approveReview = (id: string) =>
  request("/companion/review/approve", { method: "POST", body: JSON.stringify({ id }) });
export const rejectReview = (id: string) =>
  request("/companion/review/reject", { method: "POST", body: JSON.stringify({ id }) });
export const reviewFeedback = (id: string, feedback: string) =>
  request("/companion/review/feedback", { method: "POST", body: JSON.stringify({ id, feedback }) });
export const readTerminal = (id: string, lines = 50) =>
  request<{ lines: string[] }>(`/companion/terminal/read?id=${encodeURIComponent(id)}&lines=${lines}`);
export const writeTerminal = (id: string, message: string) =>
  request("/companion/terminal/write", { method: "POST", body: JSON.stringify({ id, message }) });
export const getStatus = () => request<WorkspaceStatus>("/companion/status");
export const getWorkspaces = () => request<Workspace[]>("/companion/workspaces");
export const setActiveWorkspace = (workspaceId: string) =>
  request("/companion/workspaces/active", { method: "POST", body: JSON.stringify({ id: workspaceId }) });
export const getAllSessions = () => request<GlobalSession[]>("/companion/sessions");
export const wakeAgent = (agent: string) =>
  request<{ success: boolean; note: string }>("/companion/agents/wake", {
    method: "POST",
    body: JSON.stringify({ agent }),
  });
