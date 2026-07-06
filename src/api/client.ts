import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { ws } from "./websocket";
import { useServersStore } from "../stores/servers";
import { isPossibleAuthFailure, reviveServerSession } from "../lib/revive";

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
  /** True when this session is the workspace's pinned "main chat" tab.
   *  Rendered as "main chat tab" regardless of its raw label. */
  isMainChat?: boolean;
  /** Canonical tab id (the tab_titles / layout key) for tab-driven
   *  sessions; null for the pinned chat / non-tab sessions. Used to rename
   *  the tab via set-tab-title. */
  tabId?: string | null;
  /** Workspace/project id the daemon resolved this session to. */
  projectId?: string;
  command?: string | null;
  cwd: string;
}

/** Display name for a session row/header: the daemon-level TAB NAME.
 *  The workspace's pinned chat session always shows as "main chat tab";
 *  every other tab uses its live label, falling back to the agent name. */
export function sessionLabel(
  s: Pick<GlobalSession, "isMainChat" | "label" | "agentName">
): string {
  if (s.isMainChat) return "main chat tab";
  return s.label || s.agentName;
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

// 0.40.x: the companion talks DIRECTLY to the K2 daemon's `/cli/*` routes.
// The base URL is the daemon origin — `https://<sub>.k2.dev` over the
// K2 Connect tunnel, or `http://127.0.0.1:<daemon.port>` for localhost
// dev. The session token comes from `POST /cli/auth/login`; it
// authenticates every `/cli/*` call as the `?token=` query param (the same
// param the daemon's grid-WS and CLI use).
//
// C1: the old module globals are now DERIVED from the ACTIVE server in
// `stores/servers.ts` — switching servers instantly redirects every call,
// and a token revived after a stale-session 401/403 is picked up on the
// next attempt with no plumbing here.

export function getBaseUrl(): string {
  const s = useServersStore.getState();
  const active = s.servers.find((x) => x.id === s.activeServerId);
  return active?.url ?? "";
}

export function getToken(): string {
  const s = useServersStore.getState();
  return (s.activeServerId && s.tokens[s.activeServerId]) || "";
}

// ─── HTTP via Tauri plugin (bypasses WKWebView restrictions) ───
//
// The daemon's `/cli/*` routes return RAW JSON (the payload directly —
// an array or object), NOT a `{ok,data,error}` envelope. We wrap a 2xx
// body as `{ok:true, data}` and map non-2xx to `{ok:false, error}` so
// the rest of the app keeps its `ApiResponse<T>` contract.
//
// Stale-session recovery (desktop `daemon-cli.ts cliFetch` parity): a
// daemon restart wipes its in-memory connect-user sessions, after which
// every authed call returns 403 "Invalid or missing auth token" (NOT 401).
// On an auth-classified rejection we run `reviveServerSession`
// (single-flight whoami-confirm + silent re-login with the remembered
// password) and, ONLY if a fresh token was actually minted, replay the
// request ONCE with the new creds (the URL is rebuilt per attempt so the
// replay carries the fresh token). Every other failure surfaces unchanged;
// a 401/403 rejected the request before doing work, so the single replay
// is side-effect-safe.

async function httpRequest<T>(
  path: string,
  options: { method?: string; body?: string; project?: string } = {},
  timeoutMs = 15000,
  extraParams?: Record<string, string>
): Promise<ApiResponse<T>> {
  if (!getBaseUrl()) return { ok: false, error: "Not connected" };

  // ONE attempt: resolve the ACTIVE server's base+token fresh, build the
  // URL, fire, and read the body exactly once (both the auth-failure
  // classifier and the parse below need it).
  const attempt = async (): Promise<{ status: number; ok: boolean; text: string }> => {
    const base = getBaseUrl();
    const token = getToken();

    // Build query: project + extra params + the auth token.
    let url = `${base}${path}`;
    const params: string[] = [];
    if (options.project) {
      params.push(`project=${encodeURIComponent(options.project)}`);
    }
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
    }
    if (token) {
      params.push(`token=${encodeURIComponent(token)}`);
    }
    if (params.length > 0) {
      // Use `&` when `path` already carries a query string (GET routes whose
      // params the `request` wrapper appended to the path). Appending `?` here
      // unconditionally produced `...?a=b?token=z`, folding the token into the
      // last param value so the daemon saw NO token → 403 (e.g. rename "snapped
      // back" because set-label silently failed).
      url += (url.includes("?") ? "&" : "?") + params.join("&");
    }

    const res = await Promise.race([
      tauriFetch(url, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: options.body || undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs)
      ),
    ]);
    return { status: res.status, ok: res.ok, text: await res.text() };
  };

  try {
    let out = await attempt();
    if (isPossibleAuthFailure(out.status, out.text)) {
      const serverId = useServersStore.getState().activeServerId;
      if (serverId) {
        const outcome = await reviveServerSession(serverId);
        // 'revived' means the store now carries a NEW token — replay once so
        // the caller never sees the transient stale-session rejection. Any
        // other outcome (still-valid role denial, sign-in required, network,
        // cooldown) keeps the original response.
        if (outcome === "revived") out = await attempt();
      }
    }
    if (out.status === 401) return { ok: false, error: "Unauthorized" };
    if (!out.ok) {
      // Daemon error bodies are `{error: "..."}` on non-2xx.
      let msg = `HTTP ${out.status}`;
      try {
        const j = JSON.parse(out.text) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: msg };
    }
    const data = JSON.parse(out.text) as T;
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

// ─── Auth ───
//
// `POST /cli/auth/login` now lives in `stores/servers.ts` (`loginToServer`
// / `loginAndSaveServer`) — the same mint flow the revive path re-runs at
// runtime. This module only DERIVES the active server's creds.

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
// "Wake" the workspace agent — same route the host CLI uses
// (`k2 ...` → GET /cli/agents/heartbeat?agent=<name>&force_wake=1),
// scoped by `project`. (Not exercised in tests — waking spawns a real
// agent session.)
export const wakeAgent = (project: string, agent: string) =>
  request("agents.wake", "/cli/agents/heartbeat", { project, agent, force_wake: 1 });
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
// Spawn a NEW tab (a fresh grid-WS-attachable v2 session) in the workspace.
// `/cli/terminal/spawn-background` doesn't exist (that's why "new tab"
// failed); v2/spawn registers the PTY in the v2 map so the grid-WS can stream
// it. A unique agent_name makes it a DISTINCT session (not the canonical chat).
export const spawnNewTab = (cwd: string, label = "new tab") => {
  const agent_name =
    "tab-" + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36));
  return request<{ sessionId: string; agentName: string; reused?: boolean }>(
    "sessions.v2_spawn", "/cli/sessions/v2/spawn",
    {
      agent_name,
      cwd,
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      label,
    },
    { method: "POST" }
  );
};
// Rename a TAB — writes the CANONICAL tab title in SQLite (the same
// `tab_titles` row the desktop uses), `locked` so program-generated PTY
// titles can't overwrite the user's chosen name. Both surfaces read this.
export const setTabTitle = (projectId: string, tabId: string, title: string) =>
  request<{ success?: boolean }>(
    "workspace.set_tab_title", "/cli/workspace/set-tab-title",
    { projectId, tabId, title, locked: true }, { method: "POST" }
  );
