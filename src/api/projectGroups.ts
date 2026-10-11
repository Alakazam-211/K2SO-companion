// Slice C2 — companion client for the daemon's `/cli/project-group/*`
// routes (+ the `/cli/fs/read-file` body fetch the HTML browser needs).
//
// Deliberately its OWN module (parallel slice C3 owns other client
// surface). Transport is the shared `scopedFetch` (MS5/MA4): every call
// takes the scope it talks to; revive + replay stay on that scope.
//
// Wire shapes mirror the desktop's `Projects/projects-api.ts` (verified
// against `crates/k2-daemon/src/project_group_routes.rs`):
//   GET  /cli/project-group/list                       → {ok, groups}
//   GET  /cli/project-group/show?group=                → group + members + dashboards (flat)
//   GET  /cli/project-group/messages?group=&after=&limit= → {ok, messages, truncated}
//   GET  /cli/project-group/icon?group=                → {ok, found, dataUrl}
//   GET  /cli/project-group/html-docs?group=           → {ok, docs}
//   POST /cli/project-group/msg {group, body}          → stored row + delivery outcome
//   GET  /cli/fs/read-file?path=                       → {content, path, name}
//     (misc_routes.rs GET chain → fs_routes::handle_read_file; text files
//      only, 10MB cap; auth = Authorization Bearer, same as other HTTP /cli)
//
// Project-group errors arrive as `{"ok":false,"error":{"code","hint"}}`
// (stable codes); plain routes use `{"error":"..."}`. Both are folded
// into the ApiResponse `error` string here.

import type { ApiResponse } from "./client";
import { NOT_CONNECTED, scopedFetch } from "./scopedFetch";
import type { ServerScope } from "./scope";

// ── Wire types (desktop projects-api.ts parity) ────────────────────────

/** One group row (`/cli/project-group/list`). */
export interface ProjectGroup {
  id: string;
  name: string;
  /** Workspace id of the PoC; null only while the group is memberless. */
  pocWorkspaceId: string | null;
  pinned: boolean;
  /** Canonical avatar background (`#rrggbb`); null = hashed palette. */
  color: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
}

/** A member row as `show` enriches it. name/path are null when the
 *  workspace has been unregistered since it was added. */
export interface ProjectGroupMemberInfo {
  workspaceId: string;
  name: string | null;
  path: string | null;
  agentName: string | null;
  createdAt: number;
}

/** The `show` wire shape: the group's fields flat + members. (Dashboards
 *  ride too; the mobile page doesn't render them.) */
export interface ProjectGroupShow extends ProjectGroup {
  members: ProjectGroupMemberInfo[];
}

export interface ProjectGroupMessage {
  id: string;
  groupId: string;
  author: string;
  body: string;
  /** Unix seconds. */
  createdAt: number;
}

/** One page of the chat stream, oldest-first. `truncated` = more rows
 *  matched than the effective limit allowed. */
export interface ProjectGroupMessagesPage {
  messages: ProjectGroupMessage[];
  truncated: boolean;
}

/** The `msg` POST response: the stored row + the delivery outcome — a
 *  delivery failure never fails the store, so this is always Ok-shaped. */
export interface PostedProjectGroupMessage {
  id: string;
  groupId: string;
  author: string;
  body: string;
  createdAt: number;
  delivered: boolean;
  deliveryReason: string | null;
  deliveredSessionId: string | null;
}

/** One pinned-HTML doc from `GET /cli/project-group/html-docs`. */
export interface ProjectGroupHtmlDoc {
  workspaceId: string;
  workspaceName: string | null;
  agentName: string | null;
  filePath: string;
  fileName: string;
}

export interface GroupIconResult {
  found: boolean;
  dataUrl: string | null;
}

/** `GET /cli/fs/read-file` response (k2-core FileContent). */
export interface FileContent {
  content: string;
  path: string;
  name: string;
}

// ── Request loop (client.ts httpRequest parity, module-local) ──────────

/** Fold a non-2xx body into a human-readable error: the project-group
 *  contract `{"ok":false,"error":{"code","hint"}}` surfaces its hint
 *  (code as fallback); plain `{"error":"..."}` surfaces as-is. */
function errorFromBody(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as {
      error?: string | { code?: string; hint?: string };
    };
    const e = j?.error;
    if (typeof e === "string" && e) return e;
    if (e && typeof e === "object") {
      return e.hint || e.code || `HTTP ${status}`;
    }
  } catch {
    /* non-JSON error body */
  }
  return `HTTP ${status}`;
}

async function pgRequest<T>(
  scope: ServerScope,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  } = {},
  timeoutMs = 15000
): Promise<ApiResponse<T>> {
  try {
    const out = await scopedFetch(scope, path, {
      method: options.method || "GET",
      query: options.params,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      timeoutMs,
    });
    if (!out.ok) {
      return { ok: false, error: errorFromBody(out.status, out.text), status: out.status };
    }
    return { ok: true, data: JSON.parse(out.text) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg === NOT_CONNECTED) return { ok: false, error: NOT_CONNECTED };
    return { ok: false, error: `Could not reach server: ${msg}` };
  }
}

// ── Endpoint wrappers ──────────────────────────────────────────────────

/** GET /cli/project-group/list — all groups, daemon-ordered
 *  (pinned-first, then sort_order, then name). */
