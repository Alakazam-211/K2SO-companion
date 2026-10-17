// Rows from saved servers OTHER than the active one (multi-server S2,
// MS15/MS16/MS19/MS39). The active server's rows stay in `zenStore`
// exactly as today; this store holds one slice per other server, built by
// the same `buildServerRows` from that server's own four list reads, on
// that server's scope (never the active one).
//
// Each slice also carries that server's pins (`projects.pinned` →
// `pinnedIds`), its focus state (MA18: focus is per server — the active
// server's lives in `zenStore.focus`, every other server's here; see
// `focusForServer`), its hidden extras, and — for at most one remote
// server, the filter's (Q7 / MA13) — a 5 s activity snapshot.
//
// A slow or failing server never blocks the others (MS39): each loads on
// its own, keeps its last good rows on a failure, and records when its
// load started for the "Loading {server}…" line.

import { create } from "zustand";
import {
  getActivitySnapshot,
  getAgentList,
  getAllSessions,
  getAppSettings,
  getCliProjectsList,
  getFocusGroupsList,
} from "../../api/client";
import { fetchProjectGroups } from "../../api/projectGroups";
import { scopeFor, type ServerScope } from "../../api/scope";
import { onServerForget } from "../../stores/servers";
import {
  EMPTY_ACTIVITY,
  NO_CHAT_SESSIONS,
  parseActivitySnapshot,
  sameActivity,
  type ActivitySnapshot,
  type ChatSessions,
} from "../agentActivity";
import { readHiddenSidecarAddrs } from "../overlayExtras";
import {
  FOCUS_OFF,
  derivePinnedIds,
  focusGroupsOf,
  focusSettingsOf,
  readStoredFocusGroup,
  resolveFocus,
  writeStoredFocusGroup,
  type FocusState,
  type ServerProject,
} from "../serverPins";
import { buildServerRows } from "../serverRows";
import { queueServerAvatars } from "../../lib/avatarCache";
import { readRememberedSidecars, writeRememberedSidecars } from "../sidecarRows";
import type { StubAgent } from "../stubData";

/** A slice older than this is re-read on the next good pool check. */
export const ROWS_MAX_AGE_MS = 60_000;
/** "Loading {server}…" shows only after a load has run this long (MS39). */
export const LOADING_LINE_AFTER_MS = 2_000;
/** At most this many servers read their lists at once (HM5, desktop
 *  `LISTING_CONCURRENCY`): the pool loop and the Add Agent picker share
 *  it, so opening the picker over many servers never fans out past 4. */
export const MAX_SERVER_LOADS = 4;

/** Why a server's lists could not be read (no rows yet), for the Add
 *  Agent picker's section states: 401 → sign in, 403 → no access, no
 *  HTTP answer → offline, every read fine but nothing listed → empty,
 *  anything else → failed. */
export type RowsErrorKind = "offline" | "signin" | "no-access" | "empty" | "failed";

export interface RemoteRows {
  status: "loading" | "live" | "error";
  agents: StubAgent[];
  serverProjects: ServerProject[];
  pinnedIds: string[];
  chatSessions: ChatSessions;
  focus: FocusState;
  hiddenAddrs: string[];
  /** 5 s snapshot (Q7): only for the filter's server, else empty. */
  activity: ActivitySnapshot;
  error: string | null;
  /** Set with `error` (desktop `listingForError`). */
  errorKind: RowsErrorKind | null;
  notices: string[];
  /** Set while a load is in flight. */
  loadStartedAt: number | null;
  loadedAt: number | null;
}

export function emptyRemoteRows(): RemoteRows {
  return {
    status: "loading",
    agents: [],
    serverProjects: [],
    pinnedIds: [],
    chatSessions: NO_CHAT_SESSIONS,
    focus: FOCUS_OFF,
    hiddenAddrs: [],
    activity: EMPTY_ACTIVITY,
    error: null,
    errorKind: null,
    notices: [],
    loadStartedAt: null,
    loadedAt: null,
  };
}

type RemoteRowsState = { byServer: Record<string, RemoteRows> };

