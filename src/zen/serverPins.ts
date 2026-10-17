import { isOverlayExtraAddr } from "./overlayExtras";
import { posixNormalize } from "./workspacePath";

// Server pins and focus groups (K2 `focus-groups-pinned-agents-for-the-phone`
// §3, no daemon change). Pins are per WORKSPACE on the server:
// `projects.pinned` (0|1) ordered by `projects.tab_order`, the same list the
// desktop sidebar's Pinned section shows. Focus groups: `settings/get`
// `focusGroupsEnabled` (literal `true` only) turns them on; names come from
// `focus-groups/list`, membership from each project's `focusGroupId`.
// Ungrouped workspaces show in every group. The CURRENT group is this
// device's own view: seeded from the server's `activeFocusGroupId`, then
// kept in localStorage per server. The phone never writes it back.

/** One `/cli/projects/list` row, reduced to what pins and groups need. */
export type ServerProject = {
  id: string;
  name: string;
  /** Normalised absolute path; null when the row has none. */
  path: string | null;
  handle: string | null;
  pinned: boolean;
  tabOrder: number;
  focusGroupId: string | null;
};

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function flag(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

/** `/cli/projects/list` (bare array; `pinned` is 0|1) or a
 *  `projects-summary` row (`pinned: bool`, `focusGroup: {id}`). Rows
 *  without an id are dropped: a pin write needs one. */
export function serverProjectsOf(data: unknown): ServerProject[] | null {
  if (!Array.isArray(data)) return null;
  const out: ServerProject[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = text(r.id);
    if (!id) continue;
    const rawPath = text(r.path);
    const order = r.tabOrder ?? r.tab_order;
    const group = r.focusGroup as { id?: unknown } | null | undefined;
    const focusGroupId =
      text(r.focusGroupId ?? r.focus_group_id) ||
      (group && typeof group === "object" ? text(group.id) : "");
    out.push({
      id,
      name: text(r.name),
      path: rawPath ? posixNormalize(rawPath) : null,
      handle: text(r.handle) || null,
      pinned: flag(r.pinned),
      tabOrder: typeof order === "number" && Number.isFinite(order) ? order : 0,
      focusGroupId: focusGroupId || null,
    });
  }
  return out;
}

/** Rows the pin and group helpers read. */
export type ScopedRow = {
  id: string;
  kind?: "agent" | "group";
  addr?: string | null;
  path?: string;
};

/** The single main (non-sidecar) project at a path; null when none or several. */
export function mainAtPath(path: string | undefined, projects: ServerProject[]): ServerProject | null {
  const key = path ? posixNormalize(path.trim()) : null;
  if (!key) return null;
  const mains = projects.filter((p) => p.path === key && !isOverlayExtraAddr(p.handle));
  return mains.length === 1 ? mains[0] : null;
}

/**
 * The workspace a row pins. Main-chat rows only: a sidecar / extra chat
 * (`isOverlayExtraAddr`) cannot be pinned on its own because pins are per
 * workspace, and a project-group row is not a workspace. Join on the
 * handle first, then on a single main project at the row's path.
 */
export function pinProjectIdForRow(
  row: ScopedRow | null | undefined,
  projects: ServerProject[]
): string | null {
  if (!row || row.kind === "group") return null;
  const addr = (row.addr || "").trim();
  if (isOverlayExtraAddr(addr)) return null;
  if (addr) {
    const hit = projects.find((p) => p.handle === addr);
    if (hit) return hit.id;
  }
  return mainAtPath(row.path, projects)?.id ?? null;
}

/** Pinned project ids in server order: `tabOrder`, then name. */
/** Rows in the server's project-list order: the order desktop's Agents
 *  view draws (`zen-data.ts` `workspaceRows`, Rosson 2026-10-17). Rows
 *  with no project keep their relative order after the rest. */
export function sortByProjectOrder<T>(
  rows: T[],
  projects: ServerProject[],
  rowOf: (row: T) => ScopedRow | null | undefined
): T[] {
  // `tabOrder` first (the sidebar's order; the daemon lists by it too),
  // then list position.
  const ranked = projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.tabOrder - b.p.tabOrder || a.i - b.i);
  const at = new Map(ranked.map(({ p }, i) => [p.id, i]));
  return rows
    .map((row, index) => {
      const id = pinProjectIdForRow(rowOf(row), projects);
      const pos = id != null ? at.get(id) : undefined;
      return { row, index, pos: pos ?? Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.pos - b.pos || a.index - b.index)
    .map((x) => x.row);
}

export function pinnedProjectOrder(projects: ServerProject[]): string[] {
  return projects
    .filter((p) => p.pinned)
    .sort((a, b) => a.tabOrder - b.tabOrder || a.name.localeCompare(b.name))
    .map((p) => p.id);
}

/** Row ids for the pin grid: main-chat rows whose workspace is pinned. */
export function derivePinnedIds(rows: ScopedRow[], projects: ServerProject[]): string[] {
  const rowByProject = new Map<string, string>();
  for (const r of rows) {
    const pid = pinProjectIdForRow(r, projects);
    if (pid && !rowByProject.has(pid)) rowByProject.set(pid, r.id);
  }
  return pinnedProjectOrder(projects)
    .map((pid) => rowByProject.get(pid))
    .filter((id): id is string => !!id);
}

/** Optimistic `projects/update {pinned}`. */
export function withPinned(
  projects: ServerProject[],
  projectId: string,
  pinned: boolean
): ServerProject[] {
  return projects.map((p) => (p.id === projectId ? { ...p, pinned } : p));
}

/** Optimistic `projects/reorder {ids}`: `tab_order = index`. */
export function withOrder(projects: ServerProject[], ids: string[]): ServerProject[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  return projects.map((p) => (at.has(p.id) ? { ...p, tabOrder: at.get(p.id)! } : p));
}

/** Optimistic `focus-groups/assign {projectId, focusGroupId}`. */
export function withFocusGroup(
  projects: ServerProject[],
  projectId: string,
  focusGroupId: string | null
): ServerProject[] {
  return projects.map((p) => (p.id === projectId ? { ...p, focusGroupId } : p));
}

// ─── Focus groups ───

export type FocusGroupLite = { id: string; name: string; color: string | null };

export type FocusState = {
  /** True only with `focusGroupsEnabled === true` and a current group. */
  enabled: boolean;
  currentId: string | null;
  groups: FocusGroupLite[];
};

export const FOCUS_OFF: FocusState = { enabled: false, currentId: null, groups: [] };

/** `/cli/settings/get`. Only a literal `true` turns groups on (desktop rule). */
export function focusSettingsOf(data: unknown): { enabled: boolean; activeId: string | null } {
  if (!data || typeof data !== "object") return { enabled: false, activeId: null };
  const d = data as { focusGroupsEnabled?: unknown; activeFocusGroupId?: unknown };
  return {
    enabled: d.focusGroupsEnabled === true,
    activeId: text(d.activeFocusGroupId) || null,
  };
}

/** `/cli/focus-groups/list`: a bare `FocusGroup[]` (also tolerates `{groups}`). */
export function focusGroupsOf(data: unknown): FocusGroupLite[] | null {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { groups?: unknown }).groups)
      ? ((data as { groups: unknown[] }).groups)
      : null;
  if (!list) return null;
  const rows: (FocusGroupLite & { order: number })[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = text(r.id);
    const name = text(r.name);
    if (!id || !name) continue;
    rows.push({
      id,
      name,
      color: text(r.color) || null,
      order: typeof r.tabOrder === "number" ? r.tabOrder : rows.length,
    });
  }
  return rows
    .sort((a, b) => a.order - b.order)
    .map(({ id, name, color }) => ({ id, name, color }));
}