export async function fetchProjectGroups(scope: ServerScope): Promise<ApiResponse<ProjectGroup[]>> {
  const r = await pgRequest<{ ok: boolean; groups: ProjectGroup[] }>(scope, "/cli/project-group/list"
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: r.data?.groups ?? [] };
}

/** GET /cli/project-group/show?group=<id|name|prefix>. */
export async function fetchProjectGroupShow(
  scope: ServerScope,
  group: string
): Promise<ApiResponse<ProjectGroupShow>> {
  return pgRequest<ProjectGroupShow>(scope, "/cli/project-group/show", {
    params: { group },
  });
}

/** GET /cli/project-group/messages — oldest-first. No `after` → the
 *  LATEST `limit` (default 20, max 500); `after` is strictly-greater
 *  unix seconds. Load-earlier = re-read the tail with a bigger limit
 *  (there is no `before` param). */
export async function fetchProjectGroupMessages(
  scope: ServerScope,
  group: string,
  opts: { after?: number; limit?: number } = {}
): Promise<ApiResponse<ProjectGroupMessagesPage>> {
  const params: Record<string, string> = { group };
  if (opts.after !== undefined) params.after = String(opts.after);
  if (opts.limit !== undefined) params.limit = String(opts.limit);
  const r = await pgRequest<{
    ok: boolean;
    messages: ProjectGroupMessage[];
    truncated: boolean;
  }>(scope, "/cli/project-group/messages", { params });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    data: {
      messages: r.data?.messages ?? [],
      truncated: r.data?.truncated ?? false,
    },
  };
}

/** POST /cli/project-group/msg {group, body} — post AS THE HUMAN OWNER
 *  (`author` omitted → the daemon defaults 'owner'). The daemon stores,
 *  emits `project-group:message-created`, then best-effort injects into
 *  the PoC's canonical session; the outcome rides the response. */
export async function postProjectGroupMessage(
  scope: ServerScope,
  group: string,
  body: string
): Promise<ApiResponse<PostedProjectGroupMessage>> {
  return pgRequest<PostedProjectGroupMessage>(scope, "/cli/project-group/msg", {
    method: "POST",
    body: { group, body },
  });
}

/** GET /cli/project-group/icon?group= — the icon dataUrl, deliberately
 *  outside list/show payloads. `found:false`/null = unset (initials). */
export async function fetchProjectGroupIcon(
  scope: ServerScope,
  group: string
): Promise<ApiResponse<GroupIconResult>> {
  const r = await pgRequest<{ ok: boolean; found: boolean; dataUrl: string | null }>(scope, "/cli/project-group/icon",
    { params: { group } }
  );
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    data: { found: r.data?.found ?? false, dataUrl: r.data?.dataUrl ?? null },
  };
}

/** GET /cli/project-group/html-docs?group= — pinned-HTML rows out of
 *  MEMBER workspaces' layouts, deduped per (workspace, path). Returns
 *  file PATHS — bodies ride `fetchFileContent`. */
export async function fetchProjectGroupHtmlDocs(
  scope: ServerScope,
  group: string
): Promise<ApiResponse<ProjectGroupHtmlDoc[]>> {
  const r = await pgRequest<{ ok: boolean; docs: ProjectGroupHtmlDoc[] }>(scope, "/cli/project-group/html-docs",
    { params: { group } }
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: r.data?.docs ?? [] };
}

/** GET /cli/project-group/resources?group= — the group's Workspace
 *  Resources: the union of its MEMBER workspaces' pinned files
 *  (`{ok, groupId, docs:[{workspaceId, workspaceName, agentName,
 *  filePath, fileName, missing?}]}`). A server without that route (404)
 *  falls back once to `html-docs`, its older alias with the same shape. */
export async function fetchProjectGroupResources(
  scope: ServerScope,
  group: string
): Promise<ApiResponse<{ docs?: unknown }>> {
  const r = await pgRequest<{ docs?: unknown }>(scope, "/cli/project-group/resources", {
    params: { group },
  });
  if (r.ok || r.status !== 404) return r;
  return pgRequest<{ docs?: unknown }>(scope, "/cli/project-group/html-docs", { params: { group } });
}

/** GET /cli/fs/read-file?path=<absolute path> → {content, path, name}.
 *  Daemon-side: text files only (binary refused), 10MB cap. The HTML
 *  browser feeds `content` into its sandboxed iframe. */
export async function fetchFileContent(
  scope: ServerScope,
  path: string
): Promise<ApiResponse<FileContent>> {
  return pgRequest<FileContent>(scope, "/cli/fs/read-file", { params: { path } });
}

/** Unread reconciliation (the desktop §4.4 idiom): a group is UNREAD
 *  when it has ≥1 message newer than the per-client last-seen cursor.
 *  One `messages?after=&limit=1` probe per group; a failed probe counts
 *  as read — the dot is advisory and must never error the list. */
export async function fetchUnreadGroupIds(
  scope: ServerScope,
  groups: Array<{ id: string }>,
  lastSeenFor: (groupId: string) => number
): Promise<string[]> {
  const flags = await Promise.all(
    groups.map(async (g) => {
      const r = await fetchProjectGroupMessages(scope, g.id, {
        after: lastSeenFor(g.id),
        limit: 1,
      });
      return r.ok && (r.data?.messages.length ?? 0) > 0 ? g.id : null;
    })
  );
  return flags.filter((id): id is string => id !== null);
}
