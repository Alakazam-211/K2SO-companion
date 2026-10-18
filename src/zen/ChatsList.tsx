import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fullViewportHeight,
  useViewport,
  useViewportTrackRef,
} from "../lib/useViewportHeight";
import { keyboardColumnHeight, useKeyboardFlip } from "../kit/mobileChat/useKeyboardFlip";
import { useFeedbackStore } from "../stores/feedback";
import { ticketsAriaLabel, ticketsBadge } from "../api/feedbackPure";
import { hostLabel, serverHostKey, useServersStore, type RecoveryState } from "../stores/servers";
import { isOverlayExtraAddr, visibleOverlayAgents } from "./overlayExtras";
import { rowPreviewFor, rowPreviewText } from "./rowPreview";
import { RowSnippet } from "./RowSnippet";
import { activityColor, activityForRow, activityPinText, activityRowText } from "./agentActivity";
import { AgentRowContent } from "./AgentRowContent";
import { RowDivider } from "./RowDivider";
import { OverlayAddServer } from "./OverlayAddServer";
import {
  GlassSearchBar,
  SEARCH_BAR_HEIGHT,
  SEARCH_BAR_KEYBOARD_GAP,
  SEARCH_BAR_REST_BOTTOM,
} from "./GlassSearchBar";
import { NewWorkspaceSheet } from "./NewWorkspaceSheet";
import { canCreateWorkspace, createRoleNote } from "./newWorkspace";
import { posixNormalize } from "./workspacePath";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { OverlayServers } from "./OverlayServers";
import { TicketsOverlay, useTicketWaitingCounts } from "./TicketsOverlay";
import { ProjectsOverlay } from "./ProjectsOverlay";
import { isProjectGroupsChangedFrame, unreadGroupCount } from "./projectChats";
import { ZEN_TICKET_PARAM } from "./terminalJump";
import { lastAtKeyFor } from "./lastAtFetch";
import {
  currentFocusGroup,
  filterByFocus,
  sortByProjectOrder,
  listTitle,
  pinProjectIdForRow,
  rowFocusGroupId,
} from "./serverPins";
import { connectProjectEvents, subscribeAppEvents } from "./ticketEvents";
import { useRoomElsewhere, useZenScope } from "./zenScope";
import { mountainListWhen } from "./threadModel";
import { usePinDrag } from "./usePinDrag";
import { useHoldMenu } from "./useHoldMenu";
import { prefersReducedMotion, useRearrange } from "./useRearrange";
import { GripHandle, RearrangeDone, rearrangePadLeft } from "./RearrangeBits";
import {
  AgentMenu,
  GroupGlyph,
  OpenGlyph,
  PinGlyph,
  RearrangeGlyph,
  type AgentMenuEntry,
} from "./AgentMenu";
import { FocusGroupPicker } from "./FocusGroupPicker";
import { AddAgentSheet } from "./AddAgentSheet";
import { HomeList, homeRowTarget, openHomeRowOnServer, type RemoteRowLook } from "./HomeList";
import { prefetchTargets, useChatPrefetch, type PrefetchTarget } from "./chatPrefetch";
import { HomeMenu } from "./HomeMenu";
import { HomeTabToggle } from "./HomeTabToggle";
import { parseHomeAddress, readListTab, selectedHome, useHomesStore, writeListTab, type ListTab } from "./homes";
import { homeRowMatches, renameRepairFor, resolveHomeRows, type HomeRowView } from "./homeView";
import { boxIdForSaved, homeHostFor, useHomeServerIds } from "./homeServerIds";
import { dismissHomesSyncNotice, useHomesSyncBadge, useHomesSyncStore } from "./homesSync";
import { OtherServerSection } from "./multi/OtherServerSection";
import { otherServersForPicker } from "./multi/homePicker";
import type { StubAgent } from "./stubData";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { ZenSettings } from "./ZenSettings";
import { homeViewRecent, orderRecentFirst, recentSentKey, useRecentFirstStore } from "./recentFirst";
import { useZenStore } from "./zenStore";
import { FOCUS_OFF } from "./serverPins";
import { labelOf, snapshotCapable, useMultiServerList, type ActiveSlice } from "./multi/useMultiServerList";
import { homeActivityWord, rowActivityOf } from "./multi/rowStatus";
import { loadServerRows, selectRemoteFocusGroup } from "./multi/remoteRows";
import { ensureRemoteIcon, remoteIconFor, useRemoteIcons } from "./multi/remoteIcons";
import { retryServerNow } from "./multi/poolLoop";
import {
  LoadingLines,
  RemoteAgentRow,
  ServerPlaceholderRow,
} from "./multi/MergedRows";
import type { MergedRow } from "./multi/merge";
import type { RowActivity } from "./agentActivity";
import { CheckIcon, CogIcon } from "./icons";
import { useBackHandler } from "../lib/androidBack";
import { refreshAllServers } from "./multi/recovery";
import { entryDown, useHealth } from "./multi/serverHealth";
import { usePullToRefresh } from "./usePullToRefresh";
import { projectBadgeCount, rowRefOf, rowUnreadFor } from "./unread";
import { unreadSupported, useUnreadStore } from "./unreadStore";
import { UnreadDot } from "./UnreadMarks";

const RECOVERY_DOT: Record<RecoveryState, string> = {
  connected: "#22c55e",
  reconnecting: "#f59e0b",
  reauthenticating: "#f59e0b",
  "signin-required": "#ef4444",
};

/** Phone-width overlay home. Look is public/imessage-baseline.html (7724968). */
/** How often the Chats list re-reads agent status. */
const ACTIVITY_POLL_MS = 5_000;

/** How often the list re-reads server pins and focus groups while up. */
export const SERVER_LISTS_POLL_MS = 30_000;

const ROW_HINT_ID = "chats-row-hint";
/** How long "Moved to Work · Undo" stays up after a group change. */
export const GROUP_TOAST_MS = 4000;
/** How long a just-created workspace row stays highlighted. */
export const NEW_ROW_HIGHLIGHT_MS = 4000;
/** Title cap: at 375pt the side columns keep ~100px for the pills. */
/** The right column holds three 34px buttons (Projects, Tickets, cog)
 *  with 8px gaps = 118px; the equal 1fr columns must keep that, so the
 *  title gets what is left of the 24px padding and 16px gaps: 99px at
 *  375pt, the old 140px cap on wider phones. */
const HEADER_RIGHT_PX = 3 * 34 + 2 * 8;
const TITLE_MAX_W = `min(calc(100vw - ${24 + 16 + 2 * HEADER_RIGHT_PX}px), 140px)`;
/** Resting header content height below the safe area: 44 row + 12/8 pad. */
export const CHATS_HEADER_PX = 64;
/**
 * Pin grid geometry. The grid box sits EDGE_INSET from the screen with
 * EDGE_PAD of padding inside; three equal columns, COL_GAP apart, each with
 * a PIN_AVATAR_PX circle centred in it. The outer avatars' edge sits at
 * (2/3)side + W/6 - gap/3 - avatar/2, so a wider COL_GAP pushes the first
 * and last avatars (and the list inset that follows them) toward the
 * edges while the grid box keeps its 4px drop-outline margin. 37 puts the
 * avatars ~17px in at 375pt and ~26px at 430pt. Cells are then ~96px at
 * 375pt, so pinned names truncate at the cell there (110px cap above that).
 */
export const ZEN_LIST_EDGE_INSET = 4;
export const ZEN_LIST_EDGE_PAD = 2;
export const ZEN_PIN_COL_GAP = 37;
export const ZEN_PIN_ROW_GAP = 14;
export const ZEN_PIN_AVATAR_PX = 74;
const PIN_SIDE_PX = ZEN_LIST_EDGE_INSET + ZEN_LIST_EDGE_PAD;

/** Space under the pin grid, above the first list row (was 8; +6 asked). */
export const ZEN_PIN_GRID_BOTTOM_PX = 14;

/**
 * Pin grid columns for `count` pins. Three or more: three equal columns,
 * a partial last row left-justified. One or two: that many columns of the
 * same 3-column cell width (same gap), centred as a group. `100%` here is
 * the grid's content box, so the cell matches the 3-column `1fr` exactly
 * and the list inset (which assumes three columns) never moves.
 */
export function zenPinGridColumns(count: number): string {
  if (count >= 3) return "repeat(3, minmax(0, 1fr))";
  const n = Math.max(1, count);
  return `repeat(${n}, calc((100% - ${2 * ZEN_PIN_COL_GAP}px) / 3))`;
}

/**
 * Distance from the list's edge to the outer edge of the first (and third)
 * pinned avatar, for a list `containerPx` wide:
 *   side + (cell - avatar) / 2, cell = (W - 2*side - 2*gap) / 3.
 */
export function zenPinnedGroupInsetPx(containerPx: number): number {
  const cell = (containerPx - 2 * PIN_SIDE_PX - 2 * ZEN_PIN_COL_GAP) / 3;
  return PIN_SIDE_PX + (cell - ZEN_PIN_AVATAR_PX) / 2;
}

/**
 * The same inset as CSS, with 100% = the list's width. Rows, search hits,
 * the Rearrange grips and the empty lines all use it (pins or not), so
 * list content spans exactly the pinned avatars' visible width.
 */
export const ZEN_LIST_CONTENT_INSET =
  `calc(${PIN_SIDE_PX}px + ((100% - ${2 * PIN_SIDE_PX + 2 * ZEN_PIN_COL_GAP}px) / 3 - ${ZEN_PIN_AVATAR_PX}px) / 2)`;
/** Side padding for the list's plain text lines (loading, error, empty). */
const LIST_LINE_SIDES = {
  paddingLeft: ZEN_LIST_CONTENT_INSET,
  paddingRight: ZEN_LIST_CONTENT_INSET,
} as const;