export const useRemoteRows = create<RemoteRowsState>(() => ({ byServer: {} }));

const loading = new Map<string, Promise<void>>();
let loadsRunning = 0;
const loadWaiters: (() => void)[] = [];

/** Wait for one of the `MAX_SERVER_LOADS` slots; call the result to free it. */
async function loadSlot(): Promise<() => void> {
  if (loadsRunning >= MAX_SERVER_LOADS) await new Promise<void>((r) => loadWaiters.push(r));
  loadsRunning += 1;
  let freed = false;
  return () => {
    if (freed) return;
    freed = true;
    loadsRunning -= 1;
    loadWaiters.shift()?.();
  };
}

/** Servers reading their lists right now (tests). */
export function serverLoadsRunning(): number {
  return loadsRunning;
}

/** What a failed load means (desktop `listingForError`). A 401 on any
 *  read → sign in; 403 → no access (a `password_change_required` 403 is
 *  a live login that needs a new password: sign in); no HTTP status on
 *  every read → offline; every read answered but nothing listed → empty;
 *  else failed. */
export function rowsErrorKind(results: { ok: boolean; status?: number; error?: string }[]): RowsErrorKind {
  const bad = results.filter((r) => !r.ok);
  if (bad.length === 0) return "empty";
  if (bad.some((r) => r.status === 401)) return "signin";
  if (bad.some((r) => r.status === 403 && /password_change_required/i.test(r.error || ""))) return "signin";
  if (bad.some((r) => r.status === 403)) return "no-access";
  if (bad.length > 0 && bad.every((r) => r.status === undefined)) return "offline";
  return "failed";
}
const snapshotInflight = new Set<string>();
/** Bumped on forget: a load that started before is dropped. */
const gens = new Map<string, number>();

function patch(serverId: string, fn: (prev: RemoteRows) => RemoteRows): void {
  useRemoteRows.setState((s) => ({
    byServer: { ...s.byServer, [serverId]: fn(s.byServer[serverId] ?? emptyRemoteRows()) },
  }));
}

function errorText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e) return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

async function readFocus(scope: ServerScope): Promise<FocusState | null> {
  const rs = await getAppSettings(scope);
  if (!rs.ok) return rs.status === 404 ? FOCUS_OFF : null;
  const settings = focusSettingsOf(rs.data);
  if (!settings.enabled) return FOCUS_OFF;
  const rg = await getFocusGroupsList(scope);
  if (!rg.ok) return rg.status === 404 ? FOCUS_OFF : null;
  const groups = focusGroupsOf(rg.data);
  return groups ? resolveFocus(settings, groups, readStoredFocusGroup(scope.id)) : FOCUS_OFF;
}

/** Load one server's rows on ITS scope. Single-flight per server; a
 *  failure keeps the last good rows. Never touches the active server. */
