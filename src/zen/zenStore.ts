import { create } from "zustand";
import {
  getAgentList,
  getAllSessions,
  getCliProjectsList,
  getFsReadFile,
  getActivitySnapshot,
  FEATURE_THREAD_LATEST,
  serverHasFeature,
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
  fetchProjectGroupResources,
  fetchProjectGroups,
  postProjectGroupMessage,
  type ProjectGroup,
} from "../api/projectGroups";
import { ensureBootStatus, scopeFor, serverMemory, type ServerScope } from "../api/scope";
import { roomServerId, setRoomServer, zenScope } from "./zenScope";
import { onServerForget, useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { sidecarRowId } from "./agentRow";
import { buildServerRows, groupAgentRow, overlaySidecarAgent } from "./serverRows";
import { queueServerAvatars } from "../lib/avatarCache";
import { STUB_AGENTS, STUB_FILES, STUB_THREAD, STUB_THREAD_FALLBACK, type StubAgent, type StubFile } from "./stubData";
import {
  beginLastAt,
  fetchLastAtForKey,
  fetchThreadLasts,
  lastAtKey,
  parseLastAtKey,
  rowLastFromMessage,
  sameRowLast,
} from "./lastAtFetch";
import type { RowLast } from "./rowPreview";
import { readRowPreviews, writeRowPreviews } from "./rowPreviewCache";
import { clearLegacyPinStore, insertPinned } from "./pinChats";
import {
  FOCUS_OFF,
  derivePinnedIds,
  focusGroupOf,
  focusGroupsOf,
  focusSettingsOf,
  fullProjectOrder,
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
import { pool } from "./multi/pool";
import { looksUnreachable, serverDown } from "./multi/serverHealth";
import { terminalIdForAgent } from "./terminalJump";
import { resolveFileRef } from "./chatLinks";
import { getFileCategory, isBinaryPreviewCategory } from "./files/fileCategory";
import {
  nextSidecarAddr,
  forgetRememberedSidecars,
  readRememberedSidecars,
  rememberSidecar,
  matchSidecarSession,
  sidecarLiveLabel,
  sidecarRenameTarget,
  sidecarSuffix,
  writeRememberedSidecars,
  type OverlaySidecar,
} from "./sidecarRows";
import { groupMessagesToThread, isOwnerAuthored, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { mergeThreadMessages } from "./threadLive";
import { mergeServerPage, sameMessage } from "./threadCacheMerge";
import { chatCache } from "./chatCache";
import {
  applyGroupRead,
  applyThreadRead,
  fetchGroupRead,
  fetchThreadRead,
  type ChatRead,
  type ReadMode,
} from "./chatRevalidate";
import type { CachedChat } from "./chatCacheBackend";
import { deltaSupported } from "../api/threadDelta";
import { entryForRow, type RowRef } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { RETURN_HOLD_MS, holdFirstPaint, knownServerNewest } from "./returnHold";
import { installChatCacheWiring } from "./chatCacheWiring";
import { attachRefreshDue } from "./attachmentRefresh";
import {
  beginChatOpen,
  noteCachedPaint,
  notePaintAfterResponse,
  noteResponse,
} from "./chatTiming";
import {
  landedId,
  newLocalId,
  rememberLanded,
  threadRoomKey,
  type OutgoingMessage,
} from "./outbox";
import {
  EMPTY_ACTIVITY,
  NO_CHAT_SESSIONS,
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
import { parseGroupResources, parseWorkspaceResources } from "./workspaceResources";
import {
  forgetHiddenSidecarAddrs,
  hideSidecarAddr,
  isOverlayExtraAddr,
  readHiddenSidecarAddrs,
  unhideSidecarAddr,
} from "./overlayExtras";
import { nextDrawerOrigin, readDrawerOrigin, writeDrawerOrigin } from "./sessionDrawer";
import { canSidecar, type ActiveLlm } from "./llmPresets";
import { markGroupSeenAt, type GroupPreview } from "./projectChats";
import { activityForRow } from "./agentActivity";

/** `openSidecar` options. `launch` picks the harness (default Claude);
 *  `existingAddrs` adds server addrs the agents list may not hold (hidden
 *  sidecars, drawer rows) so `nextSidecarAddr` never reuses one;
 *  `fromDrawer` keeps the Sessions drawer's Done origin. */
export type LoadEarlierResult = "loaded" | "failed" | "skipped";

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
  /** The Thread on screen is this phone's cached copy, not yet confirmed
   *  by a server read (stale-while-revalidate). Read marking and card
   *  answers wait for the server's copy. */
  threadCached: boolean;
  /** The first paint is held (≤ RETURN_HOLD_MS) for a read that will
   *  bring a cache known to be behind up to date (`returnHold`). */
  threadHolding: boolean;
  threadGen: number;
  threadAddr: string | null;
  threadGroupId: string | null;
  threadConversationId: string | null;
  threadHasMore: boolean;
  threadOldestSeq: number | null;
  threadLoadingEarlier: boolean;
  /** Push tap `/zen?addr=&seq=`: the message to scroll to and highlight
   *  once the Thread has it (ThreadPane consumes and clears it). */
  threadFocusSeq: number | null;
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
  /** Files pane for a project chat: the group's own Workspace Resources
   *  (`GET /cli/project-group/resources`, the union over its members). */
  hydrateGroupFiles: (groupId: string, opts?: { refresh?: boolean }) => Promise<void>;
  /** The Agents header's Projects sheet is up. Kept here (not in the
   *  list's local state) so a project chat opened from it, and that
   *  chat's terminal, return to the sheet. */
  projectsOpen: boolean;
  setProjectsOpen: (open: boolean) => void;
  /** Open a project group's chat, adding its row if the list lacks it. */
  openGroupChat: (
    group: Pick<ProjectGroup, "id" | "name" | "memberCount"> & { color?: string | null }
  ) => void;
  /** Newest message per group id (Projects sheet line two). Null = none. */
  groupPreviews: Record<string, GroupPreview | null>;
  /** Re-read each group's newest message (`messages?limit=1`) on Zen's
   *  server; also refreshes its group last-at, which drives order and
   *  unread. */
  refreshGroupPreviews: (groupIds: string[]) => Promise<void>;
  /** Bumped when a project chat is marked seen (the badge re-reads). */
  groupSeenRev: number;
  /** The open project chat is on screen: its messages up to `lastAt` are seen. */
  markGroupSeen: (groupId: string, lastAt?: number | null) => void;
  /** The page of the open Thread older than its oldest message (one at a
   *  time). "loaded": it landed (maybe empty); "failed": the server did
   *  not give it; "skipped": nothing to do (none left, one in flight, a
   *  project chat, or the chat changed meanwhile). */
  loadEarlier: () => Promise<LoadEarlierResult>;
  /** Send `text` to the open Thread. Optimistic: an outbox bubble shows
   *  "Sending…" at once, then gives way to the server's item, or turns
   *  "Not sent". `localId` sends an entry `queueOutgoing` already made
   *  (ThreadPane, after its uploads). Resolves true once delivered. */
  sendThread: (text: string, opts?: { localId?: string }) => Promise<boolean>;
  /** Optimistic outgoing bubbles, every room (`OutgoingMessage.roomKey`).
   *  In memory only; a failed one stays until retried or put back. */
  outbox: OutgoingMessage[];
  /** Sends that landed after their outbox entry went: `landedKey(room,
   *  server id)` → the send's `localId`. ThreadPane keys the delivered
   *  row by it, so the bubble is the same element from tap to delivered. */
  landedKeys: Record<string, string>;
  /** Add a "Sending…" bubble for the open room; returns its temp id. */
  queueOutgoing: (input: {
    text: string;
    files?: File[];
    attachWorkspace?: string | null;
    attachDir?: string | null;
  }) => string;
  patchOutgoing: (localId: string, patch: Partial<OutgoingMessage>) => void;
  dropOutgoing: (localId: string) => void;
  answerChoice: (messageId: string, option: string) => Promise<void>;
  ingestThreadRaw: (raw: ThreadItem) => void;
  refreshOpenThread: () => Promise<void>;
  /** Last-message unix seconds, keyed `t:<addr>` / `g:<groupId>`. Null = fetched empty. */
  lastAtByKey: Record<string, number | null>;
  ensureLastAt: (key: string) => void;
  /** Line-two snippet per `lastAtKey` (`<serverId>|t:<addr>`), the same
   *  item as its `lastAtByKey`. Undefined = not read yet; null = the
   *  Thread has no messages. Seeded from this device's cache, so a cold
   *  launch draws at once. */
  previewByKey: Record<string, RowLast | null>;
  /** Re-read row snippets on Zen's server: one batched `thread/latest`
   *  (pure reads; no session wakes, no seen marks, no overlay socket). Per
   *  addr at most every ~30 s unless `force`. No `addrs` = every row
   *  already shown, and only on a server with `thread-latest`. */
  refreshThreadPreviews: (opts?: { addrs?: string[]; force?: boolean }) => Promise<void>;
  /** Home rows from ANOTHER server (S3b, HM3): seed their snippets from
   *  this device's per-server cache (`<hostKey>|<addr>`), then — when
   *  `fetch` and that server lists `thread-latest` — one batched
   *  `thread/latest` on THAT server's scope (never the active one, never
   *  N per-row GETs). Per addr at most every ~30 s. */
  refreshRemotePreviews: (serverId: string, addrs: string[], opts?: { fetch?: boolean }) => Promise<void>;
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
  /** Agents-list Rearrange: the list now shows these row ids (unpinned
   *  main chats) in this order. One `POST /cli/projects/reorder` with the
   *  FULL project order (desktop's Agents-nav drag): the shown rows take
   *  each other's slots; pins and rows not shown keep theirs. Optimistic;
   *  rolls back with `pinError` on failure. */
  reorderRows: (ids: string[]) => Promise<void>;
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
  /** Multi-server rooms (MS21–MS23): open a row on `serverId` WITHOUT
   *  changing the active server. Zen's scope moves to that server (hot cap
   *  1: the previous room's sockets close and re-dial there); the active
   *  server's list is kept and comes back on Back. `seed` paints the row
   *  at once (the merged list's cached rows for that server). */
  openRoom: (
    serverId: string,
    target: { id?: string | null; seed?: StubAgent[] }
  ) => Promise<void>;
  /** Move Zen onto `serverId` (sync, nothing loaded): a room on another
   *  server, or — null / the active id — back to the active server's
   *  list (restored as it was). Deep links call this before they load. */
  enterRoomServer: (serverId: string | null, seed?: StubAgent[]) => void;
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
  /** A project chat's folder for the Files tree and its links: the PoC
   *  member's workspace path (FilePane reads it from `project-group/show`).
   *  Cleared on every chat change. */
  groupRoot: string | null;
  setGroupRoot: (root: string | null) => void;
  /** A rename moved `from` to `to`: open tabs and listed files follow. */
  retargetFiles: (from: string, to: string) => void;
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

/** Agents-list row id for a project group. */
export function groupRowId(groupId: string): string {
  return `group:${groupId}`;
}

// Row snippets: per-key last read (throttle), the addrs waiting for the
// next batched read (per server), and which servers' cached snippets were
// already seeded. Keys are `lastAtKey`s, so two servers never mix (MA6).
export const PREVIEW_REFRESH_MS = 30_000;
const previewFetchedAt = new Map<string, number>();
const previewPending = serverMemory(() => ({ addrs: new Set<string>(), queued: false }));
const previewSeeded = new Set<string>();

/** Tests only. */
export function resetThreadPreviewQueue(): void {
  previewFetchedAt.clear();
  previewPending.clear();
  previewSeeded.clear();
}

type PreviewSlice = Pick<ZenState, "lastAtByKey" | "previewByKey">;

/** Merge snippets for `scope`'s rows. `event`: the phone holds the full
 *  message (open Thread), so it may replace a flat preview of the same
 *  item. Unchanged items keep the same objects (no re-render). Changed
 *  ones are cached on this device under the server's host key. */
function applyRowLasts(
  s: PreviewSlice,
  scope: ServerScope,
  entries: Iterable<[string, RowLast | null]>,
  event: boolean
): PreviewSlice {
  let previewByKey = s.previewByKey;
  let lastAtByKey = s.lastAtByKey;
  const changed: Record<string, RowLast | null> = {};
  for (const [addr, last] of entries) {
    const key = lastAtKey(scope.id, "thread", addr);
    const cur = s.previewByKey[key];
    const richer = event && !!cur?.flat && !!last && !last.flat;
    if (sameRowLast(cur, last) && !richer) continue;
    if (previewByKey === s.previewByKey) previewByKey = { ...s.previewByKey };
    if (lastAtByKey === s.lastAtByKey) lastAtByKey = { ...s.lastAtByKey };
    previewByKey[key] = last;
    lastAtByKey[key] = last?.at ?? (event ? s.lastAtByKey[key] ?? null : null);
    changed[addr] = last;
  }
  if (Object.keys(changed).length && scope.hostKey) writeRowPreviews(scope.hostKey, changed);
  return { previewByKey, lastAtByKey };
}

/** The open Thread's newest message is that row's snippet now. */
function threadRowPatch(
  s: PreviewSlice,
  scope: ServerScope,
  addr: string,
  m: ThreadMessage | undefined
): PreviewSlice {
  if (!m) {
    const key = lastAtKey(scope.id, "thread", addr);
    return { previewByKey: s.previewByKey, lastAtByKey: { ...s.lastAtByKey, [key]: s.lastAtByKey[key] ?? null } };
  }
  return applyRowLasts(s, scope, [[addr, rowLastFromMessage(m, addr, scope.username())]], true);
}

/** Projects sheet open, kept for a reload of a project chat's terminal. */
const PROJECTS_OPEN_KEY = "k2-zen-projects-open";

function readProjectsOpen(): boolean {
  try {
    return sessionStorage.getItem(PROJECTS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeProjectsOpen(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(PROJECTS_OPEN_KEY, "1");
    else sessionStorage.removeItem(PROJECTS_OPEN_KEY);
  } catch {
    /* private mode */
  }
}

// Rooms (MS21): while a room is open on another server, the store holds
// THAT server's rows (the room's header, drawer and terminal read them).
// The active server's list is parked here and put back on Back, so the
// list never flashes another server's rows or reloads from scratch.
type ListSlice = Pick<
  ZenState,
  | "agentSource"
  | "agents"
  | "agentError"
  | "serverProjects"
  | "pinnedIds"
  | "chatSessions"
  | "activity"
  | "focus"
  | "focusGroupsEnabled"
  | "hiddenSidecarAddrs"
  | "fileSource"
  | "fileError"
>;
let listSlice: { serverId: string; state: ListSlice } | null = null;

// The chat cache (`chatCache`, stale-while-revalidate): the newest
// messages of every chat this phone read, per room (server + addr / group),
// in memory and on the device. Opening a chat paints its cached copy at
// once (memory synchronously, else the device store as soon as it
// answers), then the server read is merged over it. A chat on a server
// that is down keeps showing it (auto reconnect; the banner says why).
installChatCacheWiring();

// Live frames that land while a Thread read runs: newer than that read's
// page, they stay when it is merged (everything else newer is gone).
const liveWatches = new Set<Set<string>>();

/** Collect the ids of live frames from now until `stop`. */
function watchLive(): { ids: Set<string>; stop: () => void } {
  const ids = new Set<string>();
  liveWatches.add(ids);
  return { ids, stop: () => void liveWatches.delete(ids) };
}

/** The pool already counts this server as down (auto reconnect). */
function knownDown(serverId: string): boolean {
  return !!serverId && serverDown(serverId, pool.entry(serverId));
}

/** The cached copy of a room, from memory (synchronous). */
function cachedRoom(key: string): CachedChat | null {
  return chatCache().peek(key);
}

/** A Thread read failed: when the server did not answer, its cached copy
 *  (the banner says it is reconnecting), else nothing. */
function unreachableFallback(serverId: string, addr: string, error: string | null): ThreadMessage[] {
  if (!looksUnreachable(error)) return [];
  return cachedRoom(threadRoomKey(serverId, null, addr))?.messages ?? [];
}

/** The room key a resumed chat (`hydrateAgents({resumeId})`) opens. */
function resumeRoomKey(serverId: string, row: StubAgent | undefined, resumeId: string): string {
  if (row?.kind === "group" && row.groupId) return threadRoomKey(serverId, row.groupId, null);
  if (row?.addr) return threadRoomKey(serverId, null, row.addr);
  if (resumeId.startsWith("group:")) return threadRoomKey(serverId, resumeId.slice(6), null);
  return threadRoomKey(serverId, null, resumeId);
}

/** What a cached paint puts on screen. */
function cachedPatch(e: CachedChat): Partial<ZenState> {
  return {
    thread: e.messages,
    threadCached: true,
    threadSource: "live",
    threadError: null,
    threadConversationId: e.conversationId,
    threadHasMore: e.hasMore,
    threadOldestSeq: oldestSeqOf(e.messages),
  };
}

type CacheFrom = "memory" | "device";

/** Is the cached copy of the chat being opened known to be behind the
 *  server (and can a delta bring it up to date)? `returnHold`. */
function staleOnServer(
  scope: ServerScope,
  ref: RowRef,
  entry: CachedChat
): boolean {
  if (!deltaSupported(scope)) return false;
  const u = useUnreadStore.getState();
  const unread = entryForRow(u.servers[scope.id], u.addrs[scope.id], ref);
  const preview =
    ref.kind === "thread" && ref.addr
      ? useZenStore.getState().previewByKey[lastAtKey(scope.id, "thread", ref.addr)]?.seq
      : null;
  return holdFirstPaint({
    delta: true,
    kind: ref.kind,
    cache: { messages: entry.messages, conversationId: ref.kind === "project" ? null : entry.conversationId },
    serverNewest: knownServerNewest(unread?.lastSeq, preview),
  });
}

/** An open's first paint of its cached copy: at once — or, when the copy
 *  is known to be behind (`stale`), held up to `RETURN_HOLD_MS` for the
 *  read. `take()` hands the held copy to the read's own (single) update;
 *  `release()` paints it now (the hold ran out, the read failed). */
type CachePainter = {
  offer: (entry: CachedChat, from: CacheFrom) => void;
  paintNow: (entry: CachedChat, from: CacheFrom) => void;
  take: () => { entry: CachedChat; from: CacheFrom } | null;
  release: () => void;
};

function cachePainter(
  gen: number,
  timing: number,
  stale: (e: CachedChat) => boolean,
  patch: (e: CachedChat) => Partial<ZenState> = cachedPatch
): CachePainter {
  const { getState: get, setState: set } = useZenStore;
  let held: { entry: CachedChat; from: CacheFrom } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const paintNow = (entry: CachedChat, from: CacheFrom) => {
    if (get().threadGen !== gen) return;
    set({ ...patch(entry), threadHolding: false });
    noteCachedPaint(timing, from, entry.messages.length);
  };
  const take = () => {
    clear();
    const h = held;
    held = null;
    if (h && get().threadGen === gen && get().threadSource !== "loading") return null;
    return h;
  };
  const release = () => {
    const h = take();
    if (h) paintNow(h.entry, h.from);
    else if (get().threadGen === gen && get().threadHolding) set({ threadHolding: false });
  };
  return {
    offer(entry, from) {
      if (get().threadGen !== gen) return;
      if (!held && stale(entry)) {
        held = { entry, from };
        set({ threadHolding: true });
        timer = setTimeout(release, RETURN_HOLD_MS);
        return;
      }
      paintNow(entry, from);
    },
    paintNow,
    take,
    release,
  };
}

/** Nothing cached in memory: ask the device store, and paint its copy if
 *  this open is still loading when it answers (through `painter`: it may
 *  hold it for the read). Resolves to the copy (the delta cursor), or null. */
async function deviceCopy(
  key: string,
  gen: number,
  timing: number,
  painter?: CachePainter
): Promise<CachedChat | null> {
  let hit: Awaited<ReturnType<ReturnType<typeof chatCache>["read"]>> = null;
  try {
    hit = await chatCache().read(key);
  } catch {
    hit = null;
  }
  const { getState: get, setState: set } = useZenStore;
  if (!hit || get().threadGen !== gen) return hit?.entry ?? null;
  const st = get();
  // Still loading — or the read already failed for want of a server
  // (nothing on screen): the cached copy is better than nothing.
  const down = st.threadSource === "error" && !st.thread.length && looksUnreachable(st.threadError);
  if (st.threadSource !== "loading" && !down) return hit.entry;
  if (painter && !down) {
    painter.offer(hit.entry, hit.from);
    return hit.entry;
  }
  set(cachedPatch(hit.entry));
  noteCachedPaint(timing, hit.from, hit.entry.messages.length);
  return hit.entry;
}

function paintFromDevice(key: string, gen: number, timing: number): void {
  void deviceCopy(key, gen, timing);
}

/** A read's outcome in the open's timing record. */
function noteRead(timing: number, read: ChatRead): void {
  if (!read.ok) {
    noteResponse(timing, { ok: false, error: read.error });
    return;
  }
  noteResponse(timing, {
    ok: true,
    mode: read.mode,
    items: read.counts.items,
    changed: read.counts.changed,
    removed: read.counts.removed,
    bytes: read.bytes,
  });
}

/**
 * After a Thread read of the open chat: when it was a delta and the newest
 * window holds files, one throttled background plain read (the newest
 * page) so chip states (ok / changed / gone) catch up — a file edit never
 * lands in a delta's `changed` (`attachmentRefresh`). Merged with the
 * usual "server wins in its window" rule: rows keep their objects unless
 * a chip changed, so nothing scrolls or glides. Not an open (no timing
 * record) and no read marking: only the rows and their previews.
 */
function maybeRefreshAttachments(
  scope: ServerScope,
  addr: string,
  key: string,
  mode: ReadMode
): void {
  const { getState: get, setState: set } = useZenStore;
  if (!attachRefreshDue(key, mode, get().thread)) return;
  const gen = get().threadGen;
  const still = () => get().threadGen === gen && get().threadAddr === addr && !get().threadGroupId;
  void (async () => {
    const live = watchLive();
    try {
      const prevConv = get().threadConversationId;
      const read = await fetchThreadRead(scope, addr, null).finally(live.stop);
      if (!still() || !read.ok) return;
      // The conversation moved: the next revalidation resets it properly.
      if (read.conversationId && prevConv && read.conversationId !== prevConv) return;
      const cur = get().thread;
      const thread = applyThreadRead(cur, read, { arrivedLive: live.ids, conversationId: prevConv });
      if (thread === cur) return;
      set({
        thread,
        threadOldestSeq: oldestSeqOf(thread) ?? get().threadOldestSeq,
        ...threadRowPatch(get(), scope, addr, thread[thread.length - 1]),
      });
    } catch {
      live.stop();
      /* keep what is on screen */
    }
  })();
}

function captureList(s: ZenState): ListSlice {
  return {
    agentSource: s.agentSource,
    agents: s.agents,
    agentError: s.agentError,
    serverProjects: s.serverProjects,
    pinnedIds: s.pinnedIds,
    chatSessions: s.chatSessions,
    activity: s.activity,
    focus: s.focus,
    focusGroupsEnabled: s.focusGroupsEnabled,
    hiddenSidecarAddrs: s.hiddenSidecarAddrs,
    fileSource: s.fileSource,
    fileError: s.fileError,
  };
}

function activeId(): string | null {
  const st = useServersStore.getState();
  return st.servers.some((x) => x.id === st.activeServerId) ? st.activeServerId : null;
}

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
  // A room on a removed / re-keyed server closes; it never falls back to
  // another server's data (MS7).
  if (roomServerId() === id) useZenStore.getState().closeChat();
  if (listSlice?.serverId === id) listSlice = null;
});

// The active server changed under an open room: the parked list is stale,
// and a room on the new active server is simply Zen on it.
useServersStore.subscribe((st, prev) => {
  if (st.activeServerId === prev.activeServerId) return;
  listSlice = null;
  if (roomServerId() && roomServerId() === st.activeServerId) setRoomServer(null);
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
  threadCached: false,
  threadHolding: false,
  threadGen: 0,
  threadAddr: null,
  threadGroupId: null,
  threadConversationId: null,
  threadHasMore: false,
  threadOldestSeq: null,
  threadLoadingEarlier: false,
  threadFocusSeq: null,
  sending: false,
  sendError: null,
  outbox: [],
  landedKeys: {},
  answeringId: null,
  answerError: null,
  answerErrorId: null,
  lastAtByKey: {},
  previewByKey: {},
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
  reorderRows: async (ids) => {
    const s = get();
    const visible: string[] = [];
    for (const id of ids) {
      const pid = pinProjectIdForRow(s.agents.find((a) => a.id === id), s.serverProjects);
      if (pid && !visible.includes(pid)) visible.push(pid);
    }
    if (visible.length < 2) return;
    const current = fullProjectOrder(s.serverProjects, []);
    const order = fullProjectOrder(s.serverProjects, visible);
    if (order.join("\n") === current.join("\n")) return;
    await writePins(withOrder(s.serverProjects, order), "Could not reorder", async (scope) => {
      const r = await reorderProjects(scope, order);
      if (!r.ok) throw r.error || "Could not reorder";
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
    // Row snippets ride the list's poll, throttled to ~30 s.
    void get().refreshThreadPreviews().catch(() => {});
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
        const prev = get().activity;
        if (!sameActivity(prev, next)) {
          set({ activity: next });
          // A turn ended: that agent likely just wrote. Re-read its snippet.
          const sessions = get().chatSessions;
          const done = get()
            .agents.filter(
              (a) =>
                a.kind !== "group" &&
                a.addr &&
                activityForRow(a, prev, false, sessions) &&
                !activityForRow(a, next, false, sessions)
            )
            .map((a) => a.addr as string);
          if (done.length) void get().refreshThreadPreviews({ addrs: done, force: true });
        }
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
  refreshThreadPreviews: async (opts) => {
    if (get().agentSource !== "live") return;
    const scope = zenScope();
    if (!scope.id) return;
    if (!previewSeeded.has(scope.id)) {
      // First read on this server: its cached snippets, at once.
      previewSeeded.add(scope.id);
      const cached = scope.hostKey ? readRowPreviews(scope.hostKey) : {};
      const previewByKey = { ...get().previewByKey };
      const lastAtByKey = { ...get().lastAtByKey };
      for (const [addr, last] of Object.entries(cached)) {
        const key = lastAtKey(scope.id, "thread", addr);
        if (previewByKey[key] === undefined) previewByKey[key] = last;
        lastAtByKey[key] = lastAtByKey[key] ?? last?.at ?? null;
      }
      set({ previewByKey, lastAtByKey });
    }
    let addrs = opts?.addrs;
    if (!addrs) {
      // The sweep: one call for every row on screen, never N per-row GETs.
      addrs = Object.keys(get().previewByKey)
        .map((k) => parseLastAtKey(k))
        .filter((k) => k?.serverId === scope.id && k.kind === "thread")
        .map((k) => k!.id);
      if (!addrs.length) return;
      try {
        if (!(await serverHasFeature(scope, FEATURE_THREAD_LATEST))) return;
      } catch {
        return;
      }
    }
    const pending = previewPending.get(scope.id);
    const now = Date.now();
    for (const addr of addrs) {
      if (!addr) continue;
      const key = lastAtKey(scope.id, "thread", addr);
      const at = previewFetchedAt.get(key);
      if (!opts?.force && at != null && now - at < PREVIEW_REFRESH_MS) continue;
      previewFetchedAt.set(key, now);
      pending.addrs.add(addr);
    }
    if (!pending.addrs.size || pending.queued) return;
    // Every row observed in this tick rides the same request.
    pending.queued = true;
    await Promise.resolve();
    pending.queued = false;
    const batch = [...pending.addrs];
    pending.addrs.clear();
    if (!batch.length) return;
    try {
      const { lasts } = await fetchThreadLasts(scope, batch, scope.username());
      const next = applyRowLasts(get(), scope, lasts, false);
      if (next.previewByKey !== get().previewByKey) set(next);
    } catch {
      // Keep what is on screen; the next visibility or sweep asks again.
      for (const addr of batch) previewFetchedAt.delete(lastAtKey(scope.id, "thread", addr));
    }
  },
  refreshRemotePreviews: async (serverId, addrs, opts) => {
    let scope: ServerScope;
    try {
      scope = scopeFor(serverId);
    } catch {
      return; // removed: never another server's snippets
    }
    if (!scope.id) return;
    if (!previewSeeded.has(scope.id)) {
      previewSeeded.add(scope.id);
      const cached = scope.hostKey ? readRowPreviews(scope.hostKey) : {};
      if (Object.keys(cached).length) {
        const previewByKey = { ...get().previewByKey };
        const lastAtByKey = { ...get().lastAtByKey };
        for (const [addr, last] of Object.entries(cached)) {
          const key = lastAtKey(scope.id, "thread", addr);
          if (previewByKey[key] === undefined) previewByKey[key] = last;
          lastAtByKey[key] = lastAtByKey[key] ?? last?.at ?? null;
        }
        set({ previewByKey, lastAtByKey });
      }
    }
    if (!opts?.fetch || !scope.supports(FEATURE_THREAD_LATEST)) return;
    const now = Date.now();
    const batch: string[] = [];
    for (const addr of new Set(addrs.map((a) => a.trim()).filter(Boolean))) {
      const key = lastAtKey(scope.id, "thread", addr);
      const at = previewFetchedAt.get(key);
      if (at != null && now - at < PREVIEW_REFRESH_MS) continue;
      previewFetchedAt.set(key, now);
      batch.push(addr);
    }
    if (!batch.length) return;
    try {
      const { lasts } = await fetchThreadLasts(scope, batch, scope.username());
      const next = applyRowLasts(get(), scope, lasts, false);
      if (next.previewByKey !== get().previewByKey) set(next);
    } catch {
      for (const addr of batch) previewFetchedAt.delete(lastAtKey(scope.id, "thread", addr));
    }
  },
  ensureLastAt: (key) => {
    // `key` is a `lastAtKey` (`<serverId>|t:<addr>`): it fetches on its own
    // server's scope (MA6). A Thread row on Zen's server reads its snippet
    // (which carries the time); other servers' rows read the time only.
    const parsed = parseLastAtKey(key);
    if (parsed?.kind === "thread" && parsed.serverId === zenId()) {
      void get().refreshThreadPreviews({ addrs: [parsed.id] });
      return;
    }
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
    let token = "";
    try {
      token = scope.token();
    } catch {
      token = ""; // removed: the forget handler closes the room
    }
    if (!token && roomServerId() === scope.id && scope.id) {
      // A room on another server with no login: never the stub catalogue.
      // The room banner says "Sign in to {server}" with that server's
      // sign-in (MS34, MS36); the thread stays empty.
      set({
        screen: resumeId ? "thread" : "list",
        agentId: resumeId || "",
        agentSource: "error",
        agentError: null,
        threadSource: "error",
        threadError: `Sign in to ${scope.label}`,
        thread: [],
        threadCached: false,
        threadGroupId: null,
      });
      return;
    }
    if (!token) {
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
    // A resumed chat (a room on another server, a cold launch into a
    // chat) shows its cached copy at once — the list reads below come
    // first and may take a while (or fail: auto reconnect).
    const resumeRow = resumeId
      ? get().agents.find((a) => a.id === resumeId) ?? get().agents.find((a) => a.addr === resumeId)
      : undefined;
    const resumeKey = resumeId ? resumeRoomKey(scope.id, resumeRow, resumeId) : "";
    const resumeGroup = resumeKey.includes("|g:") ? resumeKey.slice(resumeKey.indexOf("|g:") + 3) : null;
    const resumeAddr = resumeKey && !resumeGroup ? resumeKey.slice(resumeKey.indexOf("|t:") + 3) : null;
    const resumeTiming = resumeKey
      ? beginChatOpen(scope.id, resumeKey, resumeGroup ? "project" : "thread")
      : 0;
    const cachedEntry = resumeKey ? cachedRoom(resumeKey) : null;
    const cached = cachedEntry?.messages ?? null;
    const cachedAddr = cachedEntry
      ? {
          threadAddr: resumeAddr,
          threadGroupId: resumeGroup,
          threadConversationId: cachedEntry.conversationId,
          threadHasMore: cachedEntry.hasMore,
          threadOldestSeq: oldestSeqOf(cachedEntry.messages),
        }
      : {};
    const resumeGen = resumeKey ? get().threadGen + 1 : get().threadGen;
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
      threadSource: cached ? "live" : "loading",
      threadError: null,
      thread: cached ?? [],
      threadCached: !!cached,
      threadGen: resumeGen,
      threadHolding: false,
      threadGroupId: null,
      threadConversationId: null,
      ...cachedAddr,
    });
    if (cachedEntry) noteCachedPaint(resumeTiming, "memory", cachedEntry.messages.length);
    else if (resumeKey) paintFromDevice(resumeKey, resumeGen, resumeTiming);
    try {
      const [rAgents, rProjects, rGroups, rSessions] = await Promise.all([
        getAgentList(scope),
        getCliProjectsList(scope),
        fetchProjectGroups(scope),
        getAllSessions(scope),
      ]);
      // Notification avatars (iOS Communication Notifications): this
      // server's workspace icons go to the App Group cache. Coalesced,
      // no-op off iOS / without push, never throws.
      if (rProjects.ok) queueServerAvatars(scope.id, rProjects.data);
      // Zen moved to another server (a room opened or closed) meanwhile:
      // this answer is not for what is on screen.
      if (zenId() !== scope.id) return;
      const built = buildServerRows({
        rAgents,
        rProjects,
        rGroups,
        rSessions,
        remembered: readRememberedSidecars(scope.id, { adoptLegacy: true }),
      });
      if (!built.ok) {
        const msg = built.error;
        if (resumeRow?.addr && looksUnreachable(msg)) {
          // The server did not answer while a chat on it opens: keep the
          // chat (its row, its cached Thread) so it can reconnect and its
          // sends can wait (auto reconnect).
          set({
            agentSource: "error",
            agentError: msg,
            threadSource: cached ? "live" : "error",
            threadError: cached ? null : msg,
            thread: cached ?? [],
            threadCached: !!cached,
            threadAddr: resumeRow.addr.trim(),
          });
          return;
        }
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
          threadCached: false,
        });
        return;
      }
      writeRememberedSidecars(scope.id, built.remember);
      const { agents, serverProjects, chatSessions, notices } = built;
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
        // Resuming: the chat's own read (setAgent, next) owns the Thread;
        // a cached copy already on screen stays until it lands.
        ...(resumeId
          ? {}
          : { threadSource: "live" as DataSource, threadError: null, thread: [], threadCached: false }),
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
      if (zenId() !== scope.id) return;
      const msg = e instanceof Error ? e.message : String(e);
      set({
        agentSource: "error",
        fileSource: "error",
        agents: resumeId ? get().agents : [],
        files: resumeId ? get().files : [],
        agentError: msg,
        fileError: msg,
        threadSource: cached ? "live" : resumeId ? "loading" : "error",
        threadError: resumeId ? null : msg,
        thread: cached ?? [],
        threadCached: !!cached,
        screen: resumeId ? "thread" : "list",
        agentId: resumeId || "",
        ...cachedAddr,
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
  groupRoot: null,
  setGroupRoot: (root) => {
    if (get().groupRoot !== root) set({ groupRoot: root });
  },
  retargetFiles: (from, to) => {
    const move = (id: string) =>
      id === from ? to : id.startsWith(`${from}/`) ? `${to}${id.slice(from.length)}` : id;
    const { files, openFileIds, focusId } = get();
    if (!files.some((f) => move(f.id) !== f.id) && !openFileIds.some((x) => move(x) !== x)) return;
    set({
      files: files.map((f) => {
        const id = move(f.id);
        if (id === f.id) return f;
        const name = id.split("/").filter(Boolean).pop() || id;
        return { ...f, id, name, fsPath: f.fsPath ? move(f.fsPath) : f.fsPath };
      }),
      openFileIds: openFileIds.map(move),
      focusId: focusId ? move(focusId) : focusId,
    });
  },

  projectsOpen: readProjectsOpen(),
  setProjectsOpen: (open) => {
    writeProjectsOpen(open);
    if (get().projectsOpen !== open) set({ projectsOpen: open });
  },
  groupPreviews: {},
  refreshGroupPreviews: async (groupIds) => {
    const scope = zenScope();
    const ids = [...new Set(groupIds.map((x) => x.trim()).filter(Boolean))];
    const got = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await fetchProjectGroupMessages(scope, id, { limit: 1 });
          if (!r.ok) return null;
          const m = r.data?.messages?.[r.data.messages.length - 1];
          const p: GroupPreview | null =
            m && Number.isFinite(m.createdAt)
              ? { at: m.createdAt, author: m.author || "", body: m.body || "" }
              : null;
          return [id, p] as const;
        } catch {
          return null;
        }
      })
    );
    if (zenId() !== scope.id) return;
    const previews = { ...get().groupPreviews };
    const lastAtByKey = { ...get().lastAtByKey };
    for (const hit of got) {
      if (!hit) continue;
      const [id, p] = hit;
      previews[id] = p;
      lastAtByKey[lastAtKey(scope.id, "group", id)] = p?.at ?? null;
    }
    set({ groupPreviews: previews, lastAtByKey });
    // A chat open right now stays seen.
    const open = (get().threadGroupId || "").trim();
    if (open && get().screen === "thread" && ids.includes(open)) {
      get().markGroupSeen(open, previews[open]?.at ?? null);
    }
  },
  groupSeenRev: 0,
  markGroupSeen: (groupId, lastAt) => {
    markGroupSeenAt(zenId() || null, groupId, lastAt);
    set({ groupSeenRev: get().groupSeenRev + 1 });
  },
  openGroupChat: (group) => {
    const id = groupRowId(group.id);
    if (!get().agents.some((a) => a.id === id)) {
      set({ agents: [groupAgentRow(group), ...get().agents] });
    }
    get().setAgent(id);
  },

  hydrateGroupFiles: async (groupId, opts) => {
    const gen = get().filesGen + 1;
    if (opts?.refresh && get().fileSource === "live") {
      set({ filesGen: gen });
    } else {
      set({ filesGen: gen, files: keepOpenFiles(get()), fileError: null, fileSource: "loading" });
    }
    const apply = (patch: () => Partial<ZenState>) => {
      if (get().filesGen !== gen) return;
      set(patch());
    };
    try {
      const r = await fetchProjectGroupResources(zenScope(), groupId);
      // No resources route on this server: nothing pinned to show.
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
      const rows = parseGroupResources(r.data);
      apply(() => noResources(mergeResources(rows ?? [], get())));
    } catch (e) {
      apply(() =>
        failFiles(e instanceof Error ? e.message : String(e), keepOpenFiles(get()))
      );
    }
  },

  hydrateGroup: async (groupId) => {
    const gen = get().threadGen + 1;
    const scope = zenScope();
    const key = threadRoomKey(scope.id, groupId, null);
    const timing = beginChatOpen(scope.id, key, "project");
    // Its cached copy at once (stale-while-revalidate); the read below
    // brings it up to date (a delta when the server has one).
    const hit = cachedRoom(key);
    const groupPatch = (e: CachedChat): Partial<ZenState> => ({ ...cachedPatch(e), threadConversationId: null });
    // Known to be behind (unread `lastSeq`) with a delta to fetch: hold
    // the first paint briefly for the read (`returnHold`).
    const before = get();
    const shown = before.threadGroupId === groupId && before.thread.length > 0 && before.threadSource === "live";
    const stale = (e: CachedChat) => !shown && staleOnServer(scope, { kind: "project", groupId }, e);
    const painter = cachePainter(gen, timing, stale, groupPatch);
    const holdHit = !!hit && stale(hit);
    set({
      threadGen: gen,
      thread: [],
      threadCached: false,
      threadHolding: false,
      threadError: null,
      threadSource: "loading",
      threadAddr: null,
      threadGroupId: groupId,
      threadConversationId: null,
      threadHasMore: false,
      threadOldestSeq: null,
      ...(hit && !holdHit ? groupPatch(hit) : null),
    });
    if (hit && holdHit) painter.offer(hit, "memory");
    else if (hit) noteCachedPaint(timing, "memory", hit.messages.length);
    const failed = (msg: string, gone: boolean) => {
      if (!gone) painter.release();
      else if (painter.take() || get().threadHolding) set({ threadHolding: false });
      if (gone) {
        // The project (or access to it) is gone: so is its cache.
        chatCache().forget(key);
        set({ threadSource: "error", thread: [], threadCached: false, threadError: msg });
        return;
      }
      if (get().threadCached) {
        // The cached copy stays readable. A server already known to be
        // down: the banner says why. Otherwise the failure is reported.
        if (!knownDown(scope.id)) set({ threadSource: "error", threadError: msg });
        return;
      }
      set({ threadSource: "error", thread: [], threadCached: false, threadError: msg });
    };
    try {
      // The device copy (the delta cursor) when there may be one; known
      // absent: the read goes out at once.
      const pending =
        hit || chatCache().known(key) === false ? null : deviceCopy(key, gen, timing, painter);
      const base = pending ? await pending : hit;
      if (get().threadGen !== gen) return;
      const read = await fetchGroupRead(scope, groupId, base);
      if (get().threadGen !== gen) return;
      noteRead(timing, read);
      if (!read.ok) {
        failed(read.error, read.gone);
        return;
      }
      // The read beat the hold: the merged copy is the first paint.
      const held = painter.take();
      if (held) noteCachedPaint(timing, held.from, held.entry.messages.length);
      const items = applyGroupRead(held ? held.entry.messages : get().thread, read);
      const lastAt = items[items.length - 1]?.at ?? null;
      if (!items.length) chatCache().forget(key);
      set({
        threadHolding: false,
        threadSource: "live",
        thread: items,
        threadCached: false,
        threadError: null,
        threadHasMore: read.hasMore ?? (held ? held.entry.hasMore : get().threadHasMore),
        threadOldestSeq: items.length ? 0 : null,
        lastAtByKey: { ...get().lastAtByKey, [lastAtKey(scope.id, "group", groupId)]: lastAt },
      });
      notePaintAfterResponse(timing);
      get().markGroupSeen(groupId, lastAt);
    } catch (e) {
      if (get().threadGen !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      noteResponse(timing, { ok: false, error: msg });
      failed(msg, false);
    }
  },

  hydrateThread: async (addr) => {
    if (get().agentSource === "stub") {
      set({
        threadSource: "stub",
        threadError: null,
        thread: stubThread(addr),
        threadCached: false,
        threadAddr: addr,
        threadGroupId: null,
        threadConversationId: null,
        threadHasMore: false,
        threadOldestSeq: null,
      });
      return;
    }
    const gen = get().threadGen + 1;
    const scope = zenScope();
    const key = threadRoomKey(scope.id, null, addr);
    const timing = beginChatOpen(scope.id, key, "thread");
    // Its cached copy at once (stale-while-revalidate): from memory now,
    // else from the device store when it answers. The read below brings
    // it up to date — a delta from its newest seq when the server has
    // `thread-delta-v1`, else the newest page merged over it (a server
    // that is down leaves it on screen).
    const hit = cachedRoom(key);
    // Known to be behind the server (unread / list `latest`) with a delta
    // to fetch: hold the first paint briefly for the read (`returnHold`).
    // Not when this chat's copy is already on screen (a resume painted it).
    const before = get();
    const shown =
      before.threadAddr === addr && !before.threadGroupId && before.thread.length > 0 && before.threadSource === "live";
    const stale = (e: CachedChat) => !shown && staleOnServer(scope, { kind: "thread", addr }, e);
    const painter = cachePainter(gen, timing, stale);
    const holdHit = !!hit && stale(hit);
    set({
      threadGen: gen,
      thread: [],
      threadCached: false,
      threadHolding: false,
      threadError: null,
      threadSource: "loading",
      threadAddr: addr,
      threadGroupId: null,
      threadConversationId: null,
      threadHasMore: false,
      threadOldestSeq: null,
      ...(hit && !holdHit ? cachedPatch(hit) : null),
    });
    if (hit && holdHit) painter.offer(hit, "memory");
    else if (hit) noteCachedPaint(timing, "memory", hit.messages.length);
    const failed = (msg: string, gone: boolean) => {
      // A held first paint: the cached copy shows now.
      if (!gone) painter.release();
      else if (painter.take() || get().threadHolding) set({ threadHolding: false });
      if (gone) {
        // The access or the conversation is gone: so is its cache. The
        // error shows as it always has.
        chatCache().forget(key);
        if (get().threadCached) set({ thread: [], threadCached: false });
      }
      if (get().threadCached) {
        // The cached copy stays readable. A server already known to be
        // down: the banner says why. Otherwise the failure is reported
        // (recovery watches for it) with the copy still on screen.
        if (!knownDown(scope.id)) set({ threadSource: "error", threadError: msg });
        return;
      }
      set({
        threadSource: "error",
        // The server did not answer: what was read before stays readable.
        thread: gone ? [] : unreachableFallback(scope.id, addr, msg),
        threadError: msg,
      });
    };
    const live = watchLive();
    try {
      // The device copy (the delta cursor) when there may be one; known
      // absent: the read goes out at once.
      const pending =
        hit || chatCache().known(key) === false ? null : deviceCopy(key, gen, timing, painter);
      const base = pending ? await pending : hit;
      if (get().threadGen !== gen) return;
      const read = await fetchThreadRead(scope, addr, base).finally(live.stop);
      if (get().threadGen !== gen) return;
      noteRead(timing, read);
      if (!read.ok) {
        failed(read.error, read.gone);
        return;
      }
      if (read.mode === "reset") chatCache().forget(key); // the conversation moved
      // The read beat the hold: the merged copy is the first paint (one
      // update, at the bottom, nothing to animate).
      const held = painter.take();
      if (held) noteCachedPaint(timing, held.from, held.entry.messages.length);
      const cur = held ? { ...get(), ...cachedPatch(held.entry) } : get();
      const thread = applyThreadRead(cur.thread as ThreadMessage[], read, {
        arrivedLive: live.ids,
        conversationId: cur.threadConversationId ?? null,
      });
      if (!thread.length) chatCache().forget(key);
      const last = thread[thread.length - 1];
      set({
        threadHolding: false,
        threadSource: "live",
        thread,
        threadCached: false,
        threadError: null,
        threadConversationId: read.conversationId ?? cur.threadConversationId ?? null,
        threadHasMore: read.hasMore ?? cur.threadHasMore ?? false,
        threadOldestSeq: oldestSeqOf(thread),
        ...threadRowPatch(get(), scope, addr, last),
      });
      notePaintAfterResponse(timing);
      maybeRefreshAttachments(scope, addr, key, read.mode);
    } catch (e) {
      live.stop();
      if (get().threadGen !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      noteResponse(timing, { ok: false, error: msg });
      failed(msg, false);
    }
  },

  loadEarlier: async () => {
    const { threadAddr, threadOldestSeq, threadHasMore, threadLoadingEarlier, agentSource } =
      get();
    if (agentSource === "stub") return "skipped";
    if (!threadAddr || threadOldestSeq == null || !threadHasMore || threadLoadingEarlier) {
      return "skipped";
    }
    const gen = get().threadGen;
    set({ threadLoadingEarlier: true });
    const scope = zenScope();
    const username = scope.username();
    try {
      const r = await getThread(scope, threadAddr, 50, threadOldestSeq);
      // Another chat opened meanwhile: this page is not its; the one-at-a-
      // time flag must not stay up for it.
      if (get().threadGen !== gen) {
        set({ threadLoadingEarlier: false });
        return "skipped";
      }
      if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
        set({ threadLoadingEarlier: false });
        return "failed";
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
      return "loaded";
    } catch {
      set({ threadLoadingEarlier: false });
      return get().threadGen !== gen ? "skipped" : "failed";
    }
  },

  queueOutgoing: ({ text, files = [], attachWorkspace = null, attachDir = null }) => {
    const s = get();
    const localId = newLocalId();
    const entry: OutgoingMessage = {
      localId,
      roomKey: threadRoomKey(zenScope().id, s.threadGroupId, s.threadAddr),
      text,
      files,
      paths: files.map(() => null),
      attachWorkspace,
      attachDir,
      status: "sending",
      error: null,
      at: Date.now() / 1000,
      beforeIds: s.thread.map((m) => m.id),
      body: null,
      serverId: null,
    };
    set({ outbox: [...s.outbox, entry] });
    return localId;
  },

  patchOutgoing: (localId, patch) => {
    const outbox = get().outbox;
    if (!outbox.some((o) => o.localId === localId)) return;
    set({ outbox: outbox.map((o) => (o.localId === localId ? { ...o, ...patch } : o)) });
  },

  dropOutgoing: (localId) => {
    const outbox = get().outbox;
    if (!outbox.some((o) => o.localId === localId)) return;
    set({ outbox: outbox.filter((o) => o.localId !== localId) });
  },

  sendThread: async (text, opts) => {
    const trimmed = text.trim();
    const given = opts?.localId;
    if (!trimmed) {
      if (given) get().dropOutgoing(given);
      return false;
    }
    const scope = zenScope();
    const groupId = (get().threadGroupId || "").trim();
    const addr = get().threadAddr;
    const gen = get().threadGen;
    // "Not sent": the bubble stays (retry / put back); this room's label
    // gets the reason. A send that landed anyway (echo) is just done.
    const outboxWithout = (id: string) => get().outbox.filter((o) => o.localId !== id);
    const fail = (id: string, error: string): boolean => {
      const entry = get().outbox.find((o) => o.localId === id);
      const here = get().threadGen === gen;
      const landed = entry && here ? landedId(entry, get().thread) : null;
      if (entry && landed) {
        set({
          sending: false,
          sendError: null,
          outbox: outboxWithout(id),
          landedKeys: rememberLanded(get().landedKeys, entry.roomKey, landed, id),
        });
        return true;
      }
      get().patchOutgoing(id, { status: "failed", error });
      if (here) set({ sending: false, sendError: error });
      return false;
    };
    let localId = given;
    if (localId) {
      const entry = get().outbox.find((o) => o.localId === localId);
      if (!entry) return false;
      // Typed in a room that is no longer open (uploads outlived it):
      // never post it somewhere else.
      if (entry.roomKey !== threadRoomKey(scope.id, groupId, addr)) {
        get().patchOutgoing(localId, { status: "failed", error: "Not sent" });
        return false;
      }
      get().patchOutgoing(localId, { status: "sending", error: null, body: trimmed });
    }
    if (get().agentSource === "stub" || get().threadSource === "stub") {
      const error = "STUB — Cannot send — POST /cli/thread/post not proven";
      if (localId) get().patchOutgoing(localId, { status: "failed", error });
      set({ sendError: error });
      return false;
    }
    if (!groupId && !isSendableAddr(addr)) {
      const error = get().threadError || "Not chattable";
      if (localId) get().patchOutgoing(localId, { status: "failed", error });
      set({ sendError: error });
      return false;
    }
    if (!localId) {
      localId = get().queueOutgoing({ text: trimmed });
      get().patchOutgoing(localId, { body: trimmed });
    }
    const id = localId;
    const room = threadRoomKey(scope.id, groupId, addr);
    if (groupId) {
      set({ sending: true, sendError: null });
      try {
        const posted = await postProjectGroupMessage(scope, groupId, trimmed);
        if (!posted.ok || !posted.data) {
          return fail(id, posted.error || "send failed");
        }
        const row = posted.data;
        if (get().threadGen !== gen) {
          get().dropOutgoing(id);
          return true;
        }
        const username = scope.username();
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
          outbox: outboxWithout(id),
          landedKeys: rememberLanded(get().landedKeys, room, msg?.id, id),
          thread: msg && !seen.has(msg.id) ? [...get().thread, msg] : get().thread,
          lastAtByKey: {
            ...get().lastAtByKey,
            [lastAtKey(scope.id, "group", groupId)]: row.createdAt,
          },
        });
        get().markGroupSeen(groupId, row.createdAt);
        return true;
      } catch (e) {
        return fail(id, e instanceof Error ? e.message : String(e));
      }
    }
    const before = get().thread.map((m) => m.id);
    set({ sending: true, sendError: null });
    try {
      const posted = await postThread(scope, addr as string, trimmed);
      if (!posted.ok) {
        return fail(id, posted.error || "send failed");
      }
      const postedId = String(
        (posted.data &&
          (posted.data.id ||
            (posted.data.doc && posted.data.doc.id))) ||
          ""
      );
      if (postedId) get().patchOutgoing(id, { serverId: postedId });
      if (get().threadGen !== gen) {
        // Posted; that room shows it when it is opened again.
        get().dropOutgoing(id);
        return true;
      }
      const live = watchLive();
      const reread = await Promise.resolve(getThread(scope, addr as string)).finally(live.stop);
      if (get().threadGen !== gen) {
        get().dropOutgoing(id);
        return true;
      }
      if (!reread.ok || !reread.data || !Array.isArray(reread.data.items)) {
        return fail(id, "sent but the thread could not be re-read");
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
        return fail(id, "sent but not on the wire");
      }
      // Arrival is not authorship. Accept owner or the signed-in
      // username; never this thread's own agent handle.
      if (!isOwnerAuthored(onWire.from, username, addr as string)) {
        return fail(id, `sent but the speaker was wrong (from='${onWire.from}')`);
      }
      // Older messages already on screen (cached, or paged in) stay.
      const merged = mergeServerPage(get().thread, items, {
        hasMore: !!reread.data.has_more,
        arrivedLive: live.ids,
      });
      set({
        sending: false,
        sendError: null,
        outbox: outboxWithout(id),
        landedKeys: rememberLanded(get().landedKeys, room, onWire.id, id),
        thread: merged,
        threadCached: false,
        threadConversationId:
          (reread.data.conversation_id || "").trim() ||
          get().threadConversationId,
        threadHasMore: !!reread.data.has_more,
        threadOldestSeq: oldestSeqOf(merged),
        // The row shows this send at once ("You: …").
        ...threadRowPatch(get(), scope, addr as string, { ...onWire, at: onWire.at ?? Date.now() / 1000 }),
      });
      return true;
    } catch (e) {
      return fail(id, e instanceof Error ? e.message : String(e));
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
    if (msg.id) for (const w of liveWatches) w.add(msg.id);
    // A frame for a message already shown is its new state (a card
    // answered / voided / expired): replace it in place. Its files keep
    // the state on screen (frames carry the post-time state).
    const cur = get().thread;
    const at = msg.id ? cur.findIndex((m) => m.id === msg.id) : -1;
    let thread: ThreadMessage[];
    if (at >= 0) {
      const next = { ...msg, files: cur[at].files, pending: cur[at].pending, failed: cur[at].failed };
      if (!next.files) delete next.files;
      if (!next.pending) delete next.pending;
      if (!next.failed) delete next.failed;
      if (sameMessage(cur[at], next)) return;
      thread = [...cur];
      thread[at] = next;
    } else {
      thread = mergeThreadMessages(cur, [msg]);
    }
    if (thread === cur) return;
    const last = thread[thread.length - 1];
    const addr = get().threadAddr;
    const wasError = get().threadSource === "error";
    set({
      thread,
      threadSource: wasError ? "live" : get().threadSource,
      threadError: wasError ? null : get().threadError,
      ...(addr ? threadRowPatch(get(), scope, addr, last) : {}),
    });
  },

  refreshOpenThread: async () => {
    // The foreground / catch-up re-read: what changed while away (cards
    // answered or voided, new messages) — a delta from the newest seq on
    // screen when the server has one, else the newest page merged.
    if (get().agentSource === "stub") return;
    const gen = get().threadGen;
    const groupId = (get().threadGroupId || "").trim();
    const addr = get().threadAddr;
    if (!groupId && !addr) return;
    const scope = zenScope();
    const key = threadRoomKey(scope.id, groupId || null, groupId ? null : addr);
    const still = () =>
      get().threadGen === gen &&
      (groupId ? get().threadGroupId === groupId : get().threadAddr === addr);
    const gone = (msg: string) => {
      chatCache().forget(key);
      set({ thread: [], threadCached: false, threadSource: "error", threadError: msg });
    };
    if (groupId) {
      try {
        const read = await fetchGroupRead(scope, groupId, {
          messages: get().thread,
          conversationId: null,
        });
        if (!still()) return;
        if (!read.ok) {
          if (read.gone) gone(read.error);
          return; // keep what is on screen
        }
        const cur = get().thread;
        const incoming = applyGroupRead(cur, read);
        if (incoming === cur && !get().threadCached) return;
        const last = incoming[incoming.length - 1];
        set({
          thread: incoming,
          threadCached: false,
          threadSource: "live",
          threadError: null,
          ...(read.mode === "replace" ? { threadHasMore: !!read.hasMore } : null),
          lastAtByKey: {
            ...get().lastAtByKey,
            [lastAtKey(scope.id, "group", groupId)]:
              last?.at ?? get().lastAtByKey[lastAtKey(scope.id, "group", groupId)] ?? null,
          },
        });
        get().markGroupSeen(groupId, last?.at ?? null);
      } catch {
        /* keep what is on screen */
      }
      return;
    }
    const a = addr as string;
    const live = watchLive();
    try {
      const prevConv = get().threadConversationId;
      const read = await fetchThreadRead(scope, a, {
        messages: get().thread,
        conversationId: prevConv,
      }).finally(live.stop);
      if (!still()) return;
      if (!read.ok) {
        if (read.gone) gone(read.error);
        return; // keep what is on screen
      }
      if (read.mode === "reset") chatCache().forget(key);
      const conv = read.conversationId ?? prevConv;
      const refreshAfter = () => {
        if (still()) maybeRefreshAttachments(scope, a, key, read.mode);
      };
      const thread = applyThreadRead(get().thread, read, {
        arrivedLive: live.ids,
        conversationId: prevConv,
      });
      if (thread === get().thread && conv === prevConv && !get().threadCached) {
        refreshAfter();
        return;
      }
      const last = thread[thread.length - 1];
      set({
        thread,
        threadCached: false,
        threadSource: "live",
        threadError: null,
        threadConversationId: conv,
        // Older pages already on screen stay, so their "more" stays —
        // unless the copy was replaced.
        ...(read.mode === "replace" || read.mode === "reset" ? { threadHasMore: !!read.hasMore } : null),
        threadOldestSeq: oldestSeqOf(thread) ?? get().threadOldestSeq,
        ...threadRowPatch(get(), scope, a, last),
      });
      refreshAfter();
    } catch {
      live.stop();
      /* keep what is on screen */
    }
  },

  setAgent: (id) => {
    set({
      screen: "thread",
      agentId: id,
      groupRoot: null,
      openFileIds: [],
      focusId: null,
      sending: false,
      sendError: null,
    });
    const row = get().agents.find((a) => a.id === id);
    if (row?.kind === "group" && row.groupId) {
      // A project chat's Files are the group's own resources (its
      // members' Workspace Resources). Stub mode has none: the note.
      if (get().agentSource === "live") void get().hydrateGroupFiles(row.groupId);
      else set({ filesGen: get().filesGen + 1, ...noResources() });
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
        threadCached: false,
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
    // The workspaces store is the active server's; a room elsewhere re-reads
    // its own list in the drawer.
    if (!roomServerId()) void useWorkspacesStore.getState().fetchAllSessions();
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
        // The workspaces store holds the ACTIVE server's projects only.
        projects: roomServerId() ? [] : useWorkspacesStore.getState().projects,
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
      threadCached: false,
      threadError: null,
      threadAddr: null,
      threadGroupId: null,
      threadConversationId: null,
      threadFocusSeq: null,
      files: [],
      groupRoot: null,
    });
    // Back from a room on another server: the active server's list again.
    if (roomServerId()) get().enterRoomServer(null);
  },
  enterRoomServer: (serverId, seed) => {
    const active = activeId();
    const target = serverId && serverId !== active ? serverId : null;
    const current = roomServerId();
    if (target === current) return;
    if (target) {
      // Park the active server's list once (a room → room move keeps it).
      if (!current && active) listSlice = { serverId: active, state: captureList(get()) };
      setRoomServer(target);
      activityServer = target;
      focusServer = target;
      set({
        agentSource: seed && seed.length ? "live" : "loading",
        agents: seed ?? [],
        agentError: null,
        serverProjects: [],
        pinnedIds: [],
        chatSessions: NO_CHAT_SESSIONS,
        activity: EMPTY_ACTIVITY,
        focus: FOCUS_OFF,
        focusGroupsEnabled: false,
        hiddenSidecarAddrs: readHiddenSidecarAddrs(target),
        files: [],
        fileSource: "loading",
        fileError: null,
        groupRoot: null,
        openFileIds: [],
        focusId: null,
        filesOpen: false,
        sending: false,
        sendError: null,
        thread: [],
        threadCached: false,
        threadAddr: null,
        threadGroupId: null,
        threadConversationId: null,
        threadSource: "loading",
        threadError: null,
      });
      return;
    }
    setRoomServer(null);
    const parked = listSlice;
    listSlice = null;
    activityServer = active;
    focusServer = active;
    // A parked list that had failed (its server was down) is read again.
    if (parked && parked.serverId === active && parked.state.agentSource !== "error") {
      set(parked.state);
      // Fresh dots, pins and groups for the list, in the background.
      void get().refreshActivity();
      get().refreshServerLists();
      return;
    }
    set({ agents: [], agentSource: "loading", activity: EMPTY_ACTIVITY, serverProjects: [], pinnedIds: [] });
    if (get().screen === "list") void get().hydrateAgents();
  },
  openRoom: async (serverId, target) => {
    const id = (target.id || "").trim();
    if (serverId === activeId()) {
      get().enterRoomServer(null);
      if (id) get().setAgent(id);
      return;
    }
    get().enterRoomServer(serverId, target.seed);
    if (roomServerId() !== serverId) return;
    set({ screen: "thread", agentId: id, groupRoot: null });
    await get().hydrateAgents(id ? { resumeId: id } : undefined);
  },
  toggleFiles: () => {
    const open = !get().filesOpen;
    set({ filesOpen: open });
    // The phone does not hear `workspace_resources_changed` on
    // sessions/events, so re-read the list every time the pane opens.
    if (!open || get().agentSource !== "live") return;
    const row = get().agents.find((a) => a.id === get().agentId);
    if (row?.kind === "group") {
      if (row.groupId) void get().hydrateGroupFiles(row.groupId, { refresh: true });
      return;
    }
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
    const { files, openFileIds, fileSource, agentId, agents, groupRoot } = get();
    const row = agents.find((a) => a.id === agentId);
    // A project chat has no path of its own: its PoC's workspace.
    const owned =
      typeof row?.path === "string" && row.path.trim()
        ? row.path.trim()
        : row?.kind === "group"
          ? (groupRoot ?? "")
          : "";
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

// Every confirmed Thread / project chat on screen (a read that landed, a
// live frame, a send) is the room's cached copy: memory now, the device
// store written behind. A cached paint is not re-saved; an empty list is
// never saved from here (list loads clear the Thread) — an empty server
// read drops the entry itself.
useZenStore.subscribe((s, p) => {
  if (s.thread === p.thread && s.threadCached === p.threadCached) return;
  if (s.threadSource !== "live" || s.threadCached || !s.thread.length) return;
  if (s.agentSource === "stub") return;
  const server = zenId();
  if (!server) return;
  const groupId = (s.threadGroupId || "").trim();
  const addr = (s.threadAddr || "").trim();
  if (!groupId && !addr) return;
  chatCache().remember({
    key: threadRoomKey(server, groupId || null, groupId ? null : addr),
    serverId: server,
    messages: s.thread,
    conversationId: groupId ? null : s.threadConversationId,
    hasMore: s.threadHasMore,
  });
});

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
