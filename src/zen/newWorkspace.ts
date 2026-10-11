// New Workspace sheet (Agents `+`): pure helpers.
//
// Route: `POST /cli/workspace/create {path}` (K2 `workspace_routes.rs`,
// `route_policy.rs`: Member). It makes the folder (400 "Directory already
// exists" when it is there), registers it with display name = folder
// basename, mints a handle, and seeds the wiki + AGENTS.md (desktop's
// defaults). The daemon checks no name and no location jail, so the phone
// validates the slug and the parent before it sends.

import { posixNormalize } from "./workspacePath";

/** Folder name for a workspace name. Twin of desktop `slugifyAddressToken`
 *  (`src/renderer/lib/federation.ts`) and daemon `slugify_address_token`,
 *  so the folder, display name and minted handle all agree. `null` when
 *  the name has a separator / control char or no letters or digits. */
export function slugifyWorkspaceName(name: string): string | null {
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (ch === "/" || ch === ":" || ch === "\\" || ch === "\0" || code < 32) return null;
  }
  let slug = name.trim().toLowerCase().replace(/_/g, "-");
  slug = slug.split(/\s+/).filter(Boolean).join("-");
  slug = slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
  slug = slug.replace(/[^a-z0-9-]/g, "");
  slug = slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return null;
  return slug;
}

function parentOf(path: string): string | null {
  const norm = posixNormalize(path);
  if (!norm) return null;
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "/" : norm.slice(0, i);
}

/** Where a new workspace goes. K2 has no workspaces-root setting; desktop's
 *  remote folder picker starts at the host `home` (`GET /cli/fs/info`).
 *  The phone prefers the folder most existing workspaces share (ties: the
 *  first seen), then `home`. `null` when neither is known. */
export function defaultParentDir(
  workspacePaths: (string | null | undefined)[],
  home?: string | null
): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  for (const p of workspacePaths) {
    if (!p) continue;
    const parent = parentOf(p);
    if (!parent || parent === "/") continue;
    const n = (counts.get(parent) ?? 0) + 1;
    counts.set(parent, n);
    if (!best || n > (counts.get(best) ?? 0)) best = parent;
  }
  if (best) return best;
  const h = posixNormalize((home || "").trim());
  return h || null;
}

/** `<parent>/<slug>`, or `null` when the parent is not an absolute
 *  POSIX path (the daemon would resolve a relative one against its cwd). */
export function workspacePathFor(parent: string, slug: string | null): string | null {
  const raw = parent.trim();
  if (!slug || !raw.startsWith("/")) return null;
  if (raw.split("/").some((part) => part === "..")) return null;
  const norm = posixNormalize(raw);
  if (!norm) return null;
  return `${norm}/${slug}`;
}

/** Client-side check before `POST /cli/workspace/create`. */
export function newWorkspaceProblem(
  name: string,
  parent: string,
  existingPaths: (string | null | undefined)[]
): string | null {
  if (!name.trim()) return "Enter a name";
  const slug = slugifyWorkspaceName(name);
  if (!slug) return "Use letters or numbers (no / or :)";
  const path = workspacePathFor(parent, slug);
  if (!path) return "Location must be a full path, like /Users/you/Projects";
  if (existingPaths.some((p) => p && posixNormalize(p) === path)) {
    return `A workspace already uses ${path}`;
  }
  return null;
}

/** Inline error for a refused create. Daemon errors are `400 {error}`;
 *  a login below the route's role gets `403 {error:"role_required"}`. */
export function createErrorText(error: string | undefined, status?: number): string {
  const e = (error || "").trim();
  if (e === "role_required" || (status === 403 && /role/i.test(e))) {
    return "Your account can’t create workspaces on this server.";
  }
  if (/^Directory already exists/i.test(e)) return "That folder already exists. Pick another name.";
  if (/workspace already exists/i.test(e)) return "That folder is already a workspace.";
  return e || "Could not create the workspace";
}

/** Daemon role order (`connect_users.rs`): member < admin < owner. */
const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };

/** `POST /cli/workspace/create` is Member in `route_policy.rs`. */
export const WORKSPACE_CREATE_ROLE = "member";

/** Can this whoami create workspaces? Unknown (whoami not in yet, or an
 *  older daemon without `role`) is allowed: the daemon has the last word
 *  and its refusal shows inline. A known role below `required` is not. */
export function canCreateWorkspace(
  identity: { owner?: boolean; role?: string | null } | null,
  required: string = WORKSPACE_CREATE_ROLE
): boolean {
  if (!identity) return true;
  if (identity.owner) return true;
  const role = (identity.role || "").trim().toLowerCase();
  if (!role) return true;
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[required] ?? 0);
}

/** The note under a disabled `+`. */
export function createRoleNote(required: string = WORKSPACE_CREATE_ROLE): string {
  if (required === "owner") return "Only the server owner can create workspaces";
  if (required === "admin") return "Only server admins can create workspaces";
  return "Your account can’t create workspaces on this server";
}

/** Workspace colours offered on the sheet. First is the daemon default
 *  (`register_workspace_ex` stamps `#3b82f6`). */
export const WORKSPACE_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
] as const;
