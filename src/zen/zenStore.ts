import { create } from "zustand";
import {
  getAgentList,
  getAllSessions,
  getCliProjectsList,
  getFsReadFile,
  getActivitySnapshot,
  getAppSettings,
  getFocusGroupsList,
  assignFocusGroup as postAssignFocusGroup,
  createFocusGroup as postCreateFocusGroup,
  getThread,
  postThread,
  answerThread,
  reorderProjects,
  setProjectPinned,
  setSessionLabel,
  setTabTitle,
  spawnSidecarSession,
  spawnTabSession,
  getWorkspaceResources,
  type GlobalSession,
  type ThreadItem,
} from "../api/client";
import {
  fetchProjectGroupMessages,
  fetchProjectGroups,
  postProjectGroupMessage,
  type ProjectGroupMessage,
} from "../api/projectGroups";
import { ensureBootStatus, serverMemory, type ServerScope } from "../api/scope";
import { zenScope } from "./zenScope";
import { onServerForget } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  cliProjectOf,
  joinAgentsWithProjects,
  ownerAgentOf,
  parseCliProjects,
  parseOwnerAgents,
  sidecarRowId,
  skinInitials,
} from "./agentRow";
import { STUB_AGENTS, STUB_FILES, STUB_THREAD, STUB_THREAD_FALLBACK, type StubAgent, type StubFile } from "./stubData";
import { beginLastAt, fetchLastAtForKey, lastAtKey } from "./lastAtFetch";
import { clearLegacyPinStore, insertPinned } from "./pinChats";
import {
  FOCUS_OFF,
  derivePinnedIds,
  focusGroupOf,
  focusGroupsOf,
  focusSettingsOf,
  pinProjectIdForRow,
  pinnedProjectOrder,
  focusGroupStorageKey,
  readStoredFocusGroup,
  resolveFocus,
  serverProjectsOf,
  withFocusGroup,
  withOrder,
  withPinned,
  writeStoredFocusGroup,
  type FocusGroupLite,
  type FocusState,
  type ServerProject,
} from "./serverPins";
import { isSendableAddr } from "./sendGate";
import { terminalIdForAgent } from "./terminalJump";
import { resolveFileRef } from "./chatLinks";
import { getFileCategory, isBinaryPreviewCategory } from "./files/fileCategory";
import {
  extrasFromRemembered,
  mergeSidecarTitles,
  nextSidecarAddr,
  parseCompanionSessions,
  forgetRememberedSidecars,
  readRememberedSidecars,
  rememberSidecar,
  matchSidecarSession,
  sidecarLiveLabel,
  sidecarRenameTarget,
  sidecarSuffix,
  sidecarsFromSessions,
  writeRememberedSidecars,
  type OverlaySidecar,
} from "./sidecarRows";
import { isMine, isOwnerAuthored, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { mergeThreadMessages } from "./threadLive";
import {
  EMPTY_ACTIVITY,
  NO_CHAT_SESSIONS,
  chatSessionsOf,
  parseActivitySnapshot,
  sameActivity,
  type ActivitySnapshot,
  type ChatSessions,
} from "./agentActivity";
import {
  NO_WORKSPACE_PATH,
  PATH_NOT_OWNED,
  isUnderWorkspace,
  ownedWorkspacePath,
  usableFsPath,
} from "./workspacePath";
import { parseWorkspaceResources } from "./workspaceResources";
import {
  forgetHiddenSidecarAddrs,
  hideSidecarAddr,
  isOverlayExtraAddr,
  readHiddenSidecarAddrs,
  unhideSidecarAddr,
} from "./overlayExtras";
import { nextDrawerOrigin, readDrawerOrigin, writeDrawerOrigin } from "./sessionDrawer";
import { canSidecar, type ActiveLlm } from "./llmPresets";

/** `openSidecar` options. `launch` picks the harness (default Claude);
 *  `existingAddrs` adds server addrs the agents list may not hold (hidden
 *  sidecars, drawer rows) so `nextSidecarAddr` never reuses one;
 *  `fromDrawer` keeps the Sessions drawer's Done origin. */
export type OpenSidecarOpts = {
  launch?: { command: string; args: string[] };
  existingAddrs?: string[];
  fromDrawer?: boolean;
};

export type LlmSpawnResult =
  | { ok: true; kind: "chat"; addr: string }
  | { ok: true; kind: "terminal"; terminalId: string; title: string }
  | { ok: false; error: string };

export type DataSource = "stub" | "live" | "error" | "loading";

/** Signed-in empty list. Honest: 0 agents, and why. Do not invent a mapping. */
export const OWNER_LIST_HOLD =
  "No agents on this list. A fleet-sized owner list is not confirmed yet. /cli/skin/agents is grant-scoped. /cli/agents/list is the skills enumerator. This overlay does not invent a mapping.";

export function sourceWord(s: DataSource): "LIVE" | "STUB" | "ERROR" | "LOADING" {
  if (s === "live") return "LIVE";
  if (s === "error") return "ERROR";
  if (s === "loading") return "LOADING";
  return "STUB";
}

type ZenState = {
  agentSource: DataSource;
  fileSource: DataSource;
  agents: StubAgent[];
  files: StubFile[];
  agentError: string | null;
  fileError: string | null;
  /** Bumped at the start of every hydrateFiles; stale responses must not apply. */
  filesGen: number;
  threadSource: DataSource;
  threadError: string | null;
  thread: ThreadMessage[];
  threadGen: number;
  threadAddr: string | null;
  threadGroupId: string | null;
  threadConversationId: string | null;
  threadHasMore: boolean;
  threadOldestSeq: number | null;
  threadLoadingEarlier: boolean;
  sending: boolean;
  sendError: string | null;
  answeringId: string | null;
  answerError: string | null;
  answerErrorId: string | null;
  hydrateAgents: (opts?: { resumeId?: string }) => Promise<void>;
  /** Workspace Resources for `dir` (this agent's own path). `refresh`
   *  keeps a live list on screen while it re-reads. */
  hydrateFiles: (dir: string, opts?: { refresh?: boolean }) => Promise<void>;
  hydrateThread: (addr: string) => Promise<void>;
  hydrateGroup: (groupId: string) => Promise<void>;
  loadEarlier: () => Promise<void>;
  sendThread: (text: string) => Promise<void>;
  answerChoice: (messageId: string, option: string) => Promise<void>;
  ingestThreadRaw: (raw: ThreadItem) => void;
  refreshOpenThread: () => Promise<void>;
  /** Last-message unix seconds, keyed `t:<addr>` / `g:<groupId>`. Null = fetched empty. */
  lastAtByKey: Record<string, number | null>;
  ensureLastAt: (key: string) => void;
  /** Agent status for the Chats list (`GET /cli/activity/snapshot`). */
  activity: ActivitySnapshot;
  /** Main-chat vs other PTY ids, so a main row skips its sidecars' work. */
  chatSessions: ChatSessions;
  refreshActivity: () => Promise<void>;
  /** Workspace rows from `/cli/projects/list`: pins, order, focus group. */
  serverProjects: ServerProject[];
  /** Pin grid row ids, derived from `serverProjects` (never stored locally). */
  pinnedIds: string[];
  /** Last pin write that failed and was rolled back. Clears itself. */
  pinError: string | null;
  /** Server pin: `POST /cli/projects/update {pinned:1}` (+ reorder when
   *  dropped at a spot in the grid). Sidecar and group rows are refused. */
  pinChat: (id: string, beforeId?: string | null) => Promise<void>;
  /** `POST /cli/projects/reorder` with the pinned ids only. */
  movePin: (id: string, beforeId: string | null) => Promise<void>;
  unpinChat: (id: string) => Promise<void>;
  /** Re-read `/cli/projects/list` for pins and group membership. */
  refreshPins: () => Promise<void>;
  /** Focus groups: on/off from `settings/get`, names from `focus-groups/list`. */
  focus: FocusState;
  refreshFocus: () => Promise<void>;
  /** `settings/get` `focusGroupsEnabled`, even with no groups yet. */
  focusGroupsEnabled: boolean;
  /** This device's view only. Never written to the server. */
  selectFocusGroup: (groupId: string) => void;
  /** Server-wide `focus-groups/assign` for a main-chat row's workspace
   *  (`null` ungroups). Optimistic; rolls back with `pinError` on failure.
   *  Resolves true when the server took it. */
  assignFocusGroup: (id: string, groupId: string | null) => Promise<boolean>;
  /** `focus-groups/create {name}`, then assign the row to it. */
  createFocusGroupFor: (id: string, name: string) => Promise<boolean>;
  refreshServerLists: () => void;
  dismissFiles: () => void;
  /** Overlay home is the chats list. A row opens the thread. */
  screen: "list" | "thread";
  agentId: string;
  filesOpen: boolean;
  openFileIds: string[];
  focusId: string | null;
  /** Where the viewer returns on its last close: the Files list or the chat. */
  fileReturn: "files" | "chat";
  setAgent: (id: string) => void;
  /** Spawn the sidecar PTY if the Mac tab is gone. Overlay chat stays. */
  ensureSidecarHost: (
    row: Pick<StubAgent, "path" | "addr" | "chatTitle" | "terminalId" | "launch">
  ) => Promise<{ ok: boolean; terminalId?: string | null; error?: string }>;
  openSidecar: (
    baseId: string,
    opts?: OpenSidecarOpts
  ) => Promise<{ ok: boolean; error?: string; addr?: string }>;
  /** Sessions drawer `+`: start `llm` in the open chat's workspace. A
   *  sidecar-capable harness becomes the next `agent/N` chat (Done mode);
   *  any other preset runs as a plain tab the caller opens as a terminal. */
  spawnLlmSession: (
    baseId: string,
    llm: ActiveLlm,
    existingAddrs?: string[]
  ) => Promise<LlmSpawnResult>;
  renameSidecarTitle: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>;
  hideSidecarChat: (id: string) => void;
  hiddenSidecarAddrs: string[];
  /** Chat the Sessions drawer was first used from; Done returns there.
   *  Null when the open chat was not picked from the drawer. */
  drawerOrigin: string | null;
  /** Switch the open chat to another session in this workspace (Sessions
   *  drawer). `side` builds the row when the list does not have it yet. */
  openWorkspaceSession: (target: {
    addr: string;
    path: string;
    side?: OverlaySidecar;
  }) => void;
  /** Done in a drawer-picked chat: back to the chat the drawer was opened from. */
  returnToDrawerOrigin: () => void;
  closeChat: () => void;
  toggleFiles: () => void;
  openFile: (id: string) => void;
  /** Open a path mentioned in chat the same way as a file-tree tap. */
  openFileFromPath: (ref: string) => void;
  closeFile: (id: string) => void;
  focusFile: (id: string) => void;
};

function failFiles(
  message: string,
  keep: StubFile[] = []
): Pick<ZenState, "fileSource" | "files" | "fileError"> {
  return { fileSource: "error", files: keep, fileError: message };
}

/** Live and empty: the pane shows the "No Workspace Resources yet" note. */
function noResources(keep: StubFile[] = []): Pick<ZenState, "fileSource" | "files" | "fileError"> {
  return { fileSource: "live", files: keep, fileError: null };
}

/** Files that are open in a tab survive a resources re-read: an open
 *  file the new list dropped stays as a chat-link file. */
function keepOpenFiles(s: Pick<ZenState, "files" | "openFileIds">): StubFile[] {
  return s.files
    .filter((f) => s.openFileIds.includes(f.id))
    .map((f) => ({ ...f, linked: true }));
}

/** New resource rows plus open tabs. Reuse a read already done. */
function mergeResources(
  rows: StubFile[],
  s: Pick<ZenState, "files" | "openFileIds">
): StubFile[] {
  const prev = new Map(s.files.map((f) => [f.id, f]));
  const listed = rows.map((r) => {
    const p = prev.get(r.id);
    if (p?.loaded) {
      return { ...r, body: p.body, loaded: true, fsPath: p.fsPath, readError: p.readError };
    }
    return p?.body ? { ...r, body: p.body } : r;
  });
  const ids = new Set(listed.map((f) => f.id));
  return [...listed, ...keepOpenFiles(s).filter((f) => !ids.has(f.id))];
}

function overlaySidecarAgent(
  side: OverlaySidecar,
  parent?: Pick<StubAgent, "color" | "iconUrl" | "mode" | "enabled" | "live" | "projectId"> | null,
  hostLive = true
): StubAgent {
  return {
    id: sidecarRowId(side.path, side.addr),
    name: side.name,
    initial: skinInitials(side.name),
    path: side.path,
    addr: side.addr,
    joinMiss: null,
    kind: "agent",
    mode: parent?.mode ?? null,
    enabled: parent?.enabled ?? null,
    live: parent?.live ?? null,
    chatTitle: side.chatTitle,
    color: parent?.color ?? null,
    iconUrl: parent?.iconUrl ?? null,
    tabId: side.tabId ?? null,
    projectId: side.projectId ?? parent?.projectId ?? null,
    terminalId: side.terminalId ?? null,
    hostLive,
    ...(side.launch ? { launch: side.launch } : {}),
  };
}

function groupMessagesToThread(
  messages: ProjectGroupMessage[],
  username: string
): ThreadMessage[] {
  return messages.map((m, i) => ({
    id: m.id,
    seq: i,
    text: m.body,
    from: m.author,
    at: m.createdAt,
    mine: isMine(m.author, username),
    kind: "text",
    choice: null,
  }));
}

function oldestSeqOf(items: ThreadMessage[]): number | null {
  return items.reduce<number | null>((m, it) => {
    if (it.seq == null) return m;
    return m == null || it.seq < m ? it.seq : m;
  }, null);
}

function stubThread(agentId: string): ThreadMessage[] {
  const rows = STUB_THREAD[agentId] || STUB_THREAD_FALLBACK;
  return rows.map((m, i) => ({
    id: `stub-${agentId}-${i}`,
    seq: i,
    text: m.text,
    from: m.author,
    at: null,
    mine: m.mine,
    kind: "text",
    choice: null,
  }));
}

// Per-server module memory (multi-server MA6): every in-flight flag and
// generation is kept PER SERVER id, so reads and writes on two servers never
// cancel or block each other. Slots drop when a server is removed or
// re-keyed (MS3). `activityServer` / `focusServer` record which server's
// slice is ON SCREEN (the store shows one server's list today).

// One activity snapshot read at a time per server.
const activityMem = serverMemory(() => ({ inFlight: false }));
let activityServer: string | null = null;

// Pins: one projects/list read at a time per server; a write in flight (or
// one that started after the read) wins over that read. The write
// refetches after.
const pinMem = serverMemory(() => ({ inFlight: false, again: false, writes: 0, gen: 0 }));
let pinErrorTimer: ReturnType<typeof setTimeout> | null = null;
// Focus groups: one read at a time per server. `gen` is bumped by local
// group writes: a read that started before one is stale.
const focusMem = serverMemory(() => ({ inFlight: false, again: false, gen: 0 }));
let focusServer: string | null = null;

export const PIN_ERROR_MS = 4000;

// Pins moved to the server: drop the old per-device list, do not migrate.
clearLegacyPinStore();

// A removed or re-keyed server may be a different daemon (MS3 / MA2):
// forget its per-device focus pick too (the module memories above drop
// their own slots).
onServerForget((id) => {
  try {
    localStorage.removeItem(focusGroupStorageKey(id));
  } catch {
    /* no storage */
  }
  forgetRememberedSidecars(id);
  forgetHiddenSidecarAddrs(id);
  if (activityServer === id) activityServer = null;
  if (focusServer === id) focusServer = null;
});

/** The id of the server Zen is on now ("" when none). Late answers compare
 *  it with the scope they captured. */
function zenId(): string {
  return zenScope().id;
}

function errorText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e) return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export const useZenStore = create<ZenState>((set, get) => ({
  // Never start on the stub catalogue. A signed-in first paint used to
  // show STUB_AGENTS until hydrateAgents resolved. Stub is only applied
  // when hydrateAgents sees no token.
  agentSource: "loading",
  fileSource: "loading",
  agents: [],
  files: [],
  agentError: null,
  fileError: null,
  filesGen: 0,
  threadSource: "loading",
  threadError: null,
  thread: [],
  threadGen: 0,
  threadAddr: null,
  threadGroupId: null,
  threadConversationId: null,
  threadHasMore: false,
  threadOldestSeq: null,
  threadLoadingEarlier: false,
  sending: false,
  sendError: null,
  answeringId: null,
  answerError: null,
  answerErrorId: null,
  lastAtByKey: {},
  activity: EMPTY_ACTIVITY,
  chatSessions: NO_CHAT_SESSIONS,
  serverProjects: [],
  pinnedIds: [],
  pinError: null,
  focus: FOCUS_OFF,
  focusGroupsEnabled: false,
  // Per server (MA6): read for the server on screen by hydrateAgents.
  hiddenSidecarAddrs: [],
  pinChat: async (id, beforeId) => {
    const s = get();
    const pid = pinProjectIdForRow(s.agents.find((a) => a.id === id), s.serverProjects);
    if (!pid) return; // sidecar / group / unmatched row: pins are per workspace
    let order: string[] | null = null;
    let next = withPinned(s.serverProjects, pid, true);
    if (beforeId !== undefined) {
      const beforePid = beforeId
        ? pinProjectIdForRow(s.agents.find((a) => a.id === beforeId), s.serverProjects)
        : null;
      order = insertPinned(pinnedProjectOrder(s.serverProjects), pid, beforePid);
      next = withOrder(next, order);
    }
    await writePins(next, "Could not pin", async (scope) => {
      const r = await setProjectPinned(scope, pid, true);
      if (!r.ok) throw r.error || "Could not pin";
      if (order) {
        const o = await reorderProjects(scope, order);
        if (!o.ok) throw o.error || "Could not reorder pins";
      }
    });
  },
  movePin: async (id, beforeId) => {
    const s = get();
    const pid = pinProjectIdForRow(s.agents.find((a) => a.id === id), s.serverProjects);
    if (!pid) return;
    const beforePid = beforeId
      ? pinProjectIdForRow(s.agents.find((a) => a.id === beforeId), s.serverProjects)
      : null;
    const current = pinnedProjectOrder(s.serverProjects);
    if (!current.includes(pid)) return;
    const order = insertPinned(current, pid, beforePid);
    if (order.join("\n") === current.join("\n")) return;
    await writePins(withOrder(s.serverProjects, order), "Could not reorder pins", async (scope) => {
      const r = await reorderProjects(scope, order);
      if (!r.ok) throw r.error || "Could not reorder pins";
    });
  },
  unpinChat: async (id) => {
    const s = get();
    const pid = pinProjectIdForRow(s.agents.find((a) => a.id === id), s.serverProjects);
    if (!pid) return;
    await writePins(withPinned(s.serverProjects, pid, false), "Could not unpin", async (scope) => {
      const r = await setProjectPinned(scope, pid, false);
      if (!r.ok) throw r.error || "Could not unpin";
    });
  },
  refreshPins: async () => {
    if (get().agentSource !== "live") return;
    const scope = zenScope();
    const pins = pinMem.get(scope.id);
    if (pins.inFlight) {
      pins.again = true;
      return;
    }
    const gen = pins.gen;
    pins.inFlight = true;
    try {
      const r = await getCliProjectsList(scope);
      if (zenId() !== scope.id || pins.writes > 0 || pins.gen !== gen) return;
      if (!r.ok) return; // transient: keep what is on screen
      const projects = serverProjectsOf(r.data);
      if (!projects) return;
      set({
        serverProjects: projects,
        pinnedIds: derivePinnedIds(get().agents, projects),
      });
    } catch {
      /* keep what is on screen */
    } finally {
      pins.inFlight = false;
      if (pins.again) {
        pins.again = false;
        void get().refreshPins();
      }
    }
  },
  refreshFocus: async () => {
    if (get().agentSource !== "live") return;
    const scope = zenScope();
    const server = scope.id || null;
    const mem = focusMem.get(scope.id);
    if (mem.inFlight) {
      mem.again = true;
      return;
    }
    if (server !== focusServer) {
      focusServer = server;
      if (get().focus !== FOCUS_OFF || get().focusGroupsEnabled) {
        set({ focus: FOCUS_OFF, focusGroupsEnabled: false });
      }
    }
    mem.inFlight = true;
    const gen = mem.gen;
    let enabled = false;
    const apply = (focus: FocusState) => {
      if (zenId() !== scope.id || mem.gen !== gen) return;
      if (focus.enabled && focus.currentId) writeStoredFocusGroup(server, focus.currentId);
      set({ focus, focusGroupsEnabled: enabled });
    };
    try {
      const rs = await getAppSettings(scope);
      if (!rs.ok) {
        // Older daemon (no route): groups off. Anything else is transient.
        if (rs.status === 404) apply(FOCUS_OFF);
        return;
      }
      const settings = focusSettingsOf(rs.data);
      enabled = settings.enabled;
      if (!settings.enabled) {
        apply(FOCUS_OFF);
        return;
      }
      const rg = await getFocusGroupsList(scope);
      if (!rg.ok) {
        if (rg.status === 404) apply(FOCUS_OFF);
        return;
      }
      const groups = focusGroupsOf(rg.data);
      apply(groups ? resolveFocus(settings, groups, readStoredFocusGroup(server)) : FOCUS_OFF);
    } catch {
      /* keep what is on screen */
    } finally {
      mem.inFlight = false;
      if (mem.again) {
        mem.again = false;
        void get().refreshFocus();
      }
    }
  },
  selectFocusGroup: (groupId) => {
    const focus = get().focus;
    if (!focus.enabled || !focus.groups.some((g) => g.id === groupId)) return;
    writeStoredFocusGroup(zenId() || null, groupId);
    if (focus.currentId !== groupId) set({ focus: { ...focus, currentId: groupId } });
  },
  assignFocusGroup: async (id, groupId) => {
    const s = get();
    if (!s.focusGroupsEnabled && !s.focus.enabled) return false;
    const pid = pinProjectIdForRow(s.agents.find((a) => a.id === id), s.serverProjects);
    if (!pid) return false; // sidecar / group / unmatched row: groups are per workspace
    focusMem.get(zenId()).gen += 1;
    const ok = await writePins(
      withFocusGroup(s.serverProjects, pid, groupId),
      "Could not change group",
      async (scope) => {
        const r = await postAssignFocusGroup(scope, pid, groupId);
        if (!r.ok) throw r.error || "Could not change group";
      }
    );
    // Assign sends no `projects_changed`: re-read the groups too.
    void get().refreshFocus();
    return ok;
  },
  createFocusGroupFor: async (id, name) => {
    const clean = name.trim();
    if (!clean) return false;
    const s = get();
    if (!s.focusGroupsEnabled && !s.focus.enabled) return false;
    if (!pinProjectIdForRow(s.agents.find((a) => a.id === id), s.serverProjects)) return false;
    const scope = zenScope();
    const server = scope.id || null;
    let group: FocusGroupLite | null = null;
    try {
      const r = await postCreateFocusGroup(scope, clean);
      if (!r.ok) throw r.error || "Could not create group";
      group = focusGroupOf(r.data);
      if (!group) throw "Could not create group";
    } catch (e) {
      if (zenId() === scope.id) showPinError(errorText(e, "Could not create group"));
      return false;
    }
    if (zenId() !== scope.id) return false;
    focusMem.get(scope.id).gen += 1;
    const focus = get().focus;
    set({
      focus: focus.enabled
        ? { ...focus, groups: [...focus.groups.filter((g) => g.id !== group.id), group] }
        : resolveFocus(
            { enabled: true, activeId: null },
            [group],
            readStoredFocusGroup(server)
          ),
    });
    return get().assignFocusGroup(id, group.id);
  },
  refreshServerLists: () => {
    void get().refreshPins();
    void get().refreshFocus();
  },
  dismissFiles: () =>
    set({
      openFileIds: [],
      focusId: null,
      filesOpen: false,
    }),
  refreshActivity: async () => {
    if (get().agentSource !== "live") return;
    const scope = zenScope();
    const mem = activityMem.get(scope.id);
    if (mem.inFlight) return;
    const server = scope.id || null;
    // Another server's dots are not this one's.
    if (server !== activityServer) {
      activityServer = server;
      if (get().activity !== EMPTY_ACTIVITY) set({ activity: EMPTY_ACTIVITY });
    }
    mem.inFlight = true;
    try {
      const r = await getActivitySnapshot(scope);
      if (zenId() !== scope.id) return;
      if (r.ok) {
        const next = parseActivitySnapshot(r.data);
        if (!sameActivity(get().activity, next)) set({ activity: next });
      } else if (r.status === 404 && get().activity !== EMPTY_ACTIVITY) {
        // Pre-0.45 server: keep the list plain.
        set({ activity: EMPTY_ACTIVITY });
      }
      // Any other failure is transient: keep what is on screen.
    } catch {
      /* keep what is on screen */
    } finally {
      mem.inFlight = false;
    }
  },
  ensureLastAt: (key) => {
    // `key` is a `lastAtKey` (`<serverId>|t:<addr>`): it fetches on its own
    // server's scope (MA6).
    if (!beginLastAt(key)) return;
    void fetchLastAtForKey(key)
      .then((at) => {
        set((s) => ({
          lastAtByKey: { ...s.lastAtByKey, [key]: at },
        }));
      })
      .catch(() => {
        set((s) => ({
          lastAtByKey: { ...s.lastAtByKey, [key]: null },
        }));
      });
  },

  hydrateAgents: async (opts) => {
    const resumeId = (opts?.resumeId || "").trim();
    // A cold list load is not inside a drawer-picked chat.
    if (!resumeId && get().drawerOrigin) {
      writeDrawerOrigin(null);
      set({ drawerOrigin: null });
    }
    const scope = zenScope();
    if (!scope.token()) {
      set({
        agentSource: "stub",
        fileSource: "stub",
        agents: STUB_AGENTS,
        files: STUB_FILES,
        agentError: null,
        fileError: null,
        screen: resumeId ? "thread" : "list",
        agentId: resumeId || "",
        threadSource: resumeId ? "loading" : "stub",
        threadError: null,
        thread: resumeId ? [] : get().thread,
        threadGroupId: resumeId ? null : get().threadGroupId,
      });
      if (resumeId) get().setAgent(resumeId);
      return;
    }
    // Per-server feature memory (MS31): what this server's /boot-status
    // lists (features, version) gates routes and verbs on its scope.
    // Public, single-flight, re-read at most every few minutes.
    void ensureBootStatus(scope);
    // Session exists: stub is unreachable. Owner fleet is GET /cli/agent/list
    // (singular). Address book is GET /cli/projects/list. Join on path.
    // Plural /cli/agents/list is the skills enumerator.
    set({
      agentSource: "loading",
      fileSource: resumeId ? get().fileSource : "loading",
      agents: resumeId ? get().agents : [],
      files: resumeId ? get().files : [],
      agentError: null,
      fileError: null,
      screen: resumeId ? "thread" : "list",
      agentId: resumeId || "",
      openFileIds: resumeId ? get().openFileIds : [],
      focusId: resumeId ? get().focusId : null,
      threadSource: "loading",
      threadError: null,
      thread: [],
      threadGroupId: null,
      threadConversationId: null,
    });
    try {
      const [rAgents, rProjects, rGroups, rSessions] = await Promise.all([
        getAgentList(scope),
        getCliProjectsList(scope),
        fetchProjectGroups(scope),
        getAllSessions(scope),
      ]);
      const notices: string[] = [];
      let fleet: {
        name: string;
        path: string;
        mode: string | null;
        enabled: boolean | null;
        live: boolean | null;
      }[] = [];
      let book: { name: string; path: string; handle: string | null }[] = [];

      if (!rAgents.ok) {
        notices.push(rAgents.error || "GET /cli/agent/list failed");
      } else {
        const parsed = parseOwnerAgents(rAgents.data);
        if (!parsed) {
          notices.push(
            "GET /cli/agent/list returned an unrecognised shape. This overlay does not invent a mapping."
          );
        } else {
          for (const raw of parsed) {
            const row = ownerAgentOf(raw);
            if (row)
              fleet.push({
                name: row.name,
                path: row.path,
                mode: row.mode,
                enabled: row.enabled,
                live: row.live,
              });
          }
        }
      }

      let serverProjects: ServerProject[] = [];
      if (!rProjects.ok) {
        notices.push(rProjects.error || "GET /cli/projects/list failed");
      } else {
        serverProjects = serverProjectsOf(rProjects.data) ?? [];
        const parsed = parseCliProjects(rProjects.data);
        if (!parsed) {
          notices.push(
            "GET /cli/projects/list returned an unrecognised shape. This overlay does not invent a mapping."
          );
        } else {
          for (const raw of parsed) {
            const row = cliProjectOf(raw);
            if (row) book.push(row);
          }
        }
      }

      const groups: StubAgent[] = [];
      if (!rGroups.ok) {
        notices.push(rGroups.error || "GET /cli/project-group/list failed");
      } else {
        for (const g of rGroups.data ?? []) {
          if (!g?.id || !g.name) continue;
          groups.push({
            id: `group:${g.id}`,
            name: g.name,
            initial: skinInitials(g.name),
            addr: null,
            joinMiss: null,
            kind: "group",
            groupId: g.id,
            memberCount: g.memberCount ?? 0,
            color: null,
            iconUrl: null,
          });
        }
      }

      if (fleet.length === 0 && book.length === 0 && groups.length === 0) {
        const msg =
          notices[0] ||
          "No agents on this list. This overlay does not invent a mapping.";
        set({
          agentSource: "error",
          fileSource: "error",
          agents: [],
          files: [],
          agentError: msg,
          fileError: msg,
          threadSource: "error",
          threadError: msg,
          thread: [],
        });
        return;
      }

      const joined = joinAgentsWithProjects(fleet, book);
      let mapped: StubAgent[] = joined.map((row) => ({
        id: row.id,
        name: row.name,
        initial: skinInitials(row.name),
        path: row.path,
        addr: row.addr,
        joinMiss: row.joinMiss,
        kind: "agent" as const,
        mode: row.mode,
        enabled: row.enabled,
        live: row.live,
        chatTitle: row.chatTitle,
        color: row.color,
        iconUrl: row.iconUrl,
      }));
      const haveAddr = new Set(
        mapped.map((a) => (a.addr || "").trim()).filter(Boolean)
      );
      const mains = joined.filter(
        (r) => r.addr && !r.addr.includes("/") && !r.joinMiss
      );
      let chatSessions = NO_CHAT_SESSIONS;
      if (rSessions.ok) {
        const parsed = parseCompanionSessions(rSessions.data);
        if (parsed) {
          chatSessions = chatSessionsOf(parsed);
          const sides = sidecarsFromSessions(parsed, mains);
          for (const side of sides) {
            if (haveAddr.has(side.addr)) continue;
            haveAddr.add(side.addr);
            const parent = mapped.find((m) => m.path === side.path);
            mapped.push(overlaySidecarAgent(side, parent, true));
          }
          mapped = mergeSidecarTitles(mapped, sides);
        } else {
          notices.push(
            "GET /cli/companion/sessions returned an unrecognised shape. Sidecars were not listed."
          );
        }
      } else {
        notices.push(rSessions.error || "GET /cli/companion/sessions failed");
      }
      for (const side of extrasFromRemembered(
        readRememberedSidecars(scope.id, { adoptLegacy: true }),
        haveAddr,
        mains
      )) {
        const parent = mapped.find((m) => m.path === side.path);
        mapped.push(overlaySidecarAgent(side, parent, false));
      }
      writeRememberedSidecars(
        scope.id,
        mapped
          .filter((a) => (a.addr || "").includes("/") && (a.path || "").trim())
          .map((a) => ({
            addr: (a.addr || "").trim(),
            path: (a.path || "").trim(),
            name: a.name,
            chatTitle: a.chatTitle || sidecarSuffix(a.addr || ""),
          }))
      );
      const agents: StubAgent[] = [...groups, ...mapped];
      pinMem.get(scope.id).gen += 1; // this read supersedes any refresh already out
      set({
        agentSource: "live",
        agents,
        serverProjects,
        pinnedIds: derivePinnedIds(agents, serverProjects),
        chatSessions,
        hiddenSidecarAddrs: readHiddenSidecarAddrs(scope.id, { adoptLegacy: true }),
        agentError: notices.length ? notices.join(" · ") : null,
        fileSource: resumeId ? get().fileSource : "live",
        files: resumeId ? get().files : [],
        fileError: resumeId ? get().fileError : null,
        threadSource: resumeId ? "loading" : "live",
        threadError: null,
        thread: [],
        screen: resumeId ? "thread" : "list",
        agentId: resumeId || "",
      });
      void get().refreshFocus();
      if (resumeId) {
        const hit =
          agents.find((a) => a.id === resumeId) ||
          agents.find((a) => a.addr === resumeId);
        get().setAgent(hit?.id || resumeId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        agentSource: "error",
        fileSource: "error",
        agents: resumeId ? get().agents : [],
        files: resumeId ? get().files : [],
        agentError: msg,
        fileError: msg,
        threadSource: resumeId ? "loading" : "error",
        threadError: resumeId ? null : msg,
        thread: [],
        screen: resumeId ? "thread" : "list",
        agentId: resumeId || "",
      });
      if (resumeId) get().setAgent(resumeId);
    }
  },

  hydrateFiles: async (dir, opts) => {
    const gen = get().filesGen + 1;
    const agent = get().agents.find((a) => a.id === get().agentId);
    const owned = typeof agent?.path === "string" ? agent.path.trim() : "";
    const usable = ownedWorkspacePath(dir, owned);
    if (!usable) {
      const reason =
        owned && dir !== owned ? PATH_NOT_OWNED : NO_WORKSPACE_PATH;
      set({ filesGen: gen, ...failFiles(reason, keepOpenFiles(get())) });
      return;
    }
    // A re-read on open keeps the live list up instead of flashing loading.
    if (opts?.refresh && get().fileSource === "live") {
      set({ filesGen: gen });
    } else {
      set({
        filesGen: gen,
        files: keepOpenFiles(get()),
        fileError: null,
        fileSource: "loading",
      });
    }
    // Build the patch at apply time: tabs may open while the GET is out.
    const apply = (patch: () => Partial<ZenState>) => {
      if (get().filesGen !== gen) return;
      set(patch());
    };
    try {
      const r = await getWorkspaceResources(zenScope(), usable);
      // 404 is a pre-0.45 server ("route not found") or a workspace the
      // daemon does not know. Either way there is nothing pinned to show.
      if (r.status === 404) {
        apply(() => noResources(keepOpenFiles(get())));
        return;
      }
      if (!r.ok || r.data === undefined) {
        apply(() =>
          failFiles(r.error || "Could not load Workspace Resources", keepOpenFiles(get()))
        );
        return;
      }
      const rows = parseWorkspaceResources(r.data, usable);
      apply(() => noResources(mergeResources(rows ?? [], get())));
    } catch (e) {
      apply(() =>
        failFiles(e instanceof Error ? e.message : String(e), keepOpenFiles(get()))
      );
    }
  },

  screen: "list",
  agentId: "",
  drawerOrigin: readDrawerOrigin(),
  filesOpen: false,
  openFileIds: [],
  focusId: null,
  fileReturn: "chat",

  hydrateGroup: async (groupId) => {
    const gen = get().threadGen + 1;
    set({
      threadGen: gen,
      thread: [],
      threadError: null,
      threadSource: "loading",
      threadAddr: null,
      threadGroupId: groupId,
      threadConversationId: null,
      threadHasMore: false,
      threadOldestSeq: null,
    });
    const scope = zenScope();
    const username = scope.username();
    try {
      const r = await fetchProjectGroupMessages(scope, groupId, { limit: 50 });
      if (get().threadGen !== gen) return;
      if (!r.ok) {
        set({
          threadSource: "error",
          thread: [],
          threadError: r.error || "project chat failed",
        });
        return;
      }
      const items = groupMessagesToThread(r.data?.messages ?? [], username);
      set({
        threadSource: "live",
        thread: items,
        threadError: null,
        threadHasMore: !!r.data?.truncated,
        threadOldestSeq: items.length ? 0 : null,
      });
    } catch (e) {
      if (get().threadGen !== gen) return;
      set({
        threadSource: "error",
        thread: [],
        threadError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  hydrateThread: async (addr) => {
    if (get().agentSource === "stub") {
      set({
        threadSource: "stub",
        threadError: null,
        thread: stubThread(addr),
        threadAddr: addr,
        threadGroupId: null,
        threadConversationId: null,
        threadHasMore: false,
        threadOldestSeq: null,
      });
      return;
    }
    const gen = get().threadGen + 1;
    set({
      threadGen: gen,
      thread: [],
      threadError: null,
      threadSource: "loading",
      threadAddr: addr,
      threadGroupId: null,
      threadConversationId: null,
      threadHasMore: false,
      threadOldestSeq: null,
    });
    const scope = zenScope();
    const username = scope.username();
    try {
      const r = await getThread(scope, addr);
      if (get().threadGen !== gen) return;
      if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
        set({
          threadSource: "error",
          thread: [],
          threadError:
            typeof r.error === "string" && r.error
              ? r.error
              : r.error
                ? JSON.stringify(r.error)
                : "thread failed",
        });
        return;
      }
      const items = r.data.items
        .map((it) => normaliseThreadItem(it, username))
        .filter((m): m is ThreadMessage => !!m)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const last = items[items.length - 1];
      set({
        threadSource: "live",
        thread: items,
        threadError: null,
        threadConversationId: (r.data.conversation_id || "").trim() || null,
        threadHasMore: !!r.data.has_more,
        threadOldestSeq: oldestSeqOf(items),
        lastAtByKey: {
          ...get().lastAtByKey,
          [lastAtKey(scope.id, "thread", addr)]:
            last?.at ?? get().lastAtByKey[lastAtKey(scope.id, "thread", addr)] ?? null,
        },
      });
    } catch (e) {
      if (get().threadGen !== gen) return;
      set({
        threadSource: "error",
        thread: [],
        threadError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadEarlier: async () => {
    const { threadAddr, threadOldestSeq, threadHasMore, threadLoadingEarlier, agentSource } =
      get();
    if (agentSource === "stub") return;
    if (!threadAddr || threadOldestSeq == null || !threadHasMore || threadLoadingEarlier) {
      return;
    }
    const gen = get().threadGen;
    set({ threadLoadingEarlier: true });
    const scope = zenScope();
    const username = scope.username();
    try {
      const r = await getThread(scope, threadAddr, 50, threadOldestSeq);
      if (get().threadGen !== gen) return;
      if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
        set({ threadLoadingEarlier: false });
        return;
      }
      const seen = new Set(get().thread.map((m) => m.id));
      const older = r.data.items
        .map((it) => normaliseThreadItem(it, username))
        .filter((m): m is ThreadMessage => !!m && !seen.has(m.id))
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const thread = [...older, ...get().thread];
      set({
        thread,
        threadHasMore: !!r.data.has_more && older.length > 0,
        threadOldestSeq: oldestSeqOf(thread),
        threadLoadingEarlier: false,
      });
    } catch {
      if (get().threadGen !== gen) return;
      set({ threadLoadingEarlier: false });
    }
  },

  sendThread: async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const scope = zenScope();
    if (get().agentSource === "stub" || get().threadSource === "stub") {
      set({ sendError: "STUB — Cannot send — POST /cli/thread/post not proven" });
      return;
    }
    const groupId = (get().threadGroupId || "").trim();
    if (groupId) {
      const gen = get().threadGen;
      set({ sending: true, sendError: null });
      try {
        const posted = await postProjectGroupMessage(scope, groupId, trimmed);
        if (get().threadGen !== gen) return;
        if (!posted.ok || !posted.data) {
          set({
            sending: false,
            sendError: posted.error || "send failed",
          });
          return;
        }
        const username = scope.username();
        const row = posted.data;
        const msg = groupMessagesToThread(
          [
            {
              id: row.id,
              groupId: row.groupId,
              author: row.author,
              body: row.body,
              createdAt: row.createdAt,
            },
          ],
          username
        )[0];
        const seen = new Set(get().thread.map((m) => m.id));
        set({
          sending: false,
          sendError: null,
          thread: msg && !seen.has(msg.id) ? [...get().thread, msg] : get().thread,
          lastAtByKey: {
            ...get().lastAtByKey,
            [lastAtKey(scope.id, "group", groupId)]: row.createdAt,
          },
        });
      } catch (e) {
        if (get().threadGen !== gen) return;
        set({
          sending: false,
          sendError: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
    const addr = get().threadAddr;
    if (!isSendableAddr(addr)) {
      set({ sendError: get().threadError || "Not chattable" });
      return;
    }
    const gen = get().threadGen;
    const before = get().thread.map((m) => m.id);
    set({ sending: true, sendError: null });
    try {
      const posted = await postThread(scope, addr, trimmed);
      if (get().threadGen !== gen) return;
      if (!posted.ok) {
        set({
          sending: false,
          sendError: posted.error || "send failed",
        });
        return;
      }
      const postedId = String(
        (posted.data &&
          (posted.data.id ||
            (posted.data.doc && posted.data.doc.id))) ||
          ""
      );
      const reread = await getThread(scope, addr);
      if (get().threadGen !== gen) return;
      if (!reread.ok || !reread.data || !Array.isArray(reread.data.items)) {
        set({
          sending: false,
          sendError: "sent but the thread could not be re-read",
        });
        return;
      }
      const username = scope.username();
      const items = reread.data.items
        .map((it) => normaliseThreadItem(it, username))
        .filter((m): m is ThreadMessage => !!m)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const onWire = postedId
        ? items.find((m) => m.id === postedId)
        : items.find((m) => m.text === trimmed && !before.includes(m.id));
      if (!onWire) {
        set({
          sending: false,
          sendError: "sent but not on the wire",
        });
        return;
      }
      // Arrival is not authorship. Accept owner or the signed-in
      // username; never this thread's own agent handle.
      if (!isOwnerAuthored(onWire.from, username, addr)) {
        set({
          sending: false,
          sendError: `sent but the speaker was wrong (from='${onWire.from}')`,
        });
        return;
      }
      set({
        sending: false,
        sendError: null,
        thread: items,
        threadConversationId:
          (reread.data.conversation_id || "").trim() ||
          get().threadConversationId,
        threadHasMore: !!reread.data.has_more,
        threadOldestSeq: oldestSeqOf(items),
        lastAtByKey: {
          ...get().lastAtByKey,
          [lastAtKey(scope.id, "thread", addr)]: onWire.at ?? Date.now() / 1000,
        },
      });
    } catch (e) {
      if (get().threadGen !== gen) return;
      set({
        sending: false,
        sendError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  answerChoice: async (messageId, option) => {
    const id = messageId.trim();
    const answer = option.trim();
    if (!id || !answer) return;
    if (get().agentSource === "stub" || get().threadSource === "stub") {
      set({
        answerError: "STUB — Cannot answer — POST /cli/thread/answer not proven",
        answerErrorId: id,
      });
      return;
    }
    if ((get().threadGroupId || "").trim()) return;
    const addr = get().threadAddr;
    if (!isSendableAddr(addr)) return;
    const msg = get().thread.find((m) => m.id === id);
    if (!msg?.choice || msg.kind === "secret") return;
    if (msg.choice.answer != null && String(msg.choice.answer) !== "") return;
    if (!msg.choice.options.includes(answer)) return;
    const gen = get().threadGen;
    set({ answeringId: id, answerError: null, answerErrorId: null });
    try {
      const posted = await answerThread(zenScope(), addr, id, answer);
      if (get().threadGen !== gen) return;
      if (!posted.ok) {
        set({
          answeringId: null,
          answerError: posted.error || "answer failed",
          answerErrorId: id,
        });
        return;
      }
      const thread = get().thread.map((m) =>
        m.id === id && m.choice
          ? { ...m, choice: { ...m.choice, answer } }
          : m
      );
      set({
        answeringId: null,
        answerError: null,
        answerErrorId: null,
        thread,
      });
    } catch (e) {
      if (get().threadGen !== gen) return;
      set({
        answeringId: null,
        answerError: e instanceof Error ? e.message : String(e),
        answerErrorId: id,
      });
    }
  },

  ingestThreadRaw: (raw) => {
    if (get().agentSource === "stub") return;
    if (!get().threadAddr) return;
    const scope = zenScope();
    const username = scope.username();
    const msg = normaliseThreadItem(raw, username);
    if (!msg) return;
    const thread = mergeThreadMessages(get().thread, [msg]);
    if (thread === get().thread) return;
    const last = thread[thread.length - 1];
    const addr = get().threadAddr;
    const wasError = get().threadSource === "error";
    set({
      thread,
      threadSource: wasError ? "live" : get().threadSource,
      threadError: wasError ? null : get().threadError,
      lastAtByKey: addr
        ? {
            ...get().lastAtByKey,
            [lastAtKey(scope.id, "thread", addr)]:
            last?.at ?? get().lastAtByKey[lastAtKey(scope.id, "thread", addr)] ?? null,
          }
        : get().lastAtByKey,
    });
  },

  refreshOpenThread: async () => {
    if (get().agentSource === "stub") return;
    const gen = get().threadGen;
    const groupId = (get().threadGroupId || "").trim();
    const scope = zenScope();
    const username = scope.username();
    if (groupId) {
      try {
        const r = await fetchProjectGroupMessages(scope, groupId, { limit: 50 });
        if (get().threadGen !== gen || get().threadGroupId !== groupId) return;
        if (!r.ok) return;
        const incoming = groupMessagesToThread(r.data?.messages ?? [], username);
        const cur = get().thread;
        const same =
          cur.length === incoming.length &&
          cur.every((m, i) => m.id === incoming[i]?.id);
        if (same) return;
        const last = incoming[incoming.length - 1];
        set({
          thread: incoming,
          threadSource: "live",
          threadError: null,
          lastAtByKey: {
            ...get().lastAtByKey,
            [lastAtKey(scope.id, "group", groupId)]:
              last?.at ?? get().lastAtByKey[lastAtKey(scope.id, "group", groupId)] ?? null,
          },
        });
      } catch {
        /* keep what is on screen */
      }
      return;
    }
    const addr = get().threadAddr;
    if (!addr) return;
    try {
      const r = await getThread(scope, addr);
      if (get().threadGen !== gen || get().threadAddr !== addr) return;
      if (!r.ok || !r.data || !Array.isArray(r.data.items)) return;
      const incoming = r.data.items
        .map((it) => normaliseThreadItem(it, username))
        .filter((m): m is ThreadMessage => !!m);
      const thread = mergeThreadMessages(get().thread, incoming);
      const conv =
        (r.data.conversation_id || "").trim() || get().threadConversationId;
      if (thread === get().thread && conv === get().threadConversationId) return;
      const last = thread[thread.length - 1];
      set({
        thread,
        threadSource: "live",
        threadError: null,
        threadConversationId: conv,
        threadOldestSeq: get().threadOldestSeq ?? oldestSeqOf(thread),
        lastAtByKey: {
          ...get().lastAtByKey,
          [lastAtKey(scope.id, "thread", addr)]:
            last?.at ?? get().lastAtByKey[lastAtKey(scope.id, "thread", addr)] ?? null,
        },
      });
    } catch {
      /* keep what is on screen */
    }
  },

  setAgent: (id) => {
    set({
      screen: "thread",
      agentId: id,
      openFileIds: [],
      focusId: null,
      sending: false,
      sendError: null,
    });
    const row = get().agents.find((a) => a.id === id);
    if (row?.kind === "group" && row.groupId) {
      // A project chat has no workspace, so no resources: show the note.
      // Bump filesGen so an older agent's GET cannot land here.
      set({ filesGen: get().filesGen + 1, ...noResources() });
      void get().hydrateGroup(row.groupId);
      return;
    }
    const owned = typeof row?.path === "string" ? row.path.trim() : "";
    if (owned) void get().hydrateFiles(owned);
    else if (get().agentSource !== "stub") {
      set({ filesGen: get().filesGen + 1, ...failFiles(NO_WORKSPACE_PATH) });
    }
    if (get().agentSource === "stub") {
      void get().hydrateThread(id);
      return;
    }
    if (row?.addr) {
      void get().hydrateThread(row.addr);
      // A History row opened read-only (`hostLive: false`) is not woken.
      if (sidecarSuffix(row.addr) && row.hostLive !== false) void get().ensureSidecarHost(row);
    } else {
      set({
        threadSource: "error",
        thread: [],
        threadError: row?.joinMiss || "Not chattable",
        threadGroupId: null,
        threadConversationId: null,
      });
    }
  },
  ensureSidecarHost: async (row) => {
    const addr = (row.addr || "").trim();
    const path = (row.path || "").trim();
    const suffix = sidecarSuffix(addr);
    if (!path || !suffix) return { ok: true, terminalId: null };
    const scope = zenScope();
    const listed = await getAllSessions(scope);
    const sessions =
      listed.ok && Array.isArray(listed.data) ? listed.data : [];
    // A plain tab's `ws/N` Thread is not keyed by its agentName: trust
    // the row's own PTY while it is live, never spawn a second host.
    const existing = terminalIdForAgent({ path, addr, terminalId: row.terminalId }, sessions);
    if (existing) return { ok: true, terminalId: existing };
    const label = (row.chatTitle || suffix).trim() || suffix;
    const spawned = row.launch
      ? await spawnSidecarSession(scope, path, suffix, label, row.launch)
      : await spawnSidecarSession(scope, path, suffix, label);
    if (!spawned.ok) {
      return {
        ok: false,
        terminalId: null,
        error: spawned.error || "Could not start the host session",
      };
    }
    rememberSidecar(scope.id, {
      addr,
      path,
      name: "",
      chatTitle: label,
    });
    const again = await getAllSessions(scope);
    const next = again.ok && Array.isArray(again.data) ? again.data : [];
    const terminalId =
      terminalIdForAgent({ path, addr }, next) ??
      spawned.data?.sessionId ??
      null;
    set({
      agents: get().agents.map((a) =>
        (a.addr || "").trim() === addr
          ? { ...a, hostLive: true, terminalId: terminalId || a.terminalId }
          : a
      ),
    });
    return {
      ok: true,
      terminalId,
    };
  },
  openSidecar: async (baseId, opts) => {
    const base = get().agents.find((a) => a.id === baseId);
    const addr = (base?.addr || "").trim();
    const path = (base?.path || "").trim();
    if (!base || !addr || base.kind === "group") {
      return { ok: false, error: "Not chattable" };
    }
    if (!path) {
      return { ok: false, error: "No workspace path to start a separate chat" };
    }
    const next = nextSidecarAddr(addr, [
      ...get()
        .agents.map((a) => (a.addr || "").trim())
        .filter(Boolean),
      ...get().hiddenSidecarAddrs,
      ...(opts?.existingAddrs ?? []),
    ]);
    if (!next) return { ok: false, error: "Could not pick a sidecar address" };
    const suffix = sidecarSuffix(next);
    const spawned = await spawnSidecarSession(zenScope(), path, suffix, suffix, opts?.launch);
    if (!spawned.ok) {
      return {
        ok: false,
        error: spawned.error || "Could not start a separate chat",
      };
    }
    const serverName = (spawned.data?.agentName || "").trim() || suffix;
    const sidecarAddr = serverName.includes("/")
      ? serverName
      : `${addr.split("/")[0]}/${serverName}`;
    const placeholder: StubAgent = {
      id: sidecarRowId(path, sidecarAddr),
      name: base.name,
      initial: base.initial,
      path,
      addr: sidecarAddr,
      joinMiss: null,
      kind: "agent",
      chatTitle: sidecarSuffix(sidecarAddr) || serverName,
      mode: base.mode,
      enabled: base.enabled,
      live: base.live,
      color: base.color,
      iconUrl: base.iconUrl,
    };
    rememberSidecar(zenId(), {
      addr: sidecarAddr,
      path,
      name: base.name,
      chatTitle: placeholder.chatTitle || sidecarSuffix(sidecarAddr),
    });
    set({
      agents: [
        placeholder,
        ...get().agents.filter(
          (a) => a.id !== placeholder.id && a.addr !== sidecarAddr
        ),
      ],
    });
    if (opts?.fromDrawer) {
      const origin = nextDrawerOrigin(get().drawerOrigin, get().agentId, placeholder.id);
      writeDrawerOrigin(origin);
      set({ drawerOrigin: origin, filesOpen: false });
    }
    get().setAgent(placeholder.id);
    await get().hydrateAgents({ resumeId: placeholder.id });
    const row =
      get().agents.find((a) => a.addr === sidecarAddr) ??
      get().agents.find((a) => a.id === placeholder.id);
    if (row && row.id !== get().agentId) get().setAgent(row.id);
    return { ok: true, addr: sidecarAddr };
  },
  spawnLlmSession: async (baseId, llm, existingAddrs = []) => {
    const launch = { command: llm.command, args: llm.args };
    if (canSidecar(llm.harness)) {
      const r = await get().openSidecar(baseId, { launch, existingAddrs, fromDrawer: true });
      return r.ok
        ? { ok: true, kind: "chat", addr: r.addr || "" }
        : { ok: false, error: r.error || `Could not start ${llm.name}` };
    }
    const base = get().agents.find((a) => a.id === baseId);
    const path = (base?.path || "").trim();
    if (!path) return { ok: false, error: "No workspace path to start a session" };
    const spawned = await spawnTabSession(zenScope(), path, launch, llm.name);
    const terminalId = (spawned.data?.sessionId || "").trim();
    if (!spawned.ok || !terminalId) {
      return { ok: false, error: spawned.error || `Could not start ${llm.name}` };
    }
    void useWorkspacesStore.getState().fetchAllSessions();
    return { ok: true, kind: "terminal", terminalId, title: llm.name };
  },
  renameSidecarTitle: async (id, title) => {
    const name = (title || "").trim();
    if (!name) return { ok: false, error: "Name required" };
    const row = get().agents.find((a) => a.id === id);
    const addr = (row?.addr || "").trim();
    if (!row || !isOverlayExtraAddr(addr)) {
      return { ok: false, error: "Only extra chats can be renamed" };
    }
    const scope = zenScope();
    try {
      const listed = await getAllSessions(scope);
      const sessions: GlobalSession[] =
        listed.ok && Array.isArray(listed.data) ? listed.data : [];
      const target = sidecarRenameTarget({
        addr,
        path: row.path || "",
        sessions,
        projects: useWorkspacesStore.getState().projects,
        storedTabId: row.tabId,
        storedProjectId: row.projectId,
        storedTerminalId: row.terminalId,
      });
      if (!target) {
        return { ok: false, error: "Couldn't find this sidecar in K2" };
      }
      let wrote = false;
      if (target.terminalId) {
        const r = await setSessionLabel(scope, target.terminalId, name);
        if (!r.ok) return { ok: false, error: r.error || "K2 did not take the new name" };
        wrote = true;
      }
      if (target.projectId && target.tabId) {
        const r = await setTabTitle(scope, target.projectId, target.tabId, name);
        if (r.ok) wrote = true;
        else if (!wrote) {
          return { ok: false, error: r.error || "K2 did not take the new name" };
        }
      }
      if (!wrote) {
        return { ok: false, error: "Couldn't find this sidecar in K2" };
      }
      const again = await getAllSessions(scope);
      const next: GlobalSession[] =
        again.ok && Array.isArray(again.data) ? again.data : [];
      const live = sidecarLiveLabel(
        matchSidecarSession(addr, row.path || "", next)
      );
      // companion/sessions only echoes a Locked PTY label (20c49e2b+).
      if (live !== name) {
        return { ok: false, error: "K2 did not take the new name" };
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    set({
      agents: get().agents.map((a) =>
        a.id === id ? { ...a, chatTitle: name } : a
      ),
    });
    rememberSidecar(zenId(), {
      addr,
      path: row.path || "",
      name: row.name,
      chatTitle: name,
    });
    unhideSidecarAddr(zenId(), addr);
    return { ok: true };
  },
  hideSidecarChat: (id) => {
    const row = get().agents.find((a) => a.id === id);
    const addr = (row?.addr || "").trim();
    if (!row || !isOverlayExtraAddr(addr)) return;
    hideSidecarAddr(zenId(), addr);
    set({
      hiddenSidecarAddrs: [
        addr,
        ...get().hiddenSidecarAddrs.filter((x) => x !== addr),
      ],
    });
    if (get().agentId === id) get().closeChat();
  },
  openWorkspaceSession: ({ addr, path, side }) => {
    const want = (addr || "").trim();
    if (!want) return;
    const agents = get().agents;
    const samePath = (p?: string | null) => (p || "").trim() === (path || "").trim();
    let row =
      agents.find((a) => (a.addr || "").trim() === want && samePath(a.path)) ??
      agents.find((a) => (a.addr || "").trim() === want);
    const woken = side?.hostLive === true && row?.hostLive === false;
    if (
      row &&
      side &&
      ((side.launch && !row.launch) || (side.terminalId && !row.terminalId) || woken)
    ) {
      // The drawer knows the PTY / harness the list row lacks (History
      // respawn), or a History row it opened read-only has been woken.
      const prev = row;
      const merged: StubAgent = {
        ...prev,
        launch: prev.launch ?? side.launch ?? null,
        terminalId: (woken && side.terminalId) || prev.terminalId || side.terminalId || null,
        ...(woken ? { hostLive: true } : {}),
      };
      row = merged;
      set({ agents: agents.map((a) => (a === prev ? merged : a)) });
    }
    if (!row && side) {
      const parent = agents.find(
        (a) => samePath(a.path) && !(a.addr || "").includes("/") && a.kind !== "group"
      );
      row = overlaySidecarAgent(side, parent, side.hostLive ?? true);
      set({ agents: [...agents, row] });
    }
    if (!row) return;
    const cur = get().agentId;
    const origin = nextDrawerOrigin(get().drawerOrigin, cur, row.id);
    writeDrawerOrigin(origin);
    set({ drawerOrigin: origin, filesOpen: false });
    if (row.id !== cur) get().setAgent(row.id);
  },
  returnToDrawerOrigin: () => {
    const origin = get().drawerOrigin;
    writeDrawerOrigin(null);
    set({ drawerOrigin: null });
    if (origin && origin !== get().agentId) get().setAgent(origin);
  },
  closeChat: () => {
    writeDrawerOrigin(null);
    set({
      drawerOrigin: null,
      screen: "list",
      agentId: "",
      openFileIds: [],
      focusId: null,
      thread: [],
      threadError: null,
      threadAddr: null,
      threadGroupId: null,
      threadConversationId: null,
      files: [],
    });
  },
  toggleFiles: () => {
    const open = !get().filesOpen;
    set({ filesOpen: open });
    // The phone does not hear `workspace_resources_changed` on
    // sessions/events, so re-read the list every time the pane opens.
    if (!open || get().agentSource !== "live") return;
    const row = get().agents.find((a) => a.id === get().agentId);
    if (row?.kind === "group") return;
    const owned = typeof row?.path === "string" ? row.path.trim() : "";
    if (owned) void get().hydrateFiles(owned, { refresh: true });
  },

  openFile: (id) => {
    // A pinned file that is gone from disk is listed but not openable.
    if (get().files.find((f) => f.id === id)?.missing) return;
    get().openFileFromPath(id);
  },
  openFileFromPath: (ref) => {
    const raw = (ref || "").trim();
    if (!raw) return;
    const { files, openFileIds, fileSource, agentId, agents } = get();
    const row = agents.find((a) => a.id === agentId);
    const owned = typeof row?.path === "string" ? row.path.trim() : "";
    const workspace = usableFsPath(owned);
    const listed =
      files.find((f) => f.id === raw) ||
      files.find((f) => f.name === raw) ||
      files.find((f) => workspace && f.id === resolveFileRef(raw, workspace));
    let id = listed?.id ?? resolveFileRef(raw, workspace);
    if (!id) return;
    let file = files.find((f) => f.id === id);
    if (!file) {
      // Chat links open any file in the workspace, not just resources.
      if (fileSource === "stub") return;
      if (!workspace || !isUnderWorkspace(id, workspace)) return;
      const name = id.split("/").filter(Boolean).pop() || id;
      file = { id, name, body: "", linked: true };
      set({ files: [...get().files, file] });
    }
    // The viewer is full screen, one file at a time. Open files stack:
    // the newest is on top and closing it shows the one under it.
    if (openFileIds.length === 0) {
      set({ fileReturn: get().filesOpen ? "files" : "chat" });
    }
    set({
      openFileIds: [...openFileIds.filter((x) => x !== id), id],
      focusId: id,
      filesOpen: true,
    });
    // A failed read retries on the next open; a good one is kept.
    if (fileSource === "stub" || file.body || (file.loaded && !file.readError)) return;
    const ws = ownedWorkspacePath(owned, owned);
    const filePath = usableFsPath(id);
    // The daemon's own resource list vouches for a pinned file, even one
    // outside the workspace folder. Anything else must sit under it.
    const pinned = !file.linked && fileSource === "live";
    const patch = (p: Partial<StubFile>) =>
      set({ files: get().files.map((f) => (f.id === id ? { ...f, ...p } : f)) });
    if (!filePath || (!pinned && (!ws || !isUnderWorkspace(filePath, ws)))) {
      patch({ loaded: true, fsPath: null, readError: "This file is outside the workspace." });
      return;
    }
    // Images, PDFs, media and archives load their own bytes in the viewer.
    if (isBinaryPreviewCategory(getFileCategory(filePath))) {
      patch({ loaded: true, fsPath: filePath, readError: null });
      return;
    }
    // Not filesGen: a resources re-read on pane open must not drop the
    // body of a tab it kept. A different chat is a different agentId.
    void getFsReadFile(zenScope(), filePath).then((r) => {
      if (get().agentId !== agentId) return;
      if (!get().files.some((f) => f.id === id)) return;
      if (r.ok && r.data) {
        patch({ body: r.data.content, loaded: true, fsPath: filePath, readError: null });
      } else {
        patch({ loaded: true, fsPath: filePath, readError: r.error || "read-file failed" });
      }
    });
  },

  closeFile: (id) => {
    const { openFileIds, focusId, fileReturn } = get();
    const next = openFileIds.filter((x) => x !== id);
    if (next.length === 0) {
      // Last file closed: back to where the viewer was opened from.
      set({ openFileIds: next, focusId: null, filesOpen: fileReturn === "files" });
      return;
    }
    set({
      openFileIds: next,
      focusId: focusId === id ? next[next.length - 1] : focusId,
    });
  },

  focusFile: (id) => set({ focusId: id }),
}));

/** The header's short error line (pins and groups). Clears itself. */
function showPinError(text: string): void {
  useZenStore.setState({ pinError: text });
  if (pinErrorTimer) clearTimeout(pinErrorTimer);
  pinErrorTimer = setTimeout(() => {
    pinErrorTimer = null;
    useZenStore.setState({ pinError: null });
  }, PIN_ERROR_MS);
}

/**
 * Optimistic project write (pin, order, group): show `next` now, run
 * `call`, and on failure put the old list back with a short error line.
 * Always refetch after. True when the call went through.
 */

async function writePins(
  next: ServerProject[],
  fallback: string,
  call: (scope: ServerScope) => Promise<void>
): Promise<boolean> {
  const { getState: get, setState: set } = useZenStore;
  const before = get().serverProjects;
  // The write and its refetch stay on the server it started on (MS7).
  const scope = zenScope();
  const server = scope.id;
  const pins = pinMem.get(server);
  pins.writes += 1;
  pins.gen += 1;
  set({ serverProjects: next, pinnedIds: derivePinnedIds(get().agents, next), pinError: null });
  try {
    await call(scope);
    return true;
  } catch (e) {
    if (zenId() === server) {
      set({
        serverProjects: before,
        pinnedIds: derivePinnedIds(get().agents, before),
      });
      showPinError(errorText(e, fallback));
    }
    return false;
  } finally {
    pins.writes -= 1;
    if (zenId() === server) void get().refreshPins();
  }
}
