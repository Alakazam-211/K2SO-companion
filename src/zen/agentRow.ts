import { posixNormalize } from "./workspacePath";
import { workspaceColorOf, workspaceIconOf } from "./workspaceSwatch";

/**
 * Live GET /cli/skin/agents (guest read-a, 8793, 2026-09-29):
 *   { agents: [{ displayName, handle, projectId }] }
 * Addr and fs workspace are `handle`. Name is `displayName`.
 * `roomHandle` is not sent — do not read it.
 * `projectId` is present; files still use handle (skin does).
 * Rows without a handle are dropped. Unrecognised shape is an error.
 */
export type SkinAgentRow = {
  handle?: string;
  displayName?: string;
  projectId?: string;
};

export function skinRoomOf(
  a: SkinAgentRow
): { handle: string; name: string } | null {
  const handle = typeof a.handle === "string" ? a.handle.trim() : "";
  if (!handle) return null;
  const name =
    (typeof a.displayName === "string" && a.displayName.trim()) || handle;
  return { handle, name };
}

export function skinInitials(name: string): string {
  const parts = String(name).trim().split(/[\s\-_]+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

/** Live 200 is `{agents:[]}`. A bare array or any other shape is an error. */
export function parseSkinAgents(data: unknown): SkinAgentRow[] | null {
  if (Array.isArray(data)) return null;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { agents?: unknown }).agents)
  ) {
    return (data as { agents: SkinAgentRow[] }).agents;
  }
  return null;
}

/** Live GET /cli/agent/list (singular; loopback 60753, 2026-09-29):
 *   { ok: true, agents: [{ enabled, live, mode, name, path }] }
 * `k2 agent list` calls this route. `/cli/agents/list` (plural) is skills.
 * No handle/addr on the wire — do not invent one from name. */
export type OwnerAgentRow = {
  enabled?: unknown;
  live?: unknown;
  mode?: unknown;
  name?: unknown;
  path?: unknown;
  handle?: unknown;
  addr?: unknown;
};

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1") return true;
  if (v === 0 || v === "0") return false;
  return null;
}

export function ownerAgentOf(
  a: OwnerAgentRow
): {
  id: string;
  name: string;
  path: string;
  addr: string | null;
  mode: string | null;
  enabled: boolean | null;
  live: boolean | null;
} | null {
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) return null;
  const path = typeof a.path === "string" ? a.path : "";
  const handle = typeof a.handle === "string" ? a.handle.trim() : "";
  const addrField = typeof a.addr === "string" ? a.addr.trim() : "";
  const addr = handle || addrField || null;
  const mode = typeof a.mode === "string" ? a.mode.trim() : "";
  return {
    id: name,
    name,
    path,
    addr,
    mode: mode || null,
    enabled: asBool(a.enabled),
    live: asBool(a.live),
  };
}

/** Live GET /cli/projects/list (loopback 60753, 2026-09-30):
 *   bare JSON array of project rows. handle + path populated 61/61.
 *   `/cli/companion/projects-summary` is a different route (name+path only).
 *   A `{ok, agents}` object is `/cli/agent/list` — reject.
 *   A bare array of skill rows (no handle+path) is `/cli/agents/list` — reject. */
export type CliProjectRow = {
  name?: unknown;
  handle?: unknown;
  path?: unknown;
  color?: unknown;
  iconUrl?: unknown;
};

export function parseCliProjects(data: unknown): CliProjectRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows: CliProjectRow[] = [];
  for (const item of data) {
    if (item && typeof item === "object") rows.push(item as CliProjectRow);
  }
  if (data.length > 0 && rows.length === 0) return null;
  if (
    rows.length > 0 &&
    !rows.some(
      (r) => typeof r.handle === "string" && typeof r.path === "string"
    )
  ) {
    return null;
  }
  return rows;
}

export function cliProjectOf(
  a: CliProjectRow
): {
  name: string;
  path: string;
  handle: string | null;
  color: string | null;
  iconUrl: string | null;
} | null {
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) return null;
  const path = typeof a.path === "string" ? a.path : "";
  const handle = typeof a.handle === "string" ? a.handle.trim() : "";
  return {
    name,
    path,
    handle: handle || null,
    color: workspaceColorOf(a.color),
    iconUrl: workspaceIconOf(a.iconUrl),
  };
}

export const JOIN_NO_PROJECT =
  "No thread handle — this path is missing from /cli/projects/list";
export const JOIN_NO_AGENT = "No agent list row for this path";
export const JOIN_NO_HANDLE = "Project row has no handle";
export const JOIN_NO_PATH = "No usable path to join";
export const JOIN_DUP_PATH = "Multiple project rows share this path";

export type FleetNamePath = {
  name: string;
  path: string;
  mode?: string | null;
  enabled?: boolean | null;
  live?: boolean | null;
};
export type ProjectHandlePath = {
  name: string;
  path: string;
  handle: string | null;
  color?: string | null;
  iconUrl?: string | null;
};
export type JoinedOverlayRow = {
  id: string;
  name: string;
  path: string;
  addr: string | null;
  joinMiss: string | null;
  mode: string | null;
  enabled: boolean | null;
  live: boolean | null;
  /** Line-two sidecar title from the server. Null on a main chat. */
  chatTitle: string | null;
  color: string | null;
  iconUrl: string | null;
};

function fromAgent(
  a: FleetNamePath,
  rest: Omit<JoinedOverlayRow, "name" | "mode" | "enabled" | "live" | "color" | "iconUrl"> & {
    color?: string | null;
    iconUrl?: string | null;
  }
): JoinedOverlayRow {
  return {
    name: a.name,
    mode: a.mode ?? null,
    enabled: a.enabled ?? null,
    live: a.live ?? null,
    ...rest,
    chatTitle: rest.chatTitle ?? null,
    color: rest.color ?? null,
    iconUrl: rest.iconUrl ?? null,
  };
}