// Open (or resume) the workspace's pinned "main chat" session. Returns
// the daemon PTY `sessionId` to navigate to. Idempotent — a live chat is
// returned as-is (reused) unless `forceRespawn` kills + re-resolves it (the
// RELOAD path: a plain ensure would just hand back the already-live session,
// which is why reload couldn't restore the selected session). `explicitSelection`
// mirrors the desktop dropdown-switch (errors instead of converging when the
// picked session is gone).
export const ensurePinnedChat = (
  project: string,
  opts?: { forceRespawn?: boolean; explicitSelection?: boolean }
) =>
  request<{ sessionId: string; claudeSessionId?: string; reused?: boolean }>(
    "workspace.ensure_pinned_chat", "/cli/workspace/ensure-pinned-chat",
    {
      project,
      ...(opts?.forceRespawn ? { forceRespawn: true } : {}),
      ...(opts?.explicitSelection ? { explicitSelection: true } : {}),
    },
    { method: "POST" }
  );
export const writeTerminal = (project: string, id: string, message: string) =>
  request("terminal.write", "/cli/terminal/write", { project, id, message }, { method: "POST" });
// Unpin a session's PTY size (the "Claim session" release path). The
// CLAIM itself rides the grid-WS `claim_pin` action (socket-bound,
// auto-clears on disconnect); the release uses the daemon's normal
// pin-size route with `clear:true` — same endpoint the desktop's pin
// controls use, so either end can unpin.
export const clearTerminalPin = (session: string) =>
  request<{ success?: boolean; pinned?: unknown }>(
    "terminal.pin_size", "/cli/terminal/pin-size",
    { session, clear: true }, { method: "POST" }
  );
export const getStatus = (project: string) =>
  request("status", "/cli/companion/status", { project });
