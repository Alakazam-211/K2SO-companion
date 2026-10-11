import { apiErrorText } from "../lib/apiError";
import { NOT_CONNECTED, scopedFetch } from "./scopedFetch";
import {
  bootInfoFor,
  ensureBootStatus,
  noteBootStatus,
  readBootStatus,
  serverMemory,
  versionAtLeast,
  type BootInfo,
  type ServerScope,
} from "./scope";
import type { CompanionCapabilities } from "../kessel/capabilities";

export type { CompanionCapabilities };
export type { ServerScope };
export { supportsK1Grid } from "../kessel/capabilities";
export { chooseGridDial } from "../kessel/gridUrl";
export type { GridDial } from "../kessel/gridUrl";

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /** HTTP status of a non-2xx answer (absent on network errors). */
  status?: number;
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
  agentType?: string;
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

/** One pinned file from `GET /cli/workspace/resources` (K2 0.45+). */
export interface WorkspaceResourceDoc {
  filePath: string;
  fileName: string;
  /** Unix seconds. */
  addedAt: number;
  /** True when the pinned file is gone from disk. */
  missing: boolean;
}

export interface WorkspaceResources {
  ok?: boolean;
  workspaceId?: string;
  docs?: WorkspaceResourceDoc[];
}

/** `GET /cli/fs/read-file` — text, 10MB cap. */
export interface FsFileContent {
  content: string;
  path: string;
  name: string;
}

// 0.40.x: the companion talks DIRECTLY to the K2 daemon's `/cli/*` routes.
// The base URL is the daemon origin — `https://<sub>.k2.dev` over the
// K2 Connect tunnel, or `http://127.0.0.1:<daemon.port>` for localhost
// dev. The session token comes from `POST /cli/auth/login`. HTTP `/cli/*`
// sends it as `Authorization: Bearer` (loopback owner GETs accept that
// header, 2026-09-29). Query `?token=` stays only on WebSocket URLs that
// cannot set headers: grid WS, `/companion/ws`, `/events`. Wiki:
// `.k2/wiki/Defect - Query-string token.md`. Connect-tunnel Bearer is
// unproven.
//
// Multi-server S1 (MS5): every endpoint takes the `ServerScope` it talks
// to as its FIRST argument (`api/scope.ts`). There is no hidden "active
// server" in this module: classic pages pass `activeScope()`, Zen passes
// `zenScope()`, a room passes its own scope. The scope is captured once per
// call and a revive/replay stays on it (MS7).

/** Companion-listener session token (`POST /companion/auth`) for a scope.
 *  Distinct from the Connect `/cli/auth/login` token (`scope.token()`).
 *  Empty until companion auth is wired — never stamp the Connect token on
 *  `/companion/sessions/grid`. */
export function companionTokenFor(_scope: ServerScope): string {
  return "";
}

// ─── HTTP via Tauri plugin (bypasses WKWebView restrictions) ───
//
// The daemon's `/cli/*` routes return RAW JSON (the payload directly —
// an array or object), NOT a `{ok,data,error}` envelope. We wrap a 2xx
// body as `{ok:true, data}` and map non-2xx to `{ok:false, error}` so
// the rest of the app keeps its `ApiResponse<T>` contract.
//
// Stale-session recovery (desktop `daemon-cli.ts cliFetch` parity) lives in
// `scopedFetch`: an auth-classified rejection (401, or 403 with the token-
// gate body) revives THE SCOPE'S server and, only when a fresh token was
// minted, replays ONCE on the same scope. A 401/403 rejected the request
// before doing work, so the single replay is side-effect-safe.