export function loadServerRows(serverId: string, now: () => number = Date.now): Promise<void> {
  const running = loading.get(serverId);
  if (running) return running;
  const gen = gens.get(serverId) ?? 0;
  const scope = scopeFor(serverId);
  const p = (async () => {
    patch(serverId, (prev) => ({ ...prev, loadStartedAt: now() }));
    const release = await loadSlot();
    try {
      if ((gens.get(serverId) ?? 0) !== gen) return;
      const [rAgents, rProjects, rGroups, rSessions] = await Promise.all([
        getAgentList(scope),
        getCliProjectsList(scope),
        fetchProjectGroups(scope),
        getAllSessions(scope),
      ]);
      // Notification avatars for this server's workspaces (see avatarCache).
      if (rProjects.ok) queueServerAvatars(serverId, rProjects.data);
      if ((gens.get(serverId) ?? 0) !== gen) return;
      const built = buildServerRows({
        rAgents,
        rProjects,
        rGroups,
        rSessions,
        remembered: readRememberedSidecars(serverId),
      });
      if (!built.ok) {
        patch(serverId, (prev) => ({
          ...prev,
          status: prev.loadedAt ? prev.status : "error",
          error: built.error,
          errorKind: rowsErrorKind([rAgents, rProjects, rGroups, rSessions]),
          loadStartedAt: null,
        }));
        return;
      }
      writeRememberedSidecars(serverId, built.remember);
      let focus: FocusState | null = null;
      try {
        focus = await readFocus(scope);
      } catch {
        focus = null;
      }
      if ((gens.get(serverId) ?? 0) !== gen) return;
      patch(serverId, (prev) => ({
        ...prev,
        status: "live",
        agents: built.agents,
        serverProjects: built.serverProjects,
        pinnedIds: derivePinnedIds(built.agents, built.serverProjects),
        chatSessions: built.chatSessions,
        focus: focus ?? prev.focus,
        hiddenAddrs: readHiddenSidecarAddrs(serverId),
        error: null,
        errorKind: null,
        notices: built.notices,
        loadStartedAt: null,
        loadedAt: now(),
      }));
    } catch (e) {
      if ((gens.get(serverId) ?? 0) !== gen) return;
      patch(serverId, (prev) => ({
        ...prev,
        status: prev.loadedAt ? prev.status : "error",
        error: errorText(e, "Could not load this server"),
        errorKind: "failed",
        loadStartedAt: null,
      }));
    } finally {
      release();
    }
  })().finally(() => {
    if (loading.get(serverId) === p) loading.delete(serverId);
  });
  loading.set(serverId, p);
  return p;
}

/** Does this slice want a re-read? */
export function rowsStale(rows: RemoteRows | undefined, at: number): boolean {
  if (!rows || rows.loadedAt === null) return rows?.loadStartedAt == null;
  return rows.loadStartedAt === null && at - rows.loadedAt >= ROWS_MAX_AGE_MS;
}

/** The 5 s activity snapshot for a remote server (Q7). Only servers whose
 *  `/boot-status` lists `daemon-activity`; one read at a time. */
export async function refreshServerSnapshot(serverId: string): Promise<void> {
  const scope = scopeFor(serverId);
  if (!scope.supports("daemon-activity") || snapshotInflight.has(serverId)) return;
  snapshotInflight.add(serverId);
  try {
    const r = await getActivitySnapshot(scope);
    if (!r.ok) return;
    const next = parseActivitySnapshot(r.data);
    const prev = useRemoteRows.getState().byServer[serverId];
    if (prev && sameActivity(prev.activity, next)) return;
    patch(serverId, (p) => ({ ...p, activity: next }));
  } catch {
    /* keep what is on screen */
  } finally {
    snapshotInflight.delete(serverId);
  }
}

/** Drop a remote server's snapshot (it lost its 5 s slot). */
export function clearServerSnapshot(serverId: string): void {
  const prev = useRemoteRows.getState().byServer[serverId];
  if (prev && prev.activity !== EMPTY_ACTIVITY) patch(serverId, (p) => ({ ...p, activity: EMPTY_ACTIVITY }));
}

/** This device's focus-group pick for a remote server. */
export function selectRemoteFocusGroup(serverId: string, groupId: string): void {
  const prev = useRemoteRows.getState().byServer[serverId];
  if (!prev?.focus.enabled || !prev.focus.groups.some((g) => g.id === groupId)) return;
  writeStoredFocusGroup(serverId, groupId);
  patch(serverId, (p) => ({ ...p, focus: { ...p.focus, currentId: groupId } }));
}

export function forgetServerRows(serverId: string): void {
  gens.set(serverId, (gens.get(serverId) ?? 0) + 1);
  loading.delete(serverId);
  useRemoteRows.setState((s) => {
    if (!(serverId in s.byServer)) return s;
    const byServer = { ...s.byServer };
    delete byServer[serverId];
    return { byServer };
  });
}

onServerForget((id) => forgetServerRows(id));

/** Tests only. */
export function __resetRemoteRowsForTests(): void {
  loading.clear();
  loadsRunning = 0;
  loadWaiters.length = 0;
  snapshotInflight.clear();
  gens.clear();
  useRemoteRows.setState({ byServer: {} });
}