/** One list or pin-grid entry: an active-server row (ChatsList's own row,
 *  with its hold menu) or, with multi-server on, another server's. */
type ListItem =
  | { active: true; key: string; agent: StubAgent }
  | { active: false; key: string; row: MergedRow };

/** Pins sliding aside while one is dragged. */
const PIN_SHIFT_TRANSITION = "transform 220ms cubic-bezier(.2,.8,.2,1)";

export function ChatsList() {
  const viewport = useViewport();
  const {
    height: containerHeight,
    offsetTop: viewportTop,
    motion: viewportMotion,
    interactive: viewportInteractive,
  } = viewport;
  // Mobile chat kit: the column is tracked (an open ticket's interactive
  // dismiss sizes it) and the search bar + its blur ride the keyboard by
  // FLIP (no height transition).
  const columnTrackRef = useViewportTrackRef();
  const searchBarRef = useRef<HTMLDivElement>(null);
  const searchBlurRef = useRef<HTMLDivElement>(null);
  const agents = useZenStore((s) => s.agents);
  const chatRows = useMemo(() => agents.filter((a) => a.kind !== "group"), [agents]);
  const source = useZenStore((s) => s.agentSource);
  const agentError = useZenStore((s) => s.agentError);
  const setAgent = useZenStore((s) => s.setAgent);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const ensureLastAt = useZenStore((s) => s.ensureLastAt);
  const previewByKey = useZenStore((s) => s.previewByKey);
  const activity = useZenStore((s) => s.activity);
  const chatSessions = useZenStore((s) => s.chatSessions);
  const zenScreen = useZenStore((s) => s.screen);
  const refreshActivity = useZenStore((s) => s.refreshActivity);
  const pinnedIds = useZenStore((s) => s.pinnedIds);
  const serverProjects = useZenStore((s) => s.serverProjects);
  const pinError = useZenStore((s) => s.pinError);
  const focus = useZenStore((s) => s.focus);
  const focusGroupsEnabled = useZenStore((s) => s.focusGroupsEnabled);
  const selectFocusGroup = useZenStore((s) => s.selectFocusGroup);
  const hiddenSidecarAddrs = useZenStore((s) => s.hiddenSidecarAddrs);
  // "Recent agents first" (phone-only setting): re-sorts on every send.
  const recentOn = useRecentFirstStore((s) => s.on);
  const recentSent = useRecentFirstStore((s) => s.sent);
  const listRef = useRef<HTMLDivElement | null>(null);
  // The search bar (and its blur) ride the keyboard's show / hide on the
  // compositor; the list itself never moves (it does not stick to an end).
  useKeyboardFlip({
    viewportHeight: containerHeight,
    motion: viewportMotion,
    interactive: viewportInteractive,
    scroller: () => listRef.current,
    docks: () => [searchBarRef.current, searchBlurRef.current],
    enabled: zenScreen !== "thread",
  });
  const pinsRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerPx, setHeaderPx] = useState(CHATS_HEADER_PX);
  // Pins are per workspace on the server: only rows that map to a project
  // can pin. Sidecars / extra chats and project-group rows cannot.
  const pinnable = useMemo(
    () =>
      new Set(
        agents.filter((a) => pinProjectIdForRow(a, serverProjects)).map((a) => a.id)
      ),
    [agents, serverProjects]
  );
  const canPin = (id: string) => pinnable.has(id);
  // Rearrange mode ("Recent agents first" off): which list has grips.
  const [rearrangeTab, setRearrangeTab] = useState<ListTab | null>(null);
  const rearrangeRef = useRef(rearrangeTab);
  rearrangeRef.current = rearrangeTab;
  // The pin grid: a still hold is the agent menu, hold-and-drag reorders
  // the pins. Rearranging Agents: a pin drags straight away (no hold).
  const pinDrag = usePinDrag(pinsRef, () =>
    rearrangeRef.current === null ? "hold" : rearrangeRef.current === "agents" ? "drag" : "off"
  );
  const { ghost, hot, onPinClick, menu: pinMenu, closeMenu } = pinDrag;
  // List rows: press and hold for the same agent menu.
  const rowHold = useHoldMenu();
  const [scrolled, setScrolled] = useState(false);
  // Move to group… (menu) assigns the row's workspace to a focus group.
  // Groups off: no such item. Same rows as pins (groups are per workspace).
  const groupsOn = focus.enabled || focusGroupsEnabled;
  const canGroup = (id: string) => groupsOn && pinnable.has(id);
  const [groupPick, setGroupPick] = useState<string | null>(null);
  const [groupToast, setGroupToast] = useState<{
    id: string;
    prev: string | null;
    text: string;
  } | null>(null);
  const openGroupPicker = (id: string) => {
    if (canGroup(id)) setGroupPick(id);
  };
  const groupName = (gid: string | null) =>
    (gid && focus.groups.find((g) => g.id === gid)?.name) || "";
  const showGroupToast = (id: string, prev: string | null, next: string | null) => {
    const text = next
      ? `Moved to ${groupName(next) || "group"}`
      : `Removed from ${groupName(prev) || "group"}`;
    setGroupToast({ id, prev, text });
  };
  /** A pick in the sheet: assign, toast with Undo; a failure drops the toast. */
  const assignGroup = (id: string, next: string | null) => {
    const prev = rowFocusGroupId(
      agents.find((a) => a.id === id),
      useZenStore.getState().serverProjects
    );
    setGroupPick(null);
    if (prev === next) return;
    showGroupToast(id, prev, next);
    void useZenStore
      .getState()
      .assignFocusGroup(id, next)
      .then((ok) => {
        if (!ok) setGroupToast((t) => (t && t.id === id ? null : t));
      });
  };
  const createGroup = async (id: string, name: string) => {
    const prev = rowFocusGroupId(
      agents.find((a) => a.id === id),
      useZenStore.getState().serverProjects
    );
    const ok = await useZenStore.getState().createFocusGroupFor(id, name);
    if (!ok) return false;
    setGroupPick(null);
    setGroupToast({ id, prev, text: `Moved to ${name.trim()}` });
    return true;
  };
  const undoGroup = () => {
    const t = groupToast;
    if (!t) return;
    setGroupToast(null);
    void useZenStore.getState().assignFocusGroup(t.id, t.prev);
  };
  useEffect(() => {
    if (!groupToast) return;
    const timer = setTimeout(() => setGroupToast(null), GROUP_TOAST_MS);
    return () => clearTimeout(timer);
  }, [groupToast]);
  // Groups turned off (or the row went away): no picker.
  const pickAgent = groupPick && groupsOn ? agents.find((a) => a.id === groupPick) ?? null : null;
  const [groupMenu, setGroupMenu] = useState(false);
  const pinned = pinnedIds
    .map((id) => chatRows.find((a) => a.id === id))
    .filter((a): a is (typeof agents)[number] => !!a);
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState(false);
  const [tickets, setTickets] = useState(false);
  // Projects sheet: in the store so a project chat opened from it (and
  // that chat's terminal) comes back to it.
  const projectsOpen = useZenStore((s) => s.projectsOpen);
  const setProjectsOpen = useZenStore((s) => s.setProjectsOpen);
  // Push-tap deep link `/zen?ticket=<id>`: open Tickets on that ticket.
  // A new id remounts the overlay (key) so it re-opens on the new ticket.
  const [params, setParams] = useSearchParams();
  const ticketParam = (params.get(ZEN_TICKET_PARAM) || "").trim();
  const [deepTicket, setDeepTicket] = useState<string | null>(null);
  useEffect(() => {
    if (!ticketParam) return;
    // An open chat hides this list (and the overlay inside it).
    if (useZenStore.getState().screen === "thread") useZenStore.getState().closeChat();
    useZenStore.getState().setProjectsOpen(false);
    setDeepTicket(ticketParam);
    setTickets(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(ZEN_TICKET_PARAM);
        return next;
      },
      { replace: true }
    );
  }, [ticketParam, setParams]);
  const [newWorkspace, setNewWorkspace] = useState(false);
  // A created workspace that could not open straight into its chat.
  const [newRowPath, setNewRowPath] = useState<string | null>(null);
  // The server this list talks to (MS4/MS5): today the active server.
  const zen = useZenScope();
  const identity = useSessionIdentity(zen);
  const canCreate = canCreateWorkspace(identity);
  useEffect(() => {
    if (!newRowPath) return;
    const row = document.querySelector<HTMLElement>('[data-new-workspace="1"]');
    row?.scrollIntoView?.({ block: "nearest" });
    const t = setTimeout(() => setNewRowPath(null), NEW_ROW_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [newRowPath]);
  const [serversSheet, setServersSheet] = useState(false);
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);
  // Tickets badge: the same counts as the Tickets tabs (rows + "me").
  // Waiting on me if any, else the All waiting count, else hidden; amber
  // either way. See ticketsBadge() in feedbackPure.
  const { counts: ticketCounts } = useTicketWaitingCounts();
  const badge = ticketsBadge(ticketCounts);
  const activeServer = servers.find((s) => s.id === activeServerId) ?? null;
  const recoveryState: RecoveryState = activeServer
    ? recovery[activeServer.id] ?? "signin-required"
    : "signin-required";
  const serverLabel = activeServer
    ? activeServer.nickname || hostLabel(activeServer.url)
    : "Servers";

  // Multi-server S2 (flag `zen.multiServer`, default on): rows from every
  // saved server. Off, `multi.on` is false and nothing below changes.
  const activeSlice = useMemo<ActiveSlice>(
    () => ({
      source,
      agents,
      serverProjects,
      pinnedIds,
      focus,
      hiddenAddrs: hiddenSidecarAddrs,
    }),
    [source, agents, serverProjects, pinnedIds, focus, hiddenSidecarAddrs]
  );
  const multi = useMultiServerList({ q, listOnScreen: zenScreen === "list", active: activeSlice });
  const remoteIcons = useRemoteIcons((s) => s.icons);
  // The header's focus: the Agents tab's server's own groups.
  const headerFocus = multi.remoteSelectedId
    ? multi.byServer[multi.remoteSelectedId]?.focus ?? FOCUS_OFF
    : focus;
  const group = currentFocusGroup(headerFocus);
  const title = listTitle(headerFocus);
  const pickFocusGroup = (gid: string) => {
    if (multi.remoteSelectedId) selectRemoteFocusGroup(multi.remoteSelectedId, gid);
    else selectFocusGroup(gid);
  };

  const toListItem = (r: MergedRow): ListItem =>
    r.active ? { active: true, key: r.key, agent: r.agent } : { active: false, key: r.key, row: r };

  // Home | Agents (multi-server PRD §14 HM1). Agents is the default; the
  // pick is this device's (localStorage). Home is one server for now.
  const [tab, setTabState] = useState<ListTab>(readListTab);
  const onHome = tab === "home";
  const setTab = (next: ListTab) => {
    if (next === tab) return;
    writeListTab(next);
    setTabState(next);
    setGroupMenu(false);
    setHomeMenu(false);
    setRearrangeTab(null);
    rowHold.close();
    closeMenu();
  };
  // Owner 2026-10: the nickname pill opens the Servers sheet on both tabs
  // (no menu). Agents shows the active server, so the pill names it with
  // its status dot; picking in Servers switches it. With the flag on, Home
  // spans every server and the pill reads "All"; off, Home is the active
  // server's rows and the pill names that server, as on Agents.
  const selectedId = multi.selectedId;
  const pillLabel = onHome
    ? "All"
    : selectedId === activeServerId || !selectedId
      ? serverLabel
      : multi.labelFor(selectedId);
  const pillDot = onHome
    ? "#8e8e93"
    : selectedId === activeServerId || !selectedId
      ? activeServer
        ? RECOVERY_DOT[recoveryState]
        : "#8e8e93"
      : multi.badgeFor(selectedId).color;
  const homes = useHomesStore((s) => s.homes);
  const homeSelectedId = useHomesStore((s) => s.selectedId);
  const home = selectedHome({ homes, selectedId: homeSelectedId });
  const [homeMenu, setHomeMenu] = useState(false);
  const [addAgent, setAddAgent] = useState(false);
  // Homes sync (K2 0.46.1): which server Home syncs from, and the one-time
  // "removed" notice. Home itself always renders from the local copy.
  const homeSync = useHomesSyncBadge();
  const homeSyncNotice = useHomesSyncStore((s) => s.notice);
  useEffect(() => {
    if (onHome) useHomesStore.getState().ensureSeeded();
  }, [onHome]);
  const activeHostKey = activeServer ? serverHostKey(activeServer) : null;
  // Box ids (K2 0.46.1): rows may name a server by its `serverId`; a new
  // row uses it once known (`homeServerIds`).
  const boxIds = useHomeServerIds((s) => s.bySaved);
  const activeHomeHost = activeServer ? homeHostFor(activeServer) : null;
  const tokens = useServersStore((s) => s.tokens);
  // Flag on (S3b, HM3): rows from other servers resolve against THAT
  // server's own lists. Off (owner 2026-10): Home is the active server's
  // rows only; other servers' rows are hidden, never deleted, and come
  // back when the flag is turned on again.
  const homeViews = useMemo(() => {
    const views = resolveHomeRows(home.rows, {
      activeHostKey,
      agents,
      projects: serverProjects,
      servers,
      remote: multi.on ? { byServer: multi.byServer, tokens } : undefined,
    });
    return multi.on ? views : views.filter((v) => v.kind !== "remote");
  }, [home.rows, activeHostKey, agents, serverProjects, servers, multi.on, multi.byServer, tokens, boxIds]);
  // "Recent agents first": this phone's latest sends, then the Home's own
  // order. Home has no pin grid, so pins are not held at the top (they
  // would look frozen). Off: the Home's own order.
  const homeShown = useMemo(() => {
    if (!recentOn) return homeViews;
    const { keyOf } = homeViewRecent({
      activeServerId: zen.id,
      activePinnedIds: pinnedIds,
      remotePinnedIds: (sid) => multi.byServer[sid]?.pinnedIds,
    });
    return orderRecentFirst(homeViews, recentSent, keyOf);
  }, [recentOn, homeViews, recentSent, zen.id, pinnedIds, multi.byServer]);
  // Rename repair (flag on; desktop `repairFromList`): a row whose handle
  // left its server while its workspace id is still there follows the
  // rename. The active server's lists only while Zen is on it (a room on
  // another server holds THAT server's rows in the store).
  const roomElsewhere = useRoomElsewhere();
  useEffect(() => {
    if (!multi.on || roomElsewhere || source !== "live" || !activeHostKey || serverProjects.length === 0) return;
    useHomesStore
      .getState()
      .repairRows(renameRepairFor(activeHostKey, serverProjects, agents, boxIdForSaved(activeServerId)));
  }, [multi.on, roomElsewhere, source, activeHostKey, serverProjects, agents, activeServerId, boxIds]);
  useEffect(() => {
    if (!multi.on) return;
    for (const sv of servers) {
      if (sv.id === activeServerId) continue;
      const r = multi.byServer[sv.id];
      if (!r || r.loadedAt === null || r.error || r.serverProjects.length === 0) continue;
      useHomesStore
        .getState()
        .repairRows(renameRepairFor(serverHostKey(sv), r.serverProjects, r.agents, boxIdForSaved(sv.id)));
    }
  }, [multi.on, multi.byServer, servers, activeServerId, boxIds]);

  // Projects badge: project chats with a message newer than this device
  // saw (shared last-seen cursors), off the list's own group last-at
  // (`<serverId>|g:<id>`).
  const groupIds = useMemo(
    () => agents.filter((a) => a.kind === "group" && a.groupId).map((a) => a.groupId as string),
    [agents]
  );
  useZenStore((s) => s.groupSeenRev);
  // Unread (K2 0.46.1 `thread-read-v1`): the server's own counts; an
  // older server keeps this device's last-seen cursors.
  const unreadServers = useUnreadStore((s) => s.servers);
  const unreadAddrs = useUnreadStore((s) => s.addrs);
  const unreadOn = !!zen.id && !!unreadServers[zen.id] && unreadSupported(zen.id);
  const rowUnread = (serverId: string | null | undefined, a: StubAgent | null | undefined) =>
    rowUnreadFor(unreadServers, unreadAddrs, serverId, a ?? null);
  const projectsUnread = unreadOn
    ? projectBadgeCount(unreadServers[zen.id])
    : unreadGroupCount(zen.id || null, groupIds, lastAtByKey);

  /** Line two of a row (Agents and Home share it): the main Thread's
   *  newest message, inline Markdown on one line. */
  const rowPreviewOf = (a: StubAgent) => {
    const key = lastAtKeyFor(zen.id, a);
    return rowPreviewFor(a, key ? previewByKey[key] : undefined);
  };
  const previewFor = (a: StubAgent): ReactNode =>
    source === "stub" ? "STUB" : <RowSnippet preview={rowPreviewOf(a)} />;

  // Chat prefetch: the top Home rows and any row with something unread
  // are read ahead (each on its own server) so a tap paints from cache.
  const prefetch = useMemo(() => {
    const home: PrefetchTarget[] = [];
    for (const v of homeShown) {
      const t = homeRowTarget(v, zen.id);
      if (t) home.push({ serverId: t.serverId, ref: { kind: "thread", addr: t.addr } });
    }
    const others: PrefetchTarget[] = [];
    if (zen.id) {
      for (const a of agents) {
        if (a.kind === "group" && a.groupId) others.push({ serverId: zen.id, ref: { kind: "project", groupId: a.groupId } });
        else if (a.addr) others.push({ serverId: zen.id, ref: { kind: "thread", addr: a.addr } });
      }
    }
    return prefetchTargets(home, others, (t) => {
      const row = t.ref.kind === "project" ? { kind: "group", groupId: t.ref.groupId } : { addr: t.ref.addr };
      const u = rowUnreadFor(unreadServers, unreadAddrs, t.serverId, row);
      return !!u && u.tone !== "muted" && u.count > 0;
    });
  }, [homeShown, agents, zen.id, unreadServers, unreadAddrs]);
  useChatPrefetch(prefetch, zenScreen === "list" && source === "live");

  const searching = q.trim().length > 0;
  /** A server's project list: the active one's from the store, another's
   *  from its multi-server read. */
  const projectsForServer = (sid: string | undefined) =>
    !sid || sid === zen.id ? serverProjects : multi.byServer[sid]?.serverProjects ?? [];
  // Search ignores the focus group so any agent can still be found.
  // Project chats live behind the Projects button, never in this list.
  const visible = visibleOverlayAgents(chatRows, q, hiddenSidecarAddrs);
  // Desktop's order (its Agents view): the server's project list, not
  // last-message recency. "Recent agents first" lifts this phone's sends.
  const filtered = sortByProjectOrder(
    searching ? visible : filterByFocus(visible, focus, serverProjects, pinnedIds),
    serverProjects,
    (a) => a
  );
  // Each agent shows once: in the pin grid, or in the list. Search hides
  // the grid, so there every hit (pinned too) is a row.
  // Multi-server (flag on): pins and rows from every server in the
  // filter, keyed `<serverId>|<localId>`. Off: the active server's, keyed
  // by row id, exactly as before.
  const pinItems: ListItem[] = multi.on
    ? searching
      ? []
      : multi.merged.pinned.map(toListItem)
    : pinned.map((a) => ({ active: true, key: a.id, agent: a }));
  const showPins = !searching && pinItems.length > 0;
  const pinnedInGrid = new Set(showPins ? pinItems.map((p) => p.key) : []);
  const rows = showPins ? filtered.filter((a) => !pinnedInGrid.has(a.id)) : filtered;
  // "Recent agents first": below the pin grid, this phone's latest sends
  // lead; the rest keep desktop's (project-list) order. The merged list is
  // one selected server's rows.
  const mergedRows = multi.on
    ? sortByProjectOrder(multi.merged.rows, projectsForServer(multi.merged.rows[0]?.serverId), (r) => r.agent)
        .filter((r) => !pinnedInGrid.has(r.key))
    : [];
  const listItems: ListItem[] = multi.on
    ? (recentOn
        ? orderRecentFirst(mergedRows, recentSent, (r) => recentSentKey(r.serverId, r.agent))
        : mergedRows
      ).map(toListItem)
    : (recentOn ? orderRecentFirst(rows, recentSent, (a) => recentSentKey(zen.id, a)) : rows).map((a) => ({
        active: true,
        key: a.id,
        agent: a,
      }));
  const placeholders = multi.on ? multi.placeholders : [];
  // Rearrange (Agents, "Recent agents first" off): the active server's
  // unpinned main chats, in list order. Sidecars and other servers' rows
  // have no server order to write, so they get no grip.
  const reorderItems = listItems.filter(
    (it): it is Extract<ListItem, { active: true }> => it.active && canPin(it.agent.id)
  );
  const reorderIds = new Set(reorderItems.map((it) => it.agent.id));
  // Rows or pins (the pins rearrange in the same mode).
  const agentsCanRearrange =
    !recentOn && !searching && (reorderItems.length > 1 || pinned.length > 1);
  const agentsRearranging = !onHome && rearrangeTab === "agents";
  const homeRearranging = onHome && rearrangeTab === "home";
  const rearranging = agentsRearranging || homeRearranging;
  const rearrange = useRearrange({
    keys: reorderItems.map((it) => it.key),
    scrollRef: listRef,
    enabled: agentsRearranging,
    onCommit: (order) => {
      const idOf = new Map(reorderItems.map((it) => [it.key, it.agent.id]));
      const ids = order.map((k) => idOf.get(k)).filter((id): id is string => !!id);
      void useZenStore.getState().reorderRows(ids);
    },
  });
  const pinMenuOn = pinMenu && !rearranging ? pinMenu : null;
  const pinMenuAgent = pinMenuOn ? pinned.find((a) => a.id === pinMenuOn.id) ?? null : null;
  const rowMenuOn = rowHold.menu && !rearranging ? rowHold.menu : null;
  const rowMenuAgent = rowMenuOn ? agents.find((a) => a.id === rowMenuOn.id) ?? null : null;
  /** The one agent menu (rows and pins): only what applies to this agent. */
  const agentMenuEntries = (a: StubAgent, inGrid: boolean): AgentMenuEntry[] => {
    const entries: AgentMenuEntry[] = [
      { key: "open", label: "Open", icon: <OpenGlyph />, onSelect: () => setAgent(a.id) },
    ];
    if (pinnedIds.includes(a.id)) {
      entries.push({
        key: "unpin",
        label: "Unpin",
        icon: <PinGlyph off />,
        onSelect: () => void useZenStore.getState().unpinChat(a.id),
      });
    } else if (canPin(a.id)) {
      entries.push({
        key: "pin",
        label: "Pin",
        icon: <PinGlyph off={false} />,
        onSelect: () => void useZenStore.getState().pinChat(a.id),
      });
    }
    entries.push({ key: "mute", mute: { serverId: zen.id, rowRef: rowRefOf(a) } });
    if (canGroup(a.id)) {
      const gid = rowFocusGroupId(a, serverProjects);
      const g = gid ? focus.groups.find((x) => x.id === gid) ?? null : null;
      entries.push({
        key: "group",
        label: "Move to group…",
        icon: <GroupGlyph color={g?.color} />,
        onSelect: () => openGroupPicker(a.id),
      });
    }
    if (agentsCanRearrange && (inGrid ? pinned.length > 1 : reorderIds.has(a.id))) {
      entries.push({
        key: "rearrange",
        label: "Rearrange",
        icon: <RearrangeGlyph />,
        onSelect: () => setRearrangeTab("agents"),
      });
    }
    return entries;
  };
  const serverListsAt = useRef(Date.now());
  // Pull to refresh (Home and Agents): every saved server is retried at
  // once; a server that is back reconnects (auto reconnect).
  const ptr = usePullToRefresh(listRef, refreshAllServers, servers.length > 0 && !ghost && !rearranging);
  // The active server is down: its list says it is reconnecting instead of
  // showing the read's error.
  const activeDownHealth = useHealth((h) =>
    activeServerId ? h.downSince[activeServerId] !== undefined : false
  );
  const activeDown =
    multi.on && !!activeServerId && (activeDownHealth || entryDown(multi.entries[activeServerId]));
  const reconnectingLine = (
    <span className="inline-flex items-center" style={{ gap: 6 }} data-testid="chats-reconnecting">
      <span aria-hidden className="k2-reconnect-dot" />
      {`Reconnecting to ${serverLabel}…`}
    </span>
  );

  // Agent status: re-read the activity snapshot while the list is up. The
  // list stays mounted (hidden) under an open Thread; it does not poll then.
  useEffect(() => {
    if (source !== "live" || zenScreen !== "list") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (document.visibilityState !== "hidden") {
        void refreshActivity();
        // Server pins + focus groups ride the same cadence, every ~30 s.
        if (Date.now() - serverListsAt.current >= SERVER_LISTS_POLL_MS) {
          serverListsAt.current = Date.now();
          useZenStore.getState().refreshServerLists();
        }
      }
      timer = setTimeout(tick, ACTIVITY_POLL_MS);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [source, zenScreen, refreshActivity]);

  // Server pins + focus groups: re-read on mount and on app foreground
  // (group edits and switches send no event), and on `projects_changed`
  // from the shared sessions/events socket (pin / reorder writes).
  const live = source === "live";
  useEffect(() => {
    if (!live) return;
    serverListsAt.current = Date.now();
    useZenStore.getState().refreshServerLists();
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      serverListsAt.current = Date.now();
      useZenStore.getState().refreshServerLists();
    };
    document.addEventListener("visibilitychange", onVis);
    const events = connectProjectEvents(zen, () => void useZenStore.getState().refreshPins());
    // A project chat moved: its badge (and an open project chat) catch up.
    const groupEvents = subscribeAppEvents(zen, isProjectGroupsChangedFrame, () => {
      const z = useZenStore.getState();
      const ids = z.agents
        .filter((a) => a.kind === "group" && a.groupId)
        .map((a) => a.groupId as string);
      if (ids.length) void z.refreshGroupPreviews(ids);
      if (z.screen === "thread" && (z.threadGroupId || "").trim()) void z.refreshOpenThread();
    });
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      events.stop();
      groupEvents.stop();
    };
  }, [live, zen]);

  useEffect(() => {
    if (!group) setGroupMenu(false);
  }, [group]);

  // A pin that left the grid (unpinned elsewhere, or search) drops its menu.
  useEffect(() => {
    if (pinMenu && (!pinMenuAgent || !showPins)) closeMenu();
  }, [pinMenu, showPins, pinMenuAgent, closeMenu]);

  // Rearrange ends on its own when the list can no longer be rearranged
  // ("Recent agents first" turned on, a search typed).
  useEffect(() => {
    if (rearrangeTab && (recentOn || searching)) setRearrangeTab(null);
  }, [rearrangeTab, recentOn, searching]);

  // Android Back: ends Rearrange, and closes the header-anchored focus
  // menu (the agent menus register in AgentMenu; sheets and overlays in
  // their own components).
  useBackHandler(rearranging, () => setRearrangeTab(null));
  useBackHandler(Boolean(!onHome && group && groupMenu), () => setGroupMenu(false));

  // The header floats over the list; the list's top padding tracks its
  // real height (a pin error line grows it). Hidden under an open Thread
  // the box measures 0, so keep the last good height.
  const hasServers = servers.length > 0;
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const read = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) setHeaderPx(h);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasServers]);

  useEffect(() => {
    const root = listRef.current;
    if (root) root.scrollTop = 0;
  }, [q]);

  useEffect(() => {
    // MA9: Zen rides the server's one shared sessions/events socket.
    useFeedbackStore.getState().ensureLive({ via: "hub" });
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void useFeedbackStore.getState().refresh();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [activeServerId]);

  useEffect(() => {
    if (source !== "live") return;
    for (const a of agents) {
      const key = lastAtKeyFor(zen.id, a);
      if (key) ensureLastAt(key);
    }
  }, [agents, source, ensureLastAt, zen]);

  useEffect(() => {
    if (source !== "live" && !multi.on) return;
    const root = listRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const key = (e.target as HTMLElement).dataset.lastAtKey;
          if (key) ensureLastAt(key);
        }
      },
      { root, rootMargin: "80px" }
    );
    root.querySelectorAll("[data-last-at-key]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [rows, listItems.length, multi.on, source, ensureLastAt]);

  // MA24: pictures for rows from other servers with no `iconUrl`, asked
  // of their own server while it is live and signed in.
  useEffect(() => {
    if (!multi.on) return;
    for (const r of [...multi.merged.rows, ...multi.merged.pinned]) {
      if (r.active || r.agent.iconUrl || r.agent.kind === "group") continue;
      const e = multi.entries[r.serverId];
      if (!e || e.reach !== "live" || e.auth !== "ok") continue;
      void ensureRemoteIcon(r.serverId, r.workspaceId, r.agent.path);
    }
  }, [multi.on, multi.merged, multi.entries]);

  // Home rows from other servers (flag on): their snippets (this device's
  // per-server cache, then one `thread/latest` on THAT server while it is
  // live and signed in) and pictures (MA24).
  useEffect(() => {
    if (!multi.on || !onHome || zenScreen !== "list") return;
    const byServer = new Map<string, { handles: string[]; ws: { id: string | null; path?: string | null }[] }>();
    for (const v of homeViews) {
      if (v.kind !== "remote" || !v.server) continue;
      const handle = parseHomeAddress(v.row.address)?.handle;
      if (!handle) continue;
      const slot = byServer.get(v.server.id) ?? { handles: [], ws: [] };
      slot.handles.push(handle);
      const a = v.resolved?.agent;
      if (a && !a.iconUrl) slot.ws.push({ id: v.resolved?.workspaceId ?? null, path: a.path });
      byServer.set(v.server.id, slot);
    }
    for (const [sid, slot] of byServer) {
      const e = multi.entries[sid];
      const healthy = !!e && e.reach === "live" && e.auth === "ok";
      void useZenStore.getState().refreshRemotePreviews(sid, slot.handles, { fetch: healthy });
      if (!healthy) continue;
      for (const w of slot.ws) void ensureRemoteIcon(sid, w.id, w.path);
    }
  }, [multi.on, onHome, zenScreen, homeViews, multi.entries]);

  /** A non-active row's status, failure and activity. Its server's 5 s
   *  snapshot (Q7) gives counts; otherwise the summary's dot and word. */
  const remoteView = (r: MergedRow) => {
    const hasSnap = multi.snapshotIds.includes(r.serverId) && snapshotCapable(r.serverId);
    const snap = multi.byServer[r.serverId];
    const snapBusy =
      hasSnap && snap
        ? activityForRow(r.agent, snap.activity, isOverlayExtraAddr(r.agent.addr), snap.chatSessions)
        : null;
    const status = multi.statusFor(
      r.serverId,
      r.workspaceId,
      hasSnap ? (snapBusy ? homeActivityWord(snapBusy.display) : "idle") : null
    );
    const failure = multi.failureFor(r.serverId, status);
    const busy: RowActivity | null = failure ? null : hasSnap ? snapBusy : rowActivityOf(status);
    return { failure, busy };
  };
  const openRemote = (r: MergedRow) => void multi.openOnServer(r.serverId, r.agent.id);
  const iconOf = (r: MergedRow) =>
    r.agent.iconUrl || remoteIconFor(remoteIcons, r.serverId, r.workspaceId);

  // Home rows from other servers (flag on, S3b / HM3): status from the
  // S2 pool and row fold; activity from that server's 5 s snapshot when it
  // has one (the open room's / the filter's, Q7), else the summary's dot
  // and word; picture by MA24; line two from the per-server snippet cache.
  type RemoteHomeView = Extract<HomeRowView, { kind: "remote" }>;
  const homeRemoteLook = (v: RemoteHomeView): RemoteRowLook => {
    const handle = parseHomeAddress(v.row.address)?.handle ?? "";
    if (!v.server) {
      return {
        failure: null,
        busy: null,
        iconUrl: null,
        preview: `${v.serverLabel} is not saved on this phone`,
        when: "",
        nextAt: null,
        dim: true,
      };
    }
    const sid = v.server.id;
    const agent = v.resolved?.agent ?? null;
    const ws = v.resolved?.workspaceId ?? null;
    const hasSnap = !!agent && multi.snapshotIds.includes(sid) && snapshotCapable(sid);
    const snap = multi.byServer[sid];
    const snapBusy =
      hasSnap && snap ? activityForRow(agent!, snap.activity, false, snap.chatSessions) : null;
    const status = multi.statusFor(
      sid,
      ws,
      hasSnap ? (snapBusy ? homeActivityWord(snapBusy.display) : "idle") : null
    );
    const failure = multi.failureFor(sid, status);
    const busy: RowActivity | null = failure ? null : hasSnap ? snapBusy : rowActivityOf(status);
    const key = lastAtKeyFor(sid, { addr: handle });
    const missing = !!v.resolved?.loaded && !agent;
    const preview = missing ? (
      `Not on ${v.serverLabel}'s list right now`
    ) : (
      <RowSnippet
        preview={rowPreviewFor(agent ?? { addr: handle, kind: "agent" }, key ? previewByKey[key] : undefined)}
      />
    );
    return {
      failure,
      busy,
      iconUrl: agent?.iconUrl || remoteIconFor(remoteIcons, sid, ws),
      preview,
      when: key && lastAtByKey[key] != null ? mountainListWhen(lastAtByKey[key] as number) : "",
      nextAt: multi.entries[sid]?.nextAt ?? null,
      dim: missing,
    };
  };

  const renderRemoteRow = (r: MergedRow, divider: boolean) => {
    const { failure, busy } = remoteView(r);
    const lastKey = failure ? undefined : lastAtKeyFor(r.serverId, r.agent) ?? undefined;
    const when =
      lastKey && lastAtByKey[lastKey] != null ? mountainListWhen(lastAtByKey[lastKey] as number) : "";
    return (
      <RemoteAgentRow
        key={r.key}
        row={r}
        unread={rowUnread(r.serverId, r.agent)}
        failure={failure}
        busy={busy}
        when={when}
        lastKey={lastKey}
        iconUrl={iconOf(r)}
        inset={ZEN_LIST_CONTENT_INSET}
        divider={divider}
        nextAt={multi.entries[r.serverId]?.nextAt ?? null}
        onOpen={() => openRemote(r)}
        onAction={() => {
          if (failure?.action) multi.act(r.serverId, failure.action);
        }}
      />
    );
  };

  /** A pin from another server: read-only, not draggable (pin writes on
   *  a non-active server are not built yet, MA50); a tap opens a room on
   *  its server, or runs its server's one fix. */
  const renderRemotePin = (r: MergedRow) => {
    const { failure, busy } = remoteView(r);
    const color = busy ? activityColor(busy) : "";
    return (
      <button
        key={r.key}
        type="button"
        className="text-center bg-transparent border-0 p-0"
        style={{ color: "#fff", opacity: failure ? 0.6 : 1 }}
        data-no-pin="1"
        data-testid="remote-pin"
        data-server-id={r.serverId}
        aria-label={
          `Pinned ${r.agent.name}, ${r.serverLabel}` +
          (failure ? `, ${failure.copy}` : busy ? `, ${activityRowText(busy)}` : "")
        }
        onClick={() => {
          if (failure) {
            if (failure.action) multi.act(r.serverId, failure.action);
          } else openRemote(r);
        }}
      >
        <div className="mb-2 flex justify-center" data-testid="pin-avatar">
          <span className="relative inline-flex">
            <WorkspaceAvatar
              initial={r.agent.initial}
              color={r.agent.color}
              iconUrl={iconOf(r)}
              size={ZEN_PIN_AVATAR_PX}
              fontSize={26}
              fallback="#2c2c2e"
            />
            {busy ? (
              <span
                aria-hidden
                data-testid="pin-activity-dot"
                className={`absolute rounded-full ${busy.display === "working" ? "k2-pulse" : ""}`}
                style={{
                  right: 1,
                  bottom: 1,
                  width: 20,
                  height: 20,
                  background: color,
                  color,
                  border: "2.5px solid var(--root)",
                  ["--k2-pulse-edge" as string]: "2.5px",
                }}
              />
            ) : null}
          </span>
        </div>
        <div className="text-[12px] truncate mx-auto" style={{ color: "#d1d1d6", maxWidth: 110 }}>
          {r.agent.name}
        </div>
        {failure ? (
          <div
            className="text-[11px] truncate mx-auto"
            style={{ color: "#8e8e93", maxWidth: 110, lineHeight: 1.3 }}
            data-testid="pin-server"
          >
            {failure.copy}
          </div>
        ) : null}
      </button>
    );
  };

  if (servers.length === 0) return <OverlayAddServer />;

  // Same structure as Login / ChatSession / FeedbackThread: a `fixed`
  // backdrop so an iOS keyboard pan of #root cannot drag the header off
  // screen, plus an inner column sized to visualViewport.height so Search
  // (absolute bottom) already sits above the keyboard.
  return (
    <div
      className="fixed inset-0"
      style={{
        position: "fixed",
        // An iOS pan the scroll reset could not undo (useViewport).
        top: viewportTop,
        left: 0,
        right: 0,
        bottom: 0,
        background:
          "radial-gradient(120% 70% at 50% -20%, #3a3a3c 0%, #000 58%)",
        color: "#fff",
        fontFamily: "var(--zen-font)",
      }}
      data-testid="chats-home"
      onPointerDown={pinDrag.onPointerDown}
      onPointerMove={pinDrag.onPointerMove}
      onPointerUp={pinDrag.onPointerUp}
      onPointerCancel={pinDrag.onPointerUp}
    >
      <div
        className="flex flex-col relative overflow-hidden"
        // On screen (not under an open Thread): keyboard motion plays on
        // the compositor (useKeyboardFlip): final at once on hide, held on
        // show, full during an (open ticket's) interactive dismiss. Hidden
        // under the Thread it just takes the final height.
        ref={zenScreen !== "thread" ? columnTrackRef : undefined}
        style={{
          height:
            zenScreen !== "thread"
              ? keyboardColumnHeight(viewport, fullViewportHeight())
              : containerHeight,
        }}
        data-testid="chats-column"
      >
      {/* Floats over the list from y=0 (under the status bar) with the
          chat header's progressive blur (c39c0ac). The blur and the header
          box pass touches through; only its controls take them, so the
          list scrolls underneath. Below the overlays (zIndex 6). */}
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-no-pin="1"
        data-testid="chats-header"
        style={{
          zIndex: 5,
          paddingTop: "env(safe-area-inset-top)",
          pointerEvents: "none",
        }}
      >
      <div
        className="zen-header-blur zen-header-blur--early"
        data-testid="chats-header-blur"
        data-scrolled={scrolled ? "1" : undefined}
        aria-hidden
      >
        <span className="zen-header-blur-1" />
        <span className="zen-header-blur-2" />
        <span className="zen-header-blur-3" />
        <span className="zen-header-blur-4" />
        <span className="zen-header-tint" />
      </div>
      <div ref={headerRef} className="relative w-full min-w-0" data-testid="chats-header-content">
      <div
        className="grid items-center w-full min-w-0"
        data-testid="chats-header-row"
        style={{
          gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
          minHeight: 44,
          padding: "12px 12px 8px",
          columnGap: 8,
        }}
      >
        <button
          type="button"
          className="flex items-center min-w-0 justify-self-start zen-glass zen-glass-pill"
          style={{
            height: 34,
            maxWidth: 124,
            padding: "0 13px",
            gap: 6,
            color: "#fff",
            pointerEvents: "auto",
          }}
          onClick={() => setServersSheet(true)}
          aria-label={
            multi.on ? (onHome ? "Servers: All" : `Server ${pillLabel}`) : `Server ${serverLabel}`
          }
          title={multi.on ? pillLabel : serverLabel}
          data-testid="chats-header-server"
        >
          <span
            className="shrink-0"
            aria-hidden
            data-testid="server-status-dot"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: multi.on ? pillDot : activeServer ? RECOVERY_DOT[recoveryState] : "#8e8e93",
            }}
          />
          {/* Nickname, never the icon. 124px cap: at 375pt each 1fr column is ~145px. */}
          <span
            className="min-w-0 truncate text-[15px] font-medium"
            data-testid="server-name"
            style={{ letterSpacing: "-0.2px" }}
          >
            {multi.on ? pillLabel : serverLabel}
          </span>
        </button>
        {/* Groups on: the current focus group's name, a tap opens this
            device's switcher. Capped so it never meets the pills at 375pt. */}
        <h1
          className="min-w-0 text-[17px] font-semibold zen-header-text"
          style={{ letterSpacing: "-0.2px", maxWidth: TITLE_MAX_W }}
          data-testid="chats-title"
        >
          {onHome ? (
            <button
              type="button"
              className="flex items-center min-w-0 max-w-full bg-transparent border-0 p-0"
              style={{
                gap: 6,
                color: "#fff",
                font: "inherit",
                letterSpacing: "inherit",
                pointerEvents: "auto",
              }}
              onClick={() => setHomeMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={homeMenu}
              aria-label={`Home ${home.name}`}
              data-testid="chats-title-home"
            >
              <span className="min-w-0 truncate">{home.name}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                className="shrink-0" style={{ opacity: 0.6 }}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          ) : group ? (
            <button
              type="button"
              className="flex items-center min-w-0 max-w-full bg-transparent border-0 p-0"
              style={{
                gap: 6,
                color: "#fff",
                font: "inherit",
                letterSpacing: "inherit",
                pointerEvents: "auto",
              }}
              onClick={() => setGroupMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={groupMenu}
              aria-label={`Focus group ${group.name}`}
              data-testid="chats-title-group"
            >
              {group.color ? (
                <span
                  aria-hidden
                  className="shrink-0"
                  data-testid="chats-title-dot"
                  style={{ width: 8, height: 8, borderRadius: "50%", background: group.color }}
                />
              ) : null}
              <span className="min-w-0 truncate">{title}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                className="shrink-0" style={{ opacity: 0.6 }}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          ) : (
            <span className="block truncate pointer-events-none">{title}</span>
          )}
        </h1>
        <span
          className="flex items-center justify-self-end"
          style={{ gap: 8, pointerEvents: "auto" }}
          data-testid="chats-header-right"
        >
          <button
            type="button"
            className="relative flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{
              width: 34,
              height: 34,
              color: "#fff",
            }}
            onClick={() => setProjectsOpen(true)}
            aria-label="Projects"
            title="Projects"
            data-testid="chats-header-projects"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              data-testid="projects-icon"
            >
              {/* Desktop Zen nav rail Projects (DashboardIcon, ZenNavRailWidget.tsx). */}
              <rect x="3" y="3" width="7" height="9" rx="1" />
              <rect x="14" y="3" width="7" height="5" rx="1" />
              <rect x="14" y="12" width="7" height="9" rx="1" />
              <rect x="3" y="16" width="7" height="5" rx="1" />
            </svg>
            {projectsUnread > 0 ? (
              <span
                className="absolute"
                data-testid="projects-badge"
                aria-hidden
                style={{
                  top: -2,
                  right: -2,
                  minWidth: 15,
                  height: 15,
                  padding: "0 4px",
                  borderRadius: 8,
                  // iMessage unread blue; Tickets keeps amber.
                  background: "#0a84ff",
                  color: "#fff",
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: "15px",
                  textAlign: "center",
                }}
              >
                {projectsUnread > 99 ? "99+" : projectsUnread}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="relative flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{
              width: 34,
              height: 34,
              color: "#fff",
            }}
            onClick={() => setTickets(true)}
            aria-label={ticketsAriaLabel(ticketCounts)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              data-testid="tickets-icon"
            >
              {/* Desktop Zen nav rail TicketIcon (ZenNavRailWidget.tsx). */}
              <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z" />
              <path d="M14 6v2M14 11v2M14 16v2" />
            </svg>
            {badge ? (
              <span
                className="absolute"
                data-testid="tickets-badge"
                data-tone={badge.tone}
                style={{
                  top: -2,
                  right: -2,
                  minWidth: 15,
                  height: 15,
                  padding: "0 4px",
                  borderRadius: 8,
                  // Always amber, whichever count it shows (data-tone says which).
                  background: "#f59e0b",
                  color: "#000",
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: "15px",
                  textAlign: "center",
                }}
              >
                {badge.count > 99 ? "99+" : badge.count}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{
              width: 34,
              height: 34,
              color: "#fff",
            }}
            onClick={() => setSettings(true)}
            aria-label="Settings"
            title="Settings"
          >
            <CogIcon size={18} strokeWidth={1.7} testId="settings-icon" />
          </button>
        </span>
      </div>
      {pinError ? (
        <p
          role="status"
          className="relative px-4 pb-1 text-[13px] truncate zen-header-text"
          style={{ color: "#ff453a" }}
          data-testid="chats-pin-error"
        >
          {pinError}
        </p>
      ) : null}
      </div>
      </header>

      {onHome && homeMenu ? (
        <HomeMenu
          homes={homes}
          currentId={home.id}
          syncedFrom={homeSync?.label ?? null}
          syncNotice={homeSyncNotice?.label ?? null}
          onDismissSyncNotice={dismissHomesSyncNotice}
          onSelect={(id) => useHomesStore.getState().selectHome(id)}
          onCreate={(name) => useHomesStore.getState().createHome(name)}
          onRename={(name) => useHomesStore.getState().renameHome(home.id, name)}
          onDelete={() => useHomesStore.getState().deleteHome(home.id)}
          onClose={() => setHomeMenu(false)}
        />
      ) : null}

      {!onHome && group && groupMenu ? (
        <>
          <button
            type="button"
            aria-label="Close focus groups"
            className="fixed inset-0 bg-transparent border-0 p-0"
            style={{ zIndex: 29 }}
            data-no-pin="1"
            onClick={() => setGroupMenu(false)}
            data-testid="focus-menu-backdrop"
          />
          <div
            role="menu"
            aria-label="Focus groups"
            className="zen-glass absolute"
            data-no-pin="1"
            data-testid="focus-menu"
            style={{
              zIndex: 30,
              top: "calc(env(safe-area-inset-top) + 52px)",
              left: "50%",
              transform: "translateX(-50%)",
              width: "min(260px, calc(100vw - 32px))",
              maxHeight: "50vh",
              overflowY: "auto",
              borderRadius: 16,
              padding: 6,
              color: "#fff",
            }}
          >
            {headerFocus.groups.map((g) => {
              const on = g.id === headerFocus.currentId;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="w-full flex items-center text-left bg-transparent border-0"
                  style={{ gap: 10, padding: "10px 12px", minHeight: 44, borderRadius: 10, color: "#fff" }}
                  onClick={() => {
                    pickFocusGroup(g.id);
                    setGroupMenu(false);
                  }}
                  data-testid={`focus-option-${g.id}`}
                >
                  <span
                    aria-hidden
                    className="shrink-0"
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: g.color || "transparent",
                      boxShadow: g.color ? undefined : "inset 0 0 0 1.5px #8e8e93",
                    }}
                  />
                  <span className="flex-1 min-w-0 truncate text-[16px]">{g.name}</span>
                  <span aria-hidden className="shrink-0" style={{ width: 16, color: "#0a84ff" }}>
                    {on ? (
                      <CheckIcon size={16} strokeWidth={2.6} testId="focus-check" />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      {ptr.pull > 0 || ptr.refreshing ? (
        // Pull to refresh: a spinner under the header; it never moves rows.
        <div
          className="absolute left-0 right-0 flex justify-center pointer-events-none"
          style={{
            top: `calc(env(safe-area-inset-top) + ${headerPx}px + 6px)`,
            zIndex: 4,
            opacity: ptr.refreshing ? 1 : 0.3 + 0.7 * ptr.pull,
          }}
          data-testid="chats-pull-refresh"
          data-state={ptr.refreshing ? "refreshing" : ptr.pull >= 1 ? "armed" : "pulling"}
          aria-hidden
        >
          <span
            className={ptr.refreshing ? "k2-spinner" : undefined}
            style={
              ptr.refreshing
                ? undefined
                : {
                    display: "inline-block",
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    border: "2px solid rgba(255,255,255,.25)",
                    borderTopColor: "#fff",
                    transform: `rotate(${Math.round(ptr.pull * 270)}deg)`,
                  }
            }
          />
        </div>
      ) : null}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          // Starts under the floating header; rows scroll up behind it.
          paddingTop: `calc(env(safe-area-inset-top) + ${headerPx}px)`,
          // Searching: no pin tray, so only clear the keyboard-up bar
          // (bar + its 8px gap + 8px air) — not the resting 96.
          paddingBottom: searching
            ? SEARCH_BAR_HEIGHT + SEARCH_BAR_KEYBOARD_GAP * 2
            : 96,
          WebkitOverflowScrolling: ghost ? "auto" : "touch",
          overflowY: ghost ? "hidden" : "auto",
          touchAction: ghost ? "none" : undefined,
        }}
        data-testid="chats-list"
        onScroll={(e) => {
          // At rest the first row sits right at the header's bottom edge;
          // the early blur strip below the header waits for a scroll.
          setScrolled(e.currentTarget.scrollTop > 0);
        }}
      >
      {onHome ? (
        <HomeList
          views={homeShown.filter((v) => homeRowMatches(v, q))}
          homeName={home.name}
          searching={searching}
          // Recent agents first sorts the Home itself: no Rearrange.
          canRearrange={!recentOn}
          rearranging={homeRearranging}
          onRearrange={() => setRearrangeTab("home")}
          scrollRef={listRef}
          onReorder={(order, moved) => {
            // The moved row takes the slot of the row shown there before
            // (hidden flag-off rows keep their places in storage). Same
            // Home write as any edit, so Homes sync carries it.
            const shown = homeViews.map((v) => v.row.address);
            const next = shown[order.indexOf(moved)];
            const from = home.rows.findIndex((r) => r.address === moved);
            const to = home.rows.findIndex((r) => r.address === next);
            if (from >= 0 && to >= 0) useHomesStore.getState().moveRow(home.id, from, to);
          }}
          inset={ZEN_LIST_CONTENT_INSET}
          previewFor={previewFor}
          onRemove={(address) => useHomesStore.getState().removeRow(home.id, address)}
          hereChip={multi.on && multi.chips ? serverLabel : null}
          activeDown={activeDown}
          remoteLook={multi.on ? homeRemoteLook : undefined}
          onRemoteAction={(v, action) => {
            if (!v.server) return;
            // "Open the old way" opens THIS row after the switch.
            if (action === "switch") {
              const handle = parseHomeAddress(v.row.address)?.handle ?? null;
              void multi.switchOpen(v.server.id, v.resolved?.agent?.id ?? handle);
            } else multi.act(v.server.id, action);
          }}
          onOpenRemote={(v) => {
            const handle = parseHomeAddress(v.row.address)?.handle ?? v.row.address.split("::")[0];
            if (!v.server) {
              setServersSheet(true);
              return;
            }
            // S3b / HM3 (other-server rows show with the flag on only):
            // a ROOM on the row's server, no switch. A row its server no
            // longer lists has nothing to open.
            const agent = v.resolved?.agent ?? null;
            if (v.resolved?.loaded && !agent) return;
            void openHomeRowOnServer(v.server.id, handle, {
              localId: agent?.id ?? null,
              seed: multi.byServer[v.server.id]?.agents,
            });
          }}
        />
      ) : (
      <>
      <span id={ROW_HINT_ID} className="sr-only">
        {agentsRearranging
          ? "Drag a handle to reorder. Tap Done when finished."
          : "Press and hold an agent for options. Hold and drag a pinned agent to reorder."}
      </span>
      {/* Pins only when there are pins: an empty tray is dead space. */}
      {showPins ? (
      <div
        ref={pinsRef}
        className="grid"
        style={{
          // Near the screen edges (3 columns use the width), with 10px of
          // air under the floating header. One or two pins sit centred in
          // the same cells; four+ wrap with the last row left-justified.
          gridTemplateColumns: zenPinGridColumns(pinItems.length),
          justifyContent: pinItems.length < 3 ? "center" : undefined,
          padding: `4px ${ZEN_LIST_EDGE_PAD}px ${ZEN_PIN_GRID_BOTTOM_PX}px`,
          gap: `${ZEN_PIN_ROW_GAP}px ${ZEN_PIN_COL_GAP}px`,
          minHeight: 96,
          margin: `10px ${ZEN_LIST_EDGE_INSET}px 0`,
          borderRadius: 16,
          // Lit while a pin is lifted, and all through Agents Rearrange.
          background: hot || agentsRearranging ? "rgba(10,132,255,.12)" : "transparent",
          outline:
            hot || agentsRearranging ? "1.5px dashed rgba(10,132,255,.5)" : "1.5px dashed transparent",
        }}
        data-testid="chats-pins"
      >
        {pinItems.map((item) => {
          if (!item.active) return renderRemotePin(item.row);
          const a = item.agent;
          // Pins are main chats: their workspace activity.
          const pinBusy =
            source === "live" ? activityForRow(a, activity, false, chatSessions) : null;
          const pinColor = pinBusy ? activityColor(pinBusy) : "";
          // A lifted pin: the others slide between the cells to make room,
          // and the lifted one's cell is the gap it will drop into.
          const shift = pinDrag.offsetOf(a.id);
          return (
            <button
              key={item.key}
              type="button"
              className="text-center bg-transparent border-0 p-0"
              style={{
                color: "#fff",
                touchAction: "none",
                WebkitTouchCallout: "none",
                userSelect: "none",
                transform: shift ? `translate(${shift.dx}px, ${shift.dy}px)` : undefined,
                transition: ghost && !prefersReducedMotion() ? PIN_SHIFT_TRANSITION : undefined,
                opacity: pinDrag.draggingId === a.id ? 0 : undefined,
              }}
              data-pin-id={a.id}
              data-pin-from="pin"
              aria-label={`Pinned ${a.name}` + (pinBusy ? `, ${activityRowText(pinBusy)}` : "")}
              aria-haspopup="menu"
              aria-expanded={pinMenuOn?.id === a.id}
              aria-describedby={ROW_HINT_ID}
              onClick={() => {
                if (rearranging) return;
                onPinClick(a.id);
              }}
              onContextMenu={(e) => {
                // Desktop right-click / Android long-press: same menu.
                e.preventDefault();
                if (!rearranging) pinDrag.openMenuFor(a.id, e.currentTarget);
              }}
            >
              <div className="mb-2 flex justify-center" data-testid="pin-avatar">
                <span className="relative inline-flex">
                  {source === "live" ? <UnreadDot unread={rowUnread(zen.id, a)} side={14} /> : null}
                  <WorkspaceAvatar
                    initial={a.initial}
                    color={a.color}
                    iconUrl={a.iconUrl}
                    size={ZEN_PIN_AVATAR_PX}
                    fontSize={26}
                    fallback="#2c2c2e"
                  />
                  {pinBusy ? (
                    <span
                      aria-hidden
                      data-testid="pin-activity-dot"
                      className={`absolute rounded-full ${pinBusy.display === "working" ? "k2-pulse" : ""}`}
                      style={{
                        // On the circle's edge at 4:30, sized up for 74px.
                        right: 1,
                        bottom: 1,
                        width: 20,
                        height: 20,
                        background: pinColor,
                        color: pinColor,
                        border: "2.5px solid var(--root)",
                        ["--k2-pulse-edge" as string]: "2.5px",
                      }}
                    />
                  ) : null}
                </span>
              </div>
              <div
                className="text-[12px] truncate mx-auto"
                style={{ color: "#d1d1d6", maxWidth: 110 }}
              >
                {a.name}
              </div>
              {pinBusy ? (
                <div
                  className="text-[11px] truncate mx-auto"
                  style={{ color: pinColor, maxWidth: 110, lineHeight: 1.3 }}
                  data-testid="pin-activity"
                >
                  {activityPinText(pinBusy)}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
      ) : null}
        {source === "loading" ? (
          <p className="py-6 text-[14px]" style={{ ...LIST_LINE_SIDES, color: "#8e8e93" }}>
            Loading
          </p>
        ) : null}
        {source !== "loading" && (agentError || activeDown) && (rows.length > 0 || showPins) ? (
          <p className="py-3 text-[14px]" style={{ ...LIST_LINE_SIDES, color: activeDown ? "#8e8e93" : "#f59e0b" }}>
            {activeDown ? reconnectingLine : agentError}
          </p>
        ) : null}
        {multi.on ? <LoadingLines loads={multi.loads} inset={ZEN_LIST_CONTENT_INSET} /> : null}
        {source !== "loading" && listItems.length === 0 && !showPins && placeholders.length === 0 ? (
          <p
            className="py-6 text-[14px]"
            style={{ ...LIST_LINE_SIDES, color: "#8e8e93" }}
            data-testid="chats-empty"
          >
            {activeDown && source !== "stub" ? reconnectingLine : agentError || "No agents on this list."}
          </p>
        ) : null}
        {listItems.map((item, i) => {
          // A hairline between rows: none under the last one.
          const divided = i < listItems.length - 1;
          if (!item.active) return renderRemoteRow(item.row, divided);
          const a = item.agent;
          const lastKey = source === "live" ? lastAtKeyFor(zen.id, a) ?? undefined : undefined;
          const when =
            lastKey && lastAtByKey[lastKey] != null
              ? mountainListWhen(lastAtByKey[lastKey] as number)
              : "";
          const preview = previewFor(a);
          const busy =
            source === "live"
              ? activityForRow(a, activity, isOverlayExtraAddr(a.addr), chatSessions)
              : null;
          const fresh =
            !!newRowPath && !!a.path && posixNormalize(a.path) === newRowPath;
          const grip = agentsRearranging && reorderIds.has(a.id);
          const shift = rearrange.offsetFor(item.key);
          return (
          <div
            key={item.key}
            // Full width, so the tap / hold target is the whole line; the
            // row's content is inset to the pinned avatars' width below.
            className="relative"
            data-agent-row={a.id}
            data-rearrange-key={grip ? item.key : undefined}
            data-dragging={shift.dragging ? "1" : undefined}
            data-new-workspace={fresh ? "1" : undefined}
            style={{
              background: shift.dragging
                ? "rgba(44,44,46,.92)"
                : fresh
                  ? "rgba(10,132,255,.22)"
                  : undefined,
              transform: shift.y ? `translateY(${shift.y}px)` : undefined,
              transition:
                [fresh ? "background 600ms" : "", shift.transition === "none" ? "" : shift.transition]
                  .filter(Boolean)
                  .join(", ") || undefined,
              zIndex: shift.dragging ? 3 : undefined,
              boxShadow: shift.dragging ? "0 10px 28px rgba(0,0,0,.45)" : undefined,
              borderRadius: shift.dragging ? 14 : undefined,
            }}
          >
          {grip ? (
            <GripHandle name={a.name} inset={ZEN_LIST_CONTENT_INSET} handlers={rearrange.handleProps(item.key)} />
          ) : null}
          <button
            type="button"
            className="w-full flex items-center text-left relative"
            style={{
              gap: 10,
              // Avatar's left and the when/chevron's right line up with the
              // outer edges of the first and third pinned avatars.
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: rearrangePadLeft(ZEN_LIST_CONTENT_INSET, agentsRearranging),
              paddingRight: ZEN_LIST_CONTENT_INSET,
              touchAction: ghost ? "none" : "pan-y",
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTouchCallout: "none",
              transition: rearrange.reduced ? undefined : "padding-left 200ms cubic-bezier(.2,.9,.25,1)",
            }}
            {...rowHold.bind(a.id, !rearranging)}
            onClick={() => {
              if (rowHold.consumeSkipClick() || rearranging) return;
              setAgent(a.id);
            }}
            aria-describedby={ROW_HINT_ID}
            aria-haspopup={rearranging ? undefined : "menu"}
            aria-expanded={rearranging ? undefined : rowMenuOn?.id === a.id}
            aria-label={
              source === "stub"
                ? `STUB ${a.name}`
                : busy
                  ? `${a.name}, ${activityRowText(busy)}`
                  : [a.name, rowPreviewText(rowPreviewOf(a))].filter(Boolean).join(", ")
            }
            data-last-at-key={lastKey}
            data-pin-id={a.id}
            data-pin-from="list"
          >
            <AgentRowContent
              name={a.name}
              initial={a.initial}
              color={a.color}
              iconUrl={a.iconUrl}
              busy={busy}
              when={when}
              preview={preview}
              stub={source === "stub"}
              unread={source === "live" ? rowUnread(zen.id, a) : null}
            />
          </button>
          {divided && !shift.dragging ? (
            <RowDivider
              padLeft={rearrangePadLeft(ZEN_LIST_CONTENT_INSET, agentsRearranging)}
              padRight={ZEN_LIST_CONTENT_INSET}
              transition={rearrange.reduced ? undefined : "left 200ms cubic-bezier(.2,.9,.25,1)"}
            />
          ) : null}
          </div>
          );
        })}
        {placeholders.map((p) => (
          <ServerPlaceholderRow
            key={`server:${p.serverId}`}
            serverId={p.serverId}
            label={p.label}
            failure={p.failure}
            note={p.note}
            nextAt={p.nextAt}
            inset={ZEN_LIST_CONTENT_INSET}
            onAction={() => {
              if (p.failure?.action) multi.act(p.serverId, p.failure.action);
            }}
          />
        ))}
      </>
      )}
      </div>

      {pinMenuOn && pinMenuAgent ? (
        <AgentMenu
          label={`Options for pinned ${pinMenuAgent.name}`}
          menu={pinMenuOn}
          entries={agentMenuEntries(pinMenuAgent, true)}
          onClose={closeMenu}
          align="center"
          testId="pin-menu"
        />
      ) : null}
      {rowMenuOn && rowMenuAgent ? (
        <AgentMenu
          label={`Options for ${rowMenuAgent.name}`}
          menu={rowMenuOn}
          entries={agentMenuEntries(rowMenuAgent, false)}
          onClose={rowHold.close}
          testId="row-menu"
        />
      ) : null}

      {ghost ? (
        <div
          data-testid="pin-ghost"
          className="pointer-events-none text-center"
          style={{
            position: "fixed",
            left: ghost.x,
            top: ghost.y,
            transform: "translate(-50%, -50%)",
            zIndex: 20,
            opacity: 0.9,
          }}
        >
          <div className="mb-2 flex justify-center">
            <WorkspaceAvatar
              initial={ghost.initial}
              color={ghost.color}
              iconUrl={ghost.iconUrl}
              size={74}
              fontSize={26}
              fallback="#2c2c2e"
            />
          </div>
          <div className="text-[12px]" style={{ color: "#d1d1d6" }}>
            {ghost.title}
          </div>
        </div>
      ) : null}

      {groupToast ? (
        <div
          role="status"
          className="zen-glass zen-glass-pill absolute flex items-center"
          data-no-pin="1"
          data-testid="group-toast"
          style={{
            zIndex: 6,
            left: "50%",
            transform: "translateX(-50%)",
            bottom: `calc(${SEARCH_BAR_REST_BOTTOM} + ${SEARCH_BAR_HEIGHT + 10}px)`,
            maxWidth: "calc(100vw - 32px)",
            height: 40,
            padding: "0 6px 0 16px",
            gap: 8,
            color: "#fff",
          }}
        >
          <span className="min-w-0 truncate text-[15px]" data-testid="group-toast-text">
            {groupToast.text}
          </span>
          <button
            type="button"
            className="shrink-0 bg-transparent border-0 text-[15px] font-semibold"
            style={{ color: "#0a84ff", minHeight: 40, padding: "0 10px" }}
            onClick={undoGroup}
            data-testid="group-toast-undo"
          >
            Undo
          </button>
        </div>
      ) : null}

      {pickAgent ? (
        <FocusGroupPicker
          agentName={pickAgent.name}
          groups={focus.groups}
          currentId={rowFocusGroupId(pickAgent, serverProjects)}
          onPick={(gid) => assignGroup(pickAgent.id, gid)}
          onCreate={(name) => createGroup(pickAgent.id, name)}
          onClose={() => setGroupPick(null)}
        />
      ) : null}

      {rearranging ? <RearrangeDone onDone={() => setRearrangeTab(null)} /> : null}

      <GlassSearchBar
        query={q}
        onQuery={setQ}
        placeholder="Search"
        leading={<HomeTabToggle tab={tab} onTab={setTab} />}
        onPlus={() => (onHome ? setAddAgent(true) : setNewWorkspace(true))}
        plusLabel={onHome ? "Add agent" : "New workspace"}
        plusBlockedNote={onHome || canCreate ? null : createRoleNote()}
        barRef={searchBarRef}
        blurRef={searchBlurRef}
      />

      {projectsOpen ? <ProjectsOverlay onClose={() => setProjectsOpen(false)} /> : null}
      {tickets ? (
        <TicketsOverlay
          key={deepTicket ?? "list"}
          initialTicketId={deepTicket}
          onClose={() => {
            setTickets(false);
            setDeepTicket(null);
          }}
        />
      ) : null}
      {addAgent && onHome ? (
        <AddAgentSheet
          home={home}
          hostKey={activeHomeHost}
          agents={chatRows}
          projects={serverProjects}
          groups={groupsOn && focus.groups.length > 0 ? focus.groups : null}
          otherServers={multi.on ? otherServersForPicker(servers, activeServerId, tokens, labelOf) : []}
          renderOtherBody={
            multi.on
              ? (sv, query) => (
                  <OtherServerSection
                    server={sv}
                    label={multi.labelFor(sv.id)}
                    q={query}
                    home={home}
                    signingIn={multi.signInFor === sv.id}
                    onAdd={(row) => useHomesStore.getState().addRow(home.id, row)}
                    onRemove={(address) => useHomesStore.getState().removeRow(home.id, address)}
                    onSignIn={() => multi.setSignInFor(sv.id)}
                    onRetry={() => {
                      retryServerNow(sv.id);
                      void loadServerRows(sv.id);
                    }}
                  />
                )
              : undefined
          }
          onAdd={(row) => useHomesStore.getState().addRow(home.id, row)}
          onRemove={(address) => useHomesStore.getState().removeRow(home.id, address)}
          onClose={() => setAddAgent(false)}
        />
      ) : null}
      {newWorkspace ? (
        <NewWorkspaceSheet
          onClose={() => setNewWorkspace(false)}
          onListed={(path) => setNewRowPath(path)}
        />
      ) : null}
      {serversSheet ? <OverlayServers onClose={() => setServersSheet(false)} /> : null}
      {multi.on && multi.signInFor ? (
        // MS34 / MA3: sign in to THAT server without switching the active
        // one (the active server's own sign-in keeps today's flow).
        <div
          className="absolute inset-0 flex flex-col"
          // Above the Add Agent sheet (z 30) when signing in from its
          // Other servers segment.
          style={{ background: "#000", zIndex: addAgent ? 40 : 6, paddingTop: "env(safe-area-inset-top)" }}
          data-testid="row-sign-in"
        >
          <OverlayAddServer
            key={multi.signInFor}
            editingId={multi.signInFor}
            activate={multi.signInFor === activeServerId}
            onCancel={() => multi.setSignInFor(null)}
            onSaved={() => multi.setSignInFor(null)}
            onSignedIn={(id) => {
              if (id === activeServerId) return;
              retryServerNow(id);
              void loadServerRows(id);
            }}
          />
        </div>
      ) : null}

      {settings ? <ZenSettings onClose={() => setSettings(false)} /> : null}
      </div>
    </div>
  );
}