/**
 * Current group is per VIEWER: the desktop never moves anyone else's view,
 * so neither does the phone. Order: this device's own pick (when that
 * group still exists), then the server's `activeFocusGroupId` (the seed),
 * then the first group by `tabOrder`. No groups, or groups off: off.
 */
export function resolveFocus(
  settings: { enabled: boolean; activeId: string | null },
  groups: FocusGroupLite[],
  storedId: string | null = null
): FocusState {
  if (!settings.enabled || groups.length === 0) return FOCUS_OFF;
  const current =
    groups.find((g) => g.id === storedId) ??
    groups.find((g) => g.id === settings.activeId) ??
    groups[0];
  return { enabled: true, currentId: current.id, groups };
}

/** Per-device, per-server pick. Never written to the server. */
export function focusGroupStorageKey(serverId: string): string {
  return `zen.focusGroup.${serverId}`;
}

export function readStoredFocusGroup(serverId: string | null): string | null {
  if (!serverId) return null;
  try {
    return (localStorage.getItem(focusGroupStorageKey(serverId)) || "").trim() || null;
  } catch {
    return null;
  }
}

export function writeStoredFocusGroup(serverId: string | null, groupId: string): void {
  if (!serverId || !groupId) return;
  try {
    localStorage.setItem(focusGroupStorageKey(serverId), groupId);
  } catch {
    /* private mode / quota: the pick lasts this session */
  }
}

export function currentFocusGroup(focus: FocusState): FocusGroupLite | null {
  if (!focus.enabled || !focus.currentId) return null;
  return focus.groups.find((g) => g.id === focus.currentId) ?? null;
}

/** The Chats header: the current group's name, else "Agents". */
export function listTitle(focus: FocusState): string {
  return currentFocusGroup(focus)?.name || "Agents";
}

/** A row's workspace group. Sidecars follow their parent workspace
 *  (handle prefix, then the main project at the same path). */
export function focusGroupIdForRow(row: ScopedRow, projects: ServerProject[]): string | null {
  if (row.kind === "group") return null;
  const addr = (row.addr || "").trim();
  const base = addr.split("/")[0];
  const byHandle = base ? projects.find((p) => p.handle === base) : null;
  const project = byHandle ?? mainAtPath(row.path, projects);
  return project?.focusGroupId ?? null;
}

/**
 * Desktop "Agents page order" rule (`zen-data.ts`): pinned rows always
 * show; with groups on, the rest are rows in the current group plus
 * ungrouped ones. Groups off: everything.
 */
export function filterByFocus<T extends ScopedRow>(
  rows: T[],
  focus: FocusState,
  projects: ServerProject[],
  pinnedIds: string[]
): T[] {
  const current = currentFocusGroup(focus);
  if (!current) return rows;
  const pinned = new Set(pinnedIds);
  return rows.filter((r) => {
    if (pinned.has(r.id)) return true;
    const gid = focusGroupIdForRow(r, projects);
    return gid === null || gid === current.id;
  });
}

/** `focus-groups/create` reply: one `FocusGroup` (also tolerates `{group}`). */
export function focusGroupOf(data: unknown): FocusGroupLite | null {
  const raw =
    data && typeof data === "object" && "group" in (data as object)
      ? (data as { group: unknown }).group
      : data;
  return focusGroupsOf([raw])?.[0] ?? null;
}

/** A row's own workspace group id, for main-chat rows that can change it
 *  (the same rows that pin). Null when ungrouped or not a workspace row. */
export function rowFocusGroupId(
  row: ScopedRow | null | undefined,
  projects: ServerProject[]
): string | null {
  const pid = pinProjectIdForRow(row, projects);
  return (pid && projects.find((p) => p.id === pid)?.focusGroupId) || null;
}
