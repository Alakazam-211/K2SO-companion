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

export function configure(url: string) {
  baseUrl = url.replace(/\/+$/, "");
}

export function getBaseUrl() {
  return baseUrl;
}

export function clearSession() {
  baseUrl = "";
}

// ─── Auth (HTTP only — needed to get the initial token before WS) ───

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
    // Token is used by WebSocket connection (passed via ws.connect)
    return json;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not connect: ${msg}` };
  }
}

// ─── WebSocket API (all data fetching goes through WS) ───

async function wsRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<ApiResponse<T>> {
  try {
    const result = await ws.request<ApiResponse<T>>(method, params);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Could not reach server: ${msg}` };
  }
}

// Global endpoints (no project param)
export const getProjects = () => wsRequest<Project[]>("projects.list");
export const getProjectsSummary = () => wsRequest<ProjectSummary[]>("projects.summary");
export const getAllSessions = () => wsRequest<GlobalSession[]>("sessions.list");

// Project-scoped endpoints
export const getAgents = (project: string) => wsRequest<Agent[]>("agents.list", { project });
export const getRunningTerminals = (project: string) => wsRequest<RunningTerminal[]>("agents.running", { project });
export const getAgentWork = (project: string, agent: string, folder = "inbox") =>
  wsRequest("agents.work", { project, agent, folder });
export const wakeAgent = (project: string, agent: string) =>
  wsRequest("agents.wake", { project, agent });
export const getReviews = (project: string) => wsRequest<Review[]>("reviews.list", { project });
export const readTerminal = (project: string, id: string, lines = 50) =>
  wsRequest<{ lines: string[] }>("terminal.read", { project, id, lines });
export const writeTerminal = (project: string, id: string, message: string) =>
  wsRequest("terminal.write", { project, id, message });
export const getStatus = (project: string) => wsRequest("status", { project });