async function httpRequest<T>(
  scope: ServerScope,
  path: string,
  options: { method?: string; body?: string; project?: string } = {},
  timeoutMs = 15000,
  extraParams?: Record<string, string>
): Promise<ApiResponse<T>> {
  try {
    // Build query: project + extra params. Auth is the Bearer header.
    const query: Record<string, string> = {};
    if (options.project) query.project = options.project;
    Object.assign(query, extraParams ?? {});
    let out;
    try {
      out = await scopedFetch(scope, path, {
        method: options.method,
        body: options.body,
        query,
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof Error && err.message === NOT_CONNECTED) {
        return { ok: false, error: NOT_CONNECTED };
      }
      throw err;
    }
    if (out.status === 401) return { ok: false, error: "Unauthorized", status: 401 };
    if (!out.ok) {
      // Daemon bodies are `{error:"..."}` or `{error:{code,hint}}`. The
      // object form is not a React child — stringify before it reaches JSX.
      return {
        ok: false,
        error: apiErrorText(out.text, `HTTP ${out.status}`),
        status: out.status,
      };
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
// HTTP only. The old WS-first branch (`/companion/ws` RPC) was dormant —
// that socket is never connected — and one global RPC socket cannot be
// scope-correct, so it is gone. The k1 grid-WS is GridSocket's own stream.

async function request<T>(
  scope: ServerScope,
  httpPath: string,
  params: Record<string, unknown> = {},
  httpOptions: { method?: string } = {}
): Promise<ApiResponse<T>> {
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

  return httpRequest<T>(scope, path, { method: httpOptions.method, body, project });
}

// ─── Auth ───
//
// `POST /cli/auth/login` lives in `stores/servers.ts` (`loginToServer`
// / `loginAndSaveServer`). Creds come from the scope at call time.

// ─── API endpoints (daemon `/cli/*`) ───

// Global (no project param)
export const getProjects = (scope: ServerScope) =>
  request<Project[]>(scope, "/cli/companion/projects", {});
export const getProjectsSummary = (scope: ServerScope) =>
  request<ProjectSummary[]>(scope, "/cli/companion/projects-summary", {});

/** DEBUG-only. One GET of /cli/companion/projects-summary on `scope`.
 *  Returns HTTP status + parsed JSON. Never returns the URL, token, headers,
 *  or raw body. No revive (a probe must not move recovery state). */
export async function inspectProjectsSummary(scope: ServerScope): Promise<{
  status: number | null;
  data: unknown;
  note: string | null;
}> {
  let base = "";
  let token = "";
  try {
    base = scope.httpBase();
    token = scope.token();
  } catch (err) {
    return { status: null, data: undefined, note: err instanceof Error ? err.message : "Not connected" };
  }
  if (!base) return { status: null, data: undefined, note: NOT_CONNECTED };
  if (!token) return { status: null, data: undefined, note: "No session token" };
  try {
    const res = await scopedFetch(scope, "/cli/companion/projects-summary", { revive: false });
    try {
      return {
        status: res.status,
        data: JSON.parse(res.text) as unknown,
        note: res.ok ? null : `HTTP ${res.status}`,
      };
    } catch {
      return { status: res.status, data: undefined, note: "Body is not JSON" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { status: null, data: undefined, note: `Could not reach server: ${msg}` };
  }
}
export const getPresets = (scope: ServerScope) =>
  request<CliPreset[]>(scope, "/cli/companion/presets", {});
export const getAllSessions = (scope: ServerScope) =>
  request<GlobalSession[]>(scope, "/cli/companion/sessions", {});

// Project-scoped.
// NOTE: the PRIMARY path (sessions list + live terminal) uses the
// verified routes below — list-running / terminal read+write+spawn /
// companion sessions. Secondary screens (agents, work, wake, reviews)
// map onto `/cli/*` whose param shapes are UNVERIFIED and untracked.
// docs/companion-revival.md Phase 4 is grid-WS, marked done — it does
// not track this. Wiki: `.k2/wiki/Unverified - CLI param shapes.md`.
export const getAgents = (scope: ServerScope, project: string) =>
  request<Agent[]>(scope, "/cli/agents/list", { project });
/** Owner fleet. Live 200: `{ok:true, agents:[{enabled,live,mode,name,path}]}`.
 *  This is what `k2 agent list` calls. Plural `/cli/agents/list` is skills.
 *  No handle on this route. Overlay addrs come from `getCliProjectsList`. */
export const getAgentList = (scope: ServerScope) =>
  request<unknown>(scope, "/cli/agent/list", {});
/** Full project rows. Live 200 (loopback 60753, 2026-09-30): a bare JSON
 *  array; every row has `handle` and `path`. This is the overlay address
 *  book. Not `/cli/companion/projects-summary` (name+path only) and not
 *  `getProjects` (`/cli/companion/projects`). Join to the agent list on
 *  `path`, never on `name`. */
export const getCliProjectsList = (scope: ServerScope) =>
  request<unknown>(scope, "/cli/projects/list", {});
/** `POST /cli/projects/activate {projectId}` (Member): "someone is using
 *  this workspace" — the room keep-alive (multi-server MS24, MA16). The
 *  daemon touches the need clock, lifts a pending dismiss and broadcasts
 *  `active_changed` on EVERY call, with no rate limit, and answers
 *  `{ok:true}` even for an unknown id: callers validate the id against
 *  `projects/list` and go through `zen/room/keepAlive.ts` (10 min dedupe). */
export const activateProject = (scope: ServerScope, projectId: string) =>
  request<unknown>(scope, "/cli/projects/activate", { projectId }, { method: "POST" });
/** Skin rooms. Live 200: `{agents:[{displayName,handle,projectId}]}`. Grant-scoped. */
export const getSkinAgents = (scope: ServerScope) =>
  request<unknown>(scope, "/cli/skin/agents", {});
export const getRunningTerminals = (scope: ServerScope, project: string) =>
  request<RunningTerminal[]>(scope, "/cli/terminal/list-running", { project });
export const getAgentWork = (scope: ServerScope, project: string, agent: string, folder = "inbox") =>
  request(scope, "/cli/inbox/list", { project, agent, folder });
// "Wake" the workspace agent — same route the host CLI uses
// (`k2 ...` → GET /cli/agents/heartbeat?agent=<name>&force_wake=1),
// scoped by `project`. (Not exercised in tests — waking spawns a real
// agent session.)
export const wakeAgent = (scope: ServerScope, project: string, agent: string) =>
  request(scope, "/cli/agents/heartbeat", { project, agent, force_wake: 1 });
export const getReviews = (scope: ServerScope, project: string) =>
  request<Review[]>(scope, "/cli/reviews", { project });
// HTTP for terminal read — needs the scrollback param.
export const readTerminal = (scope: ServerScope, project: string, id: string, lines = 500) =>
  httpRequest<{ lines: string[] }>(scope, "/cli/terminal/read", {
    project,
    method: "GET",
  }, 15000, { id, lines: String(lines), scrollback: "true" });
export const spawnTerminal = (scope: ServerScope, project: string, command: string, title?: string) =>
  request(scope, "/cli/terminal/spawn", { project, command, title }, { method: "POST" });
export const spawnBackgroundTerminal = (scope: ServerScope, project: string, command: string, cwd?: string) =>
  request<{ success: boolean; terminalId: string; command: string }>(scope, "/cli/terminal/spawn-background",
    { project, command, cwd: cwd || project }, { method: "POST" }
  );
// Spawn a NEW tab (a fresh grid-WS-attachable v2 session) in the workspace.
// `/cli/terminal/spawn-background` doesn't exist (that's why "new tab"
// failed); v2/spawn registers the PTY in the v2 map so the grid-WS can stream
// it. A unique agent_name makes it a DISTINCT session (not the canonical chat).
export const spawnNewTab = (scope: ServerScope, cwd: string, label = "new tab") => {
  const agent_name =
    "tab-" + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36));
  return request<{ sessionId: string; agentName: string; reused?: boolean }>(scope, "/cli/sessions/v2/spawn",
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

/** Extra overlay chat: desktop sidecar is `POST /cli/sessions/v2/spawn`.
 *  `agent_name` is the overlay suffix (`1`, `2`, …). The first persist
 *  allocates `workspace/handle`. Do not invent the row client-side. */
export const spawnSidecarSession = (scope: ServerScope, 
  cwd: string,
  agentName: string,
  label: string,
  launch: { command: string; args: string[] } = {
    command: "claude",
    args: ["--dangerously-skip-permissions"],
  }
) =>
  request<{ sessionId: string; agentName: string; reused?: boolean }>(scope, "/cli/sessions/v2/spawn",
    {
      agent_name: agentName,
      cwd,
      command: launch.command,
      args: launch.args,
      label,
    },
    { method: "POST" }
  );

/** A new plain tab running `launch` (`agent_name: tab-<uuid>`). For
 *  presets the daemon cannot host as an overlay sidecar (no `ws/N`). */
export const spawnTabSession = (scope: ServerScope, 
  cwd: string,
  launch: { command: string; args: string[] },
  label: string
) =>
  request<{ sessionId: string; agentName: string; reused?: boolean }>(scope, "/cli/sessions/v2/spawn",
    {
      agent_name: "tab-" + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)),
      cwd,
      command: launch.command,
      args: launch.args,
      label,
    },
    { method: "POST" }
  );

/** Wake a past conversation as a new tab, the way desktop Chat history
 *  does (`TerminalPane` → `POST /cli/sessions/v2/spawn`): `launch` already
 *  carries the harness's resume argv; the title is locked like desktop's.
 *  The daemon reads the conversation id back from argv and keys the tab's
 *  Thread to it, so the old messages stay attached. */
export const spawnResumeTab = (
  scope: ServerScope,
  cwd: string,
  launch: { command: string; args: string[] },
  label: string
) =>
  request<{ sessionId: string; agentName: string; reused?: boolean; conversationId?: string }>(
    scope,
    "/cli/sessions/v2/spawn",
    {
      agent_name: "tab-" + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)),
      cwd,
      command: launch.command,
      args: launch.args,
      label,
      label_locked: true,
    },
    { method: "POST" }
  );

/** One enabled agent preset (Settings → Agents on desktop). `command` is
 *  the full launch line, e.g. `codex --yolo`; `icon` is a custom preset's
 *  emoji (built-ins send ""). */
export type AgentPreset = { id: string; name: string; command: string; icon?: string | null };

/** GET `/cli/companion/presets` (WS `presets.list`, Member): the server's
 *  ENABLED presets, sorted as desktop's launcher. 404 on older daemons. */
export const getActivePresets = (scope: ServerScope) =>
  request<AgentPreset[]>(scope, "/cli/companion/presets", {});
// Rename a TAB — writes the CANONICAL tab title in SQLite (the same
// `tab_titles` row the desktop uses), `locked` so program-generated PTY
// titles can't overwrite the user's chosen name. Both surfaces read this.
export const setTabTitle = (scope: ServerScope, projectId: string, tabId: string, title: string) =>
  request<{ success?: boolean }>(scope, "/cli/workspace/set-tab-title",
    { projectId, tabId, title, locked: true }, { method: "POST" }
  );
/** The K2 version that made `FORMERLY_GET_WRITES` POST-only (GET 405s). */
export const POST_ONLY_WRITES_SINCE = "0.44.4";

/** Per server: routes this server refused as POST with a 405, so it is a
 *  pre-0.44.4 daemon that still wants the old GET (MA15). Keyed by server
 *  id, dropped on removal / re-key. */
const legacyGetRoutes = serverMemory(() => new Set<string>());

/** MA15: which verb `scope` takes for a write that 0.44.4 moved from GET to
 *  POST. A known version decides (>= 0.44.4 → POST, older → GET); unknown
 *  → POST, unless this server already 405'd the POST. */
export function writeVerbFor(scope: ServerScope, httpPath: string): "POST" | "GET" {
  if (scope.id && legacyGetRoutes.peek(scope.id)?.has(httpPath)) return "GET";
  const version = scope.version();
  if (version) return versionAtLeast(version, POST_ONLY_WRITES_SINCE) ? "POST" : "GET";
  return "POST";
}

/** A write on a route K2 0.44.4 made POST-only (`FORMERLY_GET_WRITES` in
 *  K2 `route_policy.rs`; GET now 405s). The verb is chosen PER SERVER
 *  (`writeVerbFor`). When it is POST and the server 405s it (an older
 *  daemon we had no version for), retry ONCE as the old GET with the params
 *  on the query string, and remember that for this server only. */
async function postWithLegacyGet<T>(
  scope: ServerScope,
  httpPath: string,
  params: Record<string, unknown>
): Promise<ApiResponse<T>> {
  if (writeVerbFor(scope, httpPath) === "GET") return request<T>(scope, httpPath, params);
  const r = await request<T>(scope, httpPath, params, { method: "POST" });
  if (r.ok || r.status !== 405) return r;
  const legacy = await request<T>(scope, httpPath, params);
  // Remember only when the GET is what this server wants.
  if (legacy.status !== 405 && scope.id) legacyGetRoutes.get(scope.id).add(httpPath);
  return legacy;
}

/** Tests only: forget which servers wanted the legacy GET verb. */
export function resetWriteVerbMemory(): void {
  legacyGetRoutes.clear();
}

/** Overlay extra title. `POST /cli/sessions/label {id, label}` (K2
 *  0.44.4+ is POST-only; GET 405s). Older daemons 405 the POST and take
 *  `GET ?id=<uuid>&label=<text>`, so that is the fallback (per server,
 *  MA15). Omit `lock`; daemon default true → Locked. The response echoes
 *  `{label, locked}`. Companion/sessions then returns that label for
 *  non-tab extras (K2 `20c49e2b`+). Pty/Seed titles stay the derived name.
 *  `tab-*` still uses `tab_titles`. */
export const setSessionLabel = (scope: ServerScope, id: string, label: string) =>
  postWithLegacyGet<{ success?: boolean; label?: string; locked?: boolean }>(
    scope,
    "/cli/sessions/label",
    { id, label }
  );
// Open (or resume) the workspace's pinned "main chat" session. Returns
// the daemon PTY `sessionId` to navigate to. Idempotent — a live chat is
// returned as-is (reused) unless `forceRespawn` kills + re-resolves it (the
// RELOAD path: a plain ensure would just hand back the already-live session,
// which is why reload couldn't restore the selected session). `explicitSelection`
// mirrors the desktop dropdown-switch (errors instead of converging when the
// picked session is gone).
export const ensurePinnedChat = (scope: ServerScope, 
  project: string,
  opts?: { forceRespawn?: boolean; explicitSelection?: boolean }
) =>
  request<{ sessionId: string; claudeSessionId?: string; reused?: boolean }>(scope, "/cli/workspace/ensure-pinned-chat",
    {
      project,
      ...(opts?.forceRespawn ? { forceRespawn: true } : {}),
      ...(opts?.explicitSelection ? { explicitSelection: true } : {}),
    },
    { method: "POST" }
  );
export const writeTerminal = (scope: ServerScope, project: string, id: string, message: string) =>
  request(scope, "/cli/terminal/write", { project, id, message }, { method: "POST" });
// Unpin a session's PTY size (the "Claim session" release path). The
// CLAIM itself rides the grid-WS `claim_pin` action (socket-bound,
// auto-clears on disconnect); the release uses the daemon's normal
// pin-size route with `clear:true` — same endpoint the desktop's pin
// controls use, so either end can unpin.
export const clearTerminalPin = (scope: ServerScope, session: string) =>
  request<{ success?: boolean; pinned?: unknown }>(scope, "/cli/terminal/pin-size",
    { session, clear: true }, { method: "POST" }
  );
export const getStatus = (scope: ServerScope, project: string) =>
  request(scope, "/cli/companion/status", { project });

/** Workspace Resources: the files pinned in the desktop Files drawer.
 *  `workspace` is a path, name or UUID. An unknown workspace is a 404
 *  `{error:{code:"not_found"}}`; a pre-0.45 daemon 404s "route not found".
 *  The list changes on `workspace_resources_changed` (sessions/events),
 *  which the phone does not hear, so callers re-fetch on open. */
export const getWorkspaceResources = (scope: ServerScope, workspace: string) =>
  request<WorkspaceResources>(scope, "/cli/workspace/resources",
    { workspace }
  );

export const getFsReadFile = (scope: ServerScope, path: string) =>
  request<FsFileContent>(scope, "/cli/fs/read-file", { path });

// File viewer bytes: desktop `lib/load-host-binary.ts` routes. Base64 in
// JSON; `read-binary` is capped at 50MB, `read-range` at 16MB a slice.
// A slow tunnel moves 50MB of base64 well past the 15s default.
const FS_BYTES_TIMEOUT_MS = 120000;

/** `GET /cli/fs/read-binary?path=` → `{ base64 }`. */
export const getFsReadBinary = (scope: ServerScope, path: string) =>
  httpRequest<{ base64?: string }>(scope, `/cli/fs/read-binary?path=${encodeURIComponent(path)}`,
    {},
    FS_BYTES_TIMEOUT_MS
  );

export interface FsReadRange {
  base64: string;
  len: number;
  size: number;
  eof: boolean;
}

/** `GET /cli/fs/read-range?path=&offset=&len=` → one slice. */
export const getFsReadRange = (scope: ServerScope, path: string, offset: number, len: number) =>
  httpRequest<FsReadRange>(scope, `/cli/fs/read-range?path=${encodeURIComponent(path)}&offset=${offset}&len=${len}`,
    {},
    FS_BYTES_TIMEOUT_MS
  );

export interface FsZipEntry {
  name: string;
  size: number;
  compressed_size?: number;
  is_dir: boolean;
}

/** `GET /cli/fs/zip-list?path=` — central directory only, no extract. */
export const getFsZipList = (scope: ServerScope, path: string) =>
  request<{ entries?: FsZipEntry[]; truncated?: boolean }>(scope, "/cli/fs/zip-list",
    { path }
  );

/** Skin route POST /cli/fs/upload-binary. `workspace` is the overlay
 *  handle. Companion `dir` is this agent's own absolute workspace path.
 *  Skin `dir: "."` is room-relative; here it is the daemon cwd and
 *  writes EROFS. Empty dir is refused as "Destination Directory is Empty". */
export const uploadFsBinary = (scope: ServerScope, 
  workspace: string,
  dir: string,
  filename: string,
  base64: string
) =>
  request<{ path: string }>(scope, "/cli/fs/upload-binary",
    { workspace, dir, filename, base64 },
    { method: "POST" }
  );

/** Thread history. Skin: GET /cli/thread?addr=&limit=&before_seq= */
export type ThreadDoc = {
  id?: string;
  seq?: number;
  kind?: string;
  from?: string;
  body?: string;
  text?: string;
  created_at?: number;
  conversation_id?: string;
  choice?: { prompt?: string; options?: unknown; answer?: unknown };
  secret?: { prompt?: string };
};

export type ThreadItem = ThreadDoc & {
  doc?: ThreadDoc;
  collection?: string;
};

export type ThreadPage = {
  conversation_id?: string;
  has_more?: boolean;
  items?: ThreadItem[];
};

export const getThread = (scope: ServerScope, addr: string, limit = 50, beforeSeq?: number) =>
  request<ThreadPage>(scope, "/cli/thread", {
    addr,
    limit,
    ...(beforeSeq != null ? { before_seq: beforeSeq } : {}),
  });

/** Owner send. Same route as skin. `via: "compose"` is the owner door
 *  (loopback skin-test-a seq 32: from=owner via=compose). Omit it and
 *  the daemon records from=<addr> via=thread. Skin tokens 403 this field. */
export const postThread = (scope: ServerScope, addr: string, text: string) =>
  request<ThreadItem>(scope, "/cli/thread/post",
    { addr, text, via: "compose" },
    { method: "POST" }
  );

// Pre-0.45 servers have neither activity route. Per server (by id, MS8 /
// MA2): a server whose `/boot-status` listed features without
// `daemon-activity` is never asked (MS31); otherwise a route-level 404 is
// remembered so the Chats poll and every Thread open stop asking. Module
// memory: an app restart or update asks again.
/** Did this server's `/boot-status` carry a `features` list at all? */
function bootFeaturesListed(scope: ServerScope): boolean {
  return !!(scope.id && bootInfoFor(scope.id)?.features);
}

const noActivityRoutes = serverMemory(() => ({ missing: false }));
const ROUTE_NOT_FOUND = "route not found";

function activityRoutesMissing(scope: ServerScope): ApiResponse<never> | null {
  const missing: ApiResponse<never> = { ok: false, error: ROUTE_NOT_FOUND, status: 404 };
  if (!scope.id) return null;
  if (noActivityRoutes.peek(scope.id)?.missing) return missing;
  // Feature memory says "no" only when this server listed its features.
  const listed = bootFeaturesListed(scope);
  if (listed && !scope.supports("daemon-activity")) return missing;
  return null;
}

function noteActivityRoutesMissing(scope: ServerScope): void {
  if (scope.id) noActivityRoutes.get(scope.id).missing = true;
}

/** Tests only: forget which servers lack the activity routes. */
export function resetActivityRouteMemory(): void {
  noActivityRoutes.clear();
}

/** Working-strip catch-up (K2 0.45.0+): the live Thread turn, or
 *  `{turn: null}`. Call on every overlay socket (re)open; activity frames
 *  are never replayed. App passes get 403. */
export async function getThreadActivity(
  scope: ServerScope,
  addr: string
): Promise<ApiResponse<{ turn?: unknown }>> {
  const missing = activityRoutesMissing(scope);
  if (missing) return missing;
  const r = await request<{ turn?: unknown }>(scope, "/cli/thread/activity", { addr });
  // An unknown addr is a 404 too (`{error:{code:"not_found"}}`). Only the
  // daemon's own "route not found" means the server predates the route.
  if (r.status === 404 && r.error === ROUTE_NOT_FOUND) noteActivityRoutesMissing(scope);
  return r;
}

/** Agent activity (K2 0.45.0+): one row per live session plus a rollup
 *  per workspace. `counts` arrived in 0.45.2 (missing = zeros). */
export async function getActivitySnapshot(
  scope: ServerScope
): Promise<ApiResponse<{ rows?: unknown[]; workspaces?: unknown[]; serverNow?: number }>> {
  const missing = activityRoutesMissing(scope);
  if (missing) return missing;
  const r = await request<{ rows?: unknown[]; workspaces?: unknown[]; serverNow?: number }>(
    scope,
    "/cli/activity/snapshot",
    {}
  );
  if (r.status === 404) noteActivityRoutesMissing(scope);
  return r;
}

/** Overlay choice card. Skin: POST `/cli/thread/answer`
 *  `{ addr, id, answer }` — `answer` is the option text. Secret cards
 *  are never posted. */
export const answerThread = (scope: ServerScope, addr: string, id: string, answer: string) =>
  request(scope, "/cli/thread/answer", { addr, id, answer }, { method: "POST" });

/** Probe whether THIS origin registered the companion k1 grid upgrade.
 *  `{gridProto:["k1"]}` + a companion token → companion grid WS.
 *  404 / miss → Connect daemon; dial `/cli/sessions/grid` Watch. */
export const getCompanionCapabilities = (scope: ServerScope) =>
  request<CompanionCapabilities>(scope, "/companion/capabilities",
    {},
  );

// ─── Server pins + focus groups (K2 `focus-groups-pinned-agents-for-the-phone` §3) ───
// Pins are per workspace on the server (`projects.pinned` + `tab_order`);
// both writes emit `projects_changed` on `/cli/sessions/events`. Focus
// groups: `settings/get` carries `focusGroupsEnabled` + `activeFocusGroupId`
// (one value per server); names come from `focus-groups/list`.

/** `GET /cli/settings/get` — the daemon's global settings object. */
export const getAppSettings = (scope: ServerScope) =>
  request<unknown>(scope, "/cli/settings/get", {});
/** `GET /cli/focus-groups/list` — `FocusGroup[]` in `tabOrder`. */
export const getFocusGroupsList = (scope: ServerScope) =>
  request<unknown>(scope, "/cli/focus-groups/list", {});
/** `POST /cli/focus-groups/assign {projectId, focusGroupId}` (Member) — the
 *  updated `Project`. `null` ungroups. Server-wide, like desktop. Emits NO
 *  `projects_changed`: the caller updates its own state and refetches. */
export const assignFocusGroup = (scope: ServerScope, projectId: string, focusGroupId: string | null) =>
  request<unknown>(scope, "/cli/focus-groups/assign",
    { projectId, focusGroupId },
    { method: "POST" }
  );
/** `POST /cli/focus-groups/create {name, color?}` (Member) — the new `FocusGroup`. */
export const createFocusGroup = (scope: ServerScope, name: string, color?: string | null) =>
  request<unknown>(scope, "/cli/focus-groups/create",
    color ? { name, color } : { name },
    { method: "POST" }
  );
/** `POST /cli/projects/update {id, pinned: 1|0}` — the desktop's Pin to Top. */
export const setProjectPinned = (scope: ServerScope, id: string, pinned: boolean) =>
  request<unknown>(scope, "/cli/projects/update",
    { id, pinned: pinned ? 1 : 0 },
    { method: "POST" }
  );
/** `POST /cli/projects/reorder {ids}` — `tab_order = index`. Send pinned ids only. */
export const reorderProjects = (scope: ServerScope, ids: string[]) =>
  request<unknown>(scope, "/cli/projects/reorder", { ids }, { method: "POST" });

// ─── New workspace (Agents `+`) ───

/** `POST /cli/workspace/create {path}` (Member). Makes the folder and
 *  registers it (name = folder basename); seeds the wiki + AGENTS.md.
 *  400 `{error}` when the folder exists or the path is registered. */
export type CreatedWorkspace = {
  success?: boolean;
  projectId?: string;
  workspaceId?: string;
  name?: string;
  path?: string;
};
export const createWorkspace = (scope: ServerScope, path: string) =>
  request<CreatedWorkspace>(scope, "/cli/workspace/create",
    { path },
    { method: "POST" }
  );
/** `GET /cli/fs/info` (Member) — `{home, separator, os}` of the host. */
export const getFsInfo = (scope: ServerScope) =>
  request<{ home?: string; separator?: string; os?: string }>(scope, "/cli/fs/info", {});
/** `POST /cli/projects/update {id, name?, color?, iconUrl?}` (Member).
 *  `iconUrl`: a `data:image/*` URL sets the workspace icon, `""` clears it
 *  (daemon `ProjectsUpdateBody`); absent leaves it alone. */
export const updateProjectLook = (
  scope: ServerScope,
  id: string,
  look: { name?: string; color?: string; iconUrl?: string }
) =>
  request<unknown>(
    scope,
    "/cli/projects/update",
    { id, ...look },
    { method: "POST" }
  );

// ─── Sessions drawer: Active terminals → threads, History ───

/** `GET /cli/sessions/list-for-workspace?path=` (Member): the live PTYs
 *  in one workspace, each with `kind` (`canonical` / `sidecar` / `other`),
 *  `handle` (`ws` or `ws/N`, empty for a blank shell) and, when the
 *  harness has one, `conversationId` (the Thread key). */
export const getWorkspaceLiveSessions = (scope: ServerScope, path: string) =>
  request<unknown>(scope, "/cli/sessions/list-for-workspace", { path });

/** `GET /cli/chat/list?project_path=` (Member): every harness conversation
 *  on disk for one workspace (desktop Chat History). `sessionId` is the
 *  conversation id; `timestamp` is ms; `provider` is the harness. */
export const getChatList = (scope: ServerScope, projectPath: string) =>
  request<unknown>(scope, "/cli/chat/list", { project_path: projectPath });

/** `GET /cli/chat/custom-names` (Member): `{ "<provider>:<id>": name }`. */
export const getChatCustomNames = (scope: ServerScope) =>
  request<unknown>(scope, "/cli/chat/custom-names", {});

/** `GET /cli/thread/latest?addrs=a,b` (Member, at most 50 addrs): last
 *  Thread message per addr, or `{addr, error}` when K2 has no Thread for it. */
export const getThreadLatest = (scope: ServerScope, addrs: string[]) =>
  request<unknown>(scope, "/cli/thread/latest", { addrs: addrs.join(",") });

/** `GET /cli/projects/get-icon?path=&project_id=` (Member): a workspace's
 *  picture as `{found, dataUrl}`. It WRITES the daemon's icon cache, so the
 *  phone asks only for a row with no `iconUrl`, at most once a day per
 *  server and project (multi-server MA24). */
export const getProjectIcon = (scope: ServerScope, path: string, projectId: string) =>
  request<{ found?: unknown; dataUrl?: unknown }>(scope, "/cli/projects/get-icon", {
    path,
    project_id: projectId,
  });

// ─── Boot status + feature keys (`GET /boot-status`, unauthenticated) ───
//
// One memory per server id: `api/scope.ts` (`noteBootStatus`,
// `bootInfoFor`, `ensureBootStatus`). These helpers are the Thread-push
// view of it (`{instanceId, features[], version}`).

export interface BootStatus {
  /** Per-PROCESS daemon id: a restart mints a new one. */
  instanceId: string | null;
  /** Feature keys the version string cannot tell apart. Older daemons
   *  omit the list; every key then reads as unsupported. */
  features: string[];
  version: string | null;
}

/** K2 0.45.5: Thread push prefs routes, trigger and payload are live. */
export const FEATURE_THREAD_PUSH = "thread-push-v1";
const BOOT_STATUS_TTL_MS = 60_000;

export function parseBootStatus(raw: unknown): BootStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const features = Array.isArray(o.features)
    ? o.features.filter((f): f is string => typeof f === "string")
    : [];
  return {
    instanceId: typeof o.instanceId === "string" && o.instanceId ? o.instanceId : null,
    features,
    version: typeof o.version === "string" ? o.version : null,
  };
}

function bootStatusOf(info: BootInfo | null): BootStatus | null {
  if (!info) return null;
  return {
    instanceId: info.instanceId,
    features: info.features ? [...info.features] : [],
    version: info.version,
  };
}

/** `GET /boot-status` for one server. Answers from the scope's memory when
 *  it is under a minute old; `fresh` always reads the wire (a push tap
 *  compares `instanceId`, which changes on every daemon restart) and is
 *  null when that read fails — never a stale answer. Never throws. */
export async function getBootStatus(
  scope: ServerScope,
  opts: { fresh?: boolean } = {}
): Promise<BootStatus | null> {
  if (!scope.id) return null;
  try {
    if (opts.fresh) {
      const body = await readBootStatus(scope);
      if (body === null) return null;
      return bootStatusOf(noteBootStatus(scope.id, body));
    }
    return bootStatusOf(await ensureBootStatus(scope, BOOT_STATUS_TTL_MS));
  } catch {
    return null;
  }
}

/** True when that server's `/boot-status` lists `key`. False when the
 *  server is unreachable or predates the feature list. */
export async function serverHasFeature(scope: ServerScope, key: string): Promise<boolean> {
  const b = await getBootStatus(scope);
  return !!b && b.features.includes(key);
}

// ─── Thread push prefs (K2 0.45.5, `thread-push-v1`) ───

export type NotifyPush = "ready" | "dormant" | "airgap";
export type NotifySource = "user" | "default" | "fallback";

export interface NotifyWorkspacePref {
  projectId: string;
  name: string;
  handle: string | null;
  threadPush: boolean;
  source: NotifySource;
  updatedBy?: string;
  updatedAt?: number;
}

export interface NotifyPrefs {
  principal: string;
  server: { enabled: boolean; source: NotifySource };
  default: boolean;
  devices: number;
  push: NotifyPush;
  workspaces: NotifyWorkspacePref[];
}

export type NotifyPrefsWrite = {
  server?: { enabled: boolean };
  workspace?: { projectId: string; threadPush: boolean | null };
};

function asSource(v: unknown): NotifySource {
  return v === "user" || v === "default" || v === "fallback" ? v : "fallback";
}

/** Defensive parse of the GET/POST `/cli/notify/prefs` body. Null when
 *  the shape is unrecognised (no `server.enabled` boolean). */
export function parseNotifyPrefs(raw: unknown): NotifyPrefs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const server = o.server as Record<string, unknown> | undefined;
  if (!server || typeof server.enabled !== "boolean") return null;
  const push: NotifyPush =
    o.push === "dormant" || o.push === "airgap" || o.push === "ready" ? o.push : "ready";
  const workspaces: NotifyWorkspacePref[] = [];
  for (const w of Array.isArray(o.workspaces) ? o.workspaces : []) {
    if (!w || typeof w !== "object") continue;
    const r = w as Record<string, unknown>;
    if (typeof r.projectId !== "string" || !r.projectId) continue;
    workspaces.push({
      projectId: r.projectId,
      name: typeof r.name === "string" ? r.name : "",
      handle: typeof r.handle === "string" && r.handle ? r.handle : null,
      threadPush: r.threadPush !== false,
      source: asSource(r.source),
      ...(typeof r.updatedBy === "string" && r.updatedBy ? { updatedBy: r.updatedBy } : {}),
      ...(typeof r.updatedAt === "number" ? { updatedAt: r.updatedAt } : {}),
    });
  }
  return {
    principal: typeof o.principal === "string" ? o.principal : "",
    server: { enabled: server.enabled, source: asSource(server.source) },
    default: o.default !== false,
    devices: typeof o.devices === "number" ? o.devices : 0,
    push,
    workspaces,
  };
}

/** `GET /cli/notify/prefs` (Member): the caller's own prefs on `scope`. */
export const getNotifyPrefs = (scope: ServerScope) =>
  httpRequest<unknown>(scope, "/cli/notify/prefs");

/** `POST /cli/notify/prefs`: `{server:{enabled}}` and/or
 *  `{workspace:{projectId, threadPush}}` (`null` = back to the default).
 *  Answers with the same body as the GET. */
export const setNotifyPrefs = (scope: ServerScope, body: NotifyPrefsWrite) =>
  httpRequest<unknown>(scope, "/cli/notify/prefs", {
    method: "POST",
    body: JSON.stringify(body),
  });