function isSlashHandle(handle: string): boolean {
  return handle.includes("/");
}

function sidecarTitle(handle: string, projectName: string, fleetName: string): string {
  const suffix = handle.split("/").slice(1).join("/");
  const pn = projectName.trim();
  if (pn && pn !== fleetName && pn !== handle) return pn;
  return suffix || handle;
}

/** A sidecar row's local id: `<path>#<handle>`. Never `::` — that is the
 *  address separator (`handle::hostKey`, multi-server MA8). */
export function sidecarRowId(path: string, handle: string): string {
  return `${path}#${handle}`;
}

function sidecarFromProject(
  a: FleetNamePath,
  path: string,
  project: ProjectHandlePath
): JoinedOverlayRow {
  const handle = (project.handle ?? "").trim();
  return fromAgent(a, {
    id: sidecarRowId(path, handle),
    path,
    addr: handle,
    joinMiss: null,
    chatTitle: sidecarTitle(handle, project.name, a.name),
    color: project.color ?? null,
    iconUrl: project.iconUrl ?? null,
  });
}

function pathKey(path: string): string | null {
  return posixNormalize(path.trim());
}

/**
 * Overlay rows = union of `/cli/agent/list` and `/cli/projects/list`, joined
 * on absolute `path`. Never on `name`. Chattable only when both sides share
 * that path and the project row sent a non-empty handle. A miss stays visible
 * and not chattable, with a reason — never a silent drop, never a guessed handle.
 */
export function joinAgentsWithProjects(
  agents: FleetNamePath[],
  projects: ProjectHandlePath[]
): JoinedOverlayRow[] {
  const projectsByPath = new Map<string, ProjectHandlePath[]>();
  for (const p of projects) {
    const key = pathKey(p.path);
    if (!key) continue;
    const list = projectsByPath.get(key);
    if (list) list.push(p);
    else projectsByPath.set(key, [p]);
  }
  const usedPaths = new Set<string>();
  const out: JoinedOverlayRow[] = [];

  for (const a of agents) {
    const key = pathKey(a.path);
    if (!key) {
      out.push(
        fromAgent(a, {
          id: `agent:${a.name}`,
          path: a.path,
          addr: null,
          joinMiss: JOIN_NO_PATH,
          chatTitle: null,
        })
      );
      continue;
    }
    usedPaths.add(key);
    const matches = projectsByPath.get(key) ?? [];
    if (matches.length === 0) {
      out.push(
        fromAgent(a, {
          id: key,
          path: key,
          addr: null,
          joinMiss: JOIN_NO_PROJECT,
          chatTitle: null,
        })
      );
      continue;
    }
    const mains = matches.filter((p) => !isSlashHandle((p.handle ?? "").trim()));
    const sides = matches.filter((p) => isSlashHandle((p.handle ?? "").trim()));
    if (mains.length > 1) {
      out.push(
        fromAgent(a, {
          id: key,
          path: key,
          addr: null,
          joinMiss: JOIN_DUP_PATH,
          chatTitle: null,
        })
      );
      continue;
    }
    if (mains.length === 1) {
      const handle = (mains[0].handle ?? "").trim();
      if (!handle) {
        out.push(
          fromAgent(a, {
            id: key,
            path: key,
            addr: null,
            joinMiss: JOIN_NO_HANDLE,
            chatTitle: null,
          })
        );
      } else {
        out.push(
          fromAgent(a, {
            id: key,
            path: key,
            addr: handle,
            joinMiss: null,
            chatTitle: null,
            color: mains[0].color ?? null,
            iconUrl: mains[0].iconUrl ?? null,
          })
        );
      }
      for (const side of sides) {
        const h = (side.handle ?? "").trim();
        if (h) {
          out.push(
            sidecarFromProject(a, key, {
              ...side,
              color: side.color || mains[0]?.color || null,
              iconUrl: side.iconUrl || mains[0]?.iconUrl || null,
            })
          );
        }
      }
      continue;
    }
    if (sides.length > 0) {
      for (const side of sides) {
        const h = (side.handle ?? "").trim();
        if (h) out.push(sidecarFromProject(a, key, side));
      }
      continue;
    }
    out.push(
      fromAgent(a, {
        id: key,
        path: key,
        addr: null,
        joinMiss: JOIN_NO_HANDLE,
        chatTitle: null,
      })
    );
  }

  for (const p of projects) {
    const key = pathKey(p.path);
    if (!key) {
      out.push({
        id: `project:${p.name}`,
        name: p.name,
        path: p.path,
        addr: null,
        joinMiss: JOIN_NO_PATH,
        mode: null,
        enabled: null,
        live: null,
        chatTitle: null,
        color: p.color ?? null,
        iconUrl: p.iconUrl ?? null,
      });
      continue;
    }
    if (usedPaths.has(key)) continue;
    usedPaths.add(key);
    out.push({
      id: key,
      name: p.name,
      path: key,
      addr: null,
      joinMiss: JOIN_NO_AGENT,
      mode: null,
      enabled: null,
      live: null,
      chatTitle: null,
      color: p.color ?? null,
      iconUrl: p.iconUrl ?? null,
    });
  }
  return out;
}

/** Live 200 is `{ok, agents:[]}`. A bare array is the skills enumerator — error. */
export function parseOwnerAgents(data: unknown): OwnerAgentRow[] | null {
  if (Array.isArray(data)) return null;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { agents?: unknown }).agents)
  ) {
    return (data as { agents: OwnerAgentRow[] }).agents;
  }
  return null;
}
