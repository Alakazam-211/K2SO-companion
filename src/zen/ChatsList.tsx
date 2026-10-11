import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useFeedbackStore } from "../stores/feedback";
import { ticketsAriaLabel, ticketsBadge } from "../api/feedbackPure";
import { hostLabel, useServersStore, type RecoveryState } from "../stores/servers";
import { isOverlayExtraAddr, visibleOverlayAgents } from "./overlayExtras";
import { overlayRowPreview } from "./rowPreview";
import { activityColor, activityForRow, activityPinText, activityRowText } from "./agentActivity";
import { StubMark } from "./StubMark";
import { OverlayAddServer } from "./OverlayAddServer";
import {
  GlassSearchBar,
  SEARCH_BAR_HEIGHT,
  SEARCH_BAR_KEYBOARD_GAP,
  SEARCH_BAR_REST_BOTTOM,
} from "./GlassSearchBar";
import { OverlayCompose } from "./OverlayCompose";
import { OverlayServers } from "./OverlayServers";
import { TicketsOverlay, useTicketWaitingCounts } from "./TicketsOverlay";
import { lastAtKeyFor, sortChatsByRecency } from "./lastAtFetch";
import {
  currentFocusGroup,
  filterByFocus,
  listTitle,
  pinProjectIdForRow,
  rowFocusGroupId,
} from "./serverPins";
import { connectProjectEvents } from "./ticketEvents";
import { mountainListWhen } from "./threadModel";
import { usePinDrag } from "./usePinDrag";
import { SWIPE_ACTION_W, swipeReveal, useRowSwipe } from "./useRowSwipe";
import { FocusGroupPicker } from "./FocusGroupPicker";
import "./swipePin.css";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { ZenSettings } from "./ZenSettings";
import { useZenStore } from "./zenStore";
import { zenTextPx } from "./zenFont";

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

/** iOS system yellow, the Messages pin action. */
const PIN_YELLOW = "#ffd60a";
const SWIPE_HINT_ID = "chats-swipe-hint";
/** How long "Moved to Work · Undo" stays up after a group change. */
export const GROUP_TOAST_MS = 4000;
/** Title cap: at 375pt the side columns keep ~100px for the pills. */
const TITLE_MAX_W = "min(34vw, 140px)";
/** Resting header content height below the safe area: 44 row + 12/8 pad. */
export const CHATS_HEADER_PX = 64;
/**
 * Pin grid geometry. The grid box sits EDGE_INSET from the screen with
 * EDGE_PAD of padding inside; three equal columns, COL_GAP apart, each with
 * a PIN_AVATAR_PX circle centred in it. The outer avatars' edge sits at
 * (2/3)side + W/6 - gap/3 - avatar/2, so a wider COL_GAP pushes the first
 * and last avatars (and the list inset that follows them) toward the
 * edges while the grid box keeps its 4px drop-outline margin. 31 puts the
 * avatars ~19px in at 375pt and ~28px at 430pt. Cells are then ~100px at
 * 375pt, so pinned names truncate at the cell there (110px cap above that).
 */
export const ZEN_LIST_EDGE_INSET = 4;
export const ZEN_LIST_EDGE_PAD = 2;
export const ZEN_PIN_COL_GAP = 31;
export const ZEN_PIN_ROW_GAP = 14;
export const ZEN_PIN_AVATAR_PX = 74;
const PIN_SIDE_PX = ZEN_LIST_EDGE_INSET + ZEN_LIST_EDGE_PAD;

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
 * the "Drop to pin" strip and the empty lines all use it (pins or not), so
 * list content spans exactly the pinned avatars' visible width.
 */
export const ZEN_LIST_CONTENT_INSET =
  `calc(${PIN_SIDE_PX}px + ((100% - ${2 * PIN_SIDE_PX + 2 * ZEN_PIN_COL_GAP}px) / 3 - ${ZEN_PIN_AVATAR_PX}px) / 2)`;
/** Side padding for the list's plain text lines (loading, error, empty). */
const LIST_LINE_SIDES = {
  paddingLeft: ZEN_LIST_CONTENT_INSET,
  paddingRight: ZEN_LIST_CONTENT_INSET,
} as const;

/** Swipe-right action: lucide "folders" (stacked folders). */
function GroupGlyph() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-testid="group-glyph"
    >
      <path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z" />
      <path d="M2 8v11a2 2 0 0 0 2 2h14" />
    </svg>
  );
}

function PinGlyph({ off }: { off: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-testid={off ? "unpin-glyph" : "pin-glyph"}
    >
      {/* lucide "pin" / "pin-off". */}
      {off ? (
        <>
          <path d="M12 17v5" />
          <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
          <path d="m2 2 20 20" />
          <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
        </>
      ) : (
        <>
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </>
      )}
    </svg>
  );
}

export function ChatsList() {
  const containerHeight = useViewportHeight();
  const agents = useZenStore((s) => s.agents);
  const source = useZenStore((s) => s.agentSource);
  const agentError = useZenStore((s) => s.agentError);
  const setAgent = useZenStore((s) => s.setAgent);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const ensureLastAt = useZenStore((s) => s.ensureLastAt);
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
  const listRef = useRef<HTMLDivElement | null>(null);
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
  const pinDrag = usePinDrag(pinsRef, canPin);
  const { ghost, hot, consumeSkipClick, onPinClick, menu: pinMenu, closeMenu } = pinDrag;
  // The pin menu only acts on a fresh press: the release of the hold that
  // opened it (or iOS's synthetic click) must not hit Open / Unpin / close.
  const pinMenuPressed = useRef(false);
  useEffect(() => {
    pinMenuPressed.current = false;
  }, [pinMenu]);
  const pinMenuAct = (fn: () => void) => {
    if (!pinMenuPressed.current) return;
    pinMenuPressed.current = false;
    fn();
  };
  const [scrolled, setScrolled] = useState(false);
  // Swipe right assigns the row's workspace to a focus group. Groups off:
  // no swipe action at all. Same rows as pins (groups are per workspace).
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
  const swipe = useRowSwipe(openGroupPicker, canGroup);
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
    swipe.close();
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
    swipe.close();
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
  const group = currentFocusGroup(focus);
  const title = listTitle(focus);
  const pinned = pinnedIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is (typeof agents)[number] => !!a);
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState(false);
  const [tickets, setTickets] = useState(false);
  const [compose, setCompose] = useState(false);
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

  const searching = q.trim().length > 0;
  // Search ignores the focus group so any agent can still be found.
  const visible = visibleOverlayAgents(agents, q, hiddenSidecarAddrs);
  const filtered = sortChatsByRecency(
    searching ? visible : filterByFocus(visible, focus, serverProjects, pinnedIds),
    lastAtByKey,
    lastAtKeyFor
  );
  // Each agent shows once: in the pin grid, or in the list. Search hides
  // the grid, so there every hit (pinned too) is a row.
  const showPins = !searching && pinned.length > 0;
  const pinnedInGrid = new Set(showPins ? pinned.map((a) => a.id) : []);
  const rows = showPins ? filtered.filter((a) => !pinnedInGrid.has(a.id)) : filtered;
  const menuAgent = pinMenu ? pinned.find((a) => a.id === pinMenu.id) ?? null : null;
  const serverListsAt = useRef(Date.now());

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
    const events = connectProjectEvents(() => void useZenStore.getState().refreshPins());
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      events.stop();
    };
  }, [live, activeServerId]);

  useEffect(() => {
    if (!group) setGroupMenu(false);
  }, [group]);

  // A pin that left the grid (unpinned elsewhere, or search) drops its menu.
  useEffect(() => {
    if (pinMenu && (!showPins || !menuAgent)) closeMenu();
  }, [pinMenu, showPins, menuAgent, closeMenu]);

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
    useFeedbackStore.getState().ensureLive();
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
      const key = lastAtKeyFor(a);
      if (key) ensureLastAt(key);
    }
  }, [agents, source, ensureLastAt]);

  useEffect(() => {
    if (source !== "live") return;
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
  }, [rows, source, ensureLastAt]);

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
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background:
          "radial-gradient(120% 70% at 50% -20%, #3a3a3c 0%, #000 58%)",
        color: "#fff",
        fontFamily: "var(--zen-font)",
      }}
      data-testid="chats-home"
      onPointerDown={(e) => {
        swipe.onPointerDown(e);
        pinDrag.onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (swipe.onPointerMove(e, pinDrag.isLifted())) {
          pinDrag.abort();
          return;
        }
        pinDrag.onPointerMove(e);
      }}
      onPointerUp={(e) => {
        swipe.onPointerUp();
        pinDrag.onPointerUp(e);
      }}
      onPointerCancel={(e) => {
        swipe.onPointerCancel();
        pinDrag.onPointerUp(e);
      }}
    >
      <div
        className="flex flex-col relative overflow-hidden"
        style={{ height: containerHeight }}
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
          aria-label={`Server ${serverLabel}`}
          title={serverLabel}
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
              background: activeServer ? RECOVERY_DOT[recoveryState] : "#8e8e93",
            }}
          />
          {/* Nickname, never the icon. 124px cap: at 375pt each 1fr column is ~145px. */}
          <span
            className="min-w-0 truncate text-[15px] font-medium"
            data-testid="server-name"
            style={{ letterSpacing: "-0.2px" }}
          >
            {serverLabel}
          </span>
        </button>
        {/* Groups on: the current focus group's name, a tap opens this
            device's switcher. Capped so it never meets the pills at 375pt. */}
        <h1
          className="min-w-0 text-[17px] font-semibold zen-header-text"
          style={{ letterSpacing: "-0.2px", maxWidth: TITLE_MAX_W }}
          data-testid="chats-title"
        >
          {group ? (
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
              data-testid="settings-icon"
            >
              {/* Cog (lucide "settings"). */}
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
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

      {group && groupMenu ? (
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
            {focus.groups.map((g) => {
              const on = g.id === focus.currentId;
              return (
                <button
                  key={g.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="w-full flex items-center text-left bg-transparent border-0"
                  style={{ gap: 10, padding: "10px 12px", minHeight: 44, borderRadius: 10, color: "#fff" }}
                  onClick={() => {
                    selectFocusGroup(g.id);
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
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" data-testid="focus-check">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      {/* No pins: a hold-drag still needs somewhere to land. A zero-height
          anchor at the header's bottom edge, so the strip floats over the
          list (and above the header blur) without shifting the row under
          the finger. */}
      {!searching && pinned.length === 0 && hot ? (
        <div
          className="absolute left-0 right-0"
          style={{
            top: `calc(env(safe-area-inset-top) + ${headerPx}px)`,
            height: 0,
            zIndex: 5,
          }}
          data-no-pin="1"
        >
          <div
            ref={pinsRef}
            className="k2-pin-drop absolute"
            // The pinned avatars' width: where the grid's avatars will land.
            style={{ top: 4, left: ZEN_LIST_CONTENT_INSET, right: ZEN_LIST_CONTENT_INSET }}
            data-testid="chats-pin-drop"
          >
            <PinGlyph off={false} />
            Drop to pin
          </div>
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
          if (swipe.openId) swipe.close();
          // At rest the first row sits right at the header's bottom edge;
          // the early blur strip below the header waits for a scroll.
          setScrolled(e.currentTarget.scrollTop > 0);
        }}
      >
      <span id={SWIPE_HINT_ID} className="sr-only">
        {groupsOn ? "Swipe right to add to a focus group. " : ""}
        Press and hold, then drag to the top to pin.
        Press and hold a pinned agent for Open and Unpin.
      </span>
      {/* Pins only when there are pins: an empty tray is dead space. */}
      {showPins ? (
      <div
        ref={pinsRef}
        className="grid grid-cols-3"
        style={{
          // Near the screen edges (3 columns use the width), with 10px of
          // air under the floating header.
          padding: `4px ${ZEN_LIST_EDGE_PAD}px 8px`,
          gap: `${ZEN_PIN_ROW_GAP}px ${ZEN_PIN_COL_GAP}px`,
          minHeight: 96,
          margin: `10px ${ZEN_LIST_EDGE_INSET}px 0`,
          borderRadius: 16,
          background: hot ? "rgba(10,132,255,.12)" : "transparent",
          outline: hot ? "1.5px dashed rgba(10,132,255,.5)" : "1.5px dashed transparent",
        }}
        data-testid="chats-pins"
      >
        {pinned.map((a) => {
          // Pins are main chats: their workspace activity.
          const pinBusy =
            source === "live" ? activityForRow(a, activity, false, chatSessions) : null;
          const pinColor = pinBusy ? activityColor(pinBusy) : "";
          return (
            <button
              key={a.id}
              type="button"
              className="text-center bg-transparent border-0 p-0"
              style={{
                color: "#fff",
                touchAction: "none",
                WebkitTouchCallout: "none",
                userSelect: "none",
              }}
              data-pin-id={a.id}
              data-pin-from="pin"
              aria-label={`Pinned ${a.name}` + (pinBusy ? `, ${activityRowText(pinBusy)}` : "")}
              aria-haspopup="menu"
              aria-expanded={pinMenu?.id === a.id}
              onClick={() => onPinClick(a.id)}
              onContextMenu={(e) => {
                // Desktop right-click / Android long-press: same menu.
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                pinDrag.openMenuFor(a.id, {
                  left: r.left,
                  top: r.top,
                  right: r.right,
                  bottom: r.bottom,
                  width: r.width,
                });
              }}
            >
              <div className="mb-2 flex justify-center" data-testid="pin-avatar">
                <span className="relative inline-flex">
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
        {source !== "loading" && agentError && (rows.length > 0 || showPins) ? (
          <p className="py-3 text-[14px]" style={{ ...LIST_LINE_SIDES, color: "#f59e0b" }}>
            {agentError}
          </p>
        ) : null}
        {source !== "loading" && rows.length === 0 && !showPins ? (
          <p
            className="py-6 text-[14px]"
            style={{ ...LIST_LINE_SIDES, color: "#8e8e93" }}
            data-testid="chats-empty"
          >
            {agentError || "No agents on this list."}
          </p>
        ) : null}
        {rows.map((a) => {
          const lastKey = source === "live" ? lastAtKeyFor(a) ?? undefined : undefined;
          const when =
            lastKey && lastAtByKey[lastKey] != null
              ? mountainListWhen(lastAtByKey[lastKey] as number)
              : "";
          const preview =
            source === "stub" ? "STUB" : overlayRowPreview(a);
          const busy =
            source === "live"
              ? activityForRow(a, activity, isOverlayExtraAddr(a.addr), chatSessions)
              : null;
          const busyColor = busy ? activityColor(busy) : "var(--success)";
          const rowCanGroup = canGroup(a.id);
          const rowGroupId = rowCanGroup ? rowFocusGroupId(a, serverProjects) : null;
          const rowGroup = rowGroupId
            ? focus.groups.find((g) => g.id === rowGroupId) ?? null
            : null;
          const sw = swipe.offsetFor(a.id);
          const reveal = swipeReveal(sw.x, swipe.reduced);
          return (
          <div
            key={a.id}
            // Full width, so the tap / swipe target is the whole line; the
            // row's content is inset to the pinned avatars' width below.
            className="relative overflow-hidden"
            data-swipe-row={a.id}
          >
          {/* Leading swipe action: a round glass Group button revealed as
              the row slides right. The button is the whole revealed strip
              (row height, so the hit target stays over 44px); the strip
              itself is clear, only the glass circle is drawn. None with
              groups off, or on rows that are not a workspace (sidecars,
              project groups). It starts at the content inset, so the glass
              sits right beside the slid avatar, and stays above the row's
              left padding while revealed so the whole circle is tappable. */}
          {rowCanGroup ? (
          <button
            type="button"
            className="absolute top-0 bottom-0 overflow-hidden border-0 p-0 bg-transparent"
            style={{
              left: ZEN_LIST_CONTENT_INSET,
              width: sw.x,
              zIndex: sw.x > 0 ? 1 : undefined,
              background: "transparent",
              transition: swipe.transition(sw.dragging, ["width"]),
            }}
            onClick={() => {
              swipe.close();
              openGroupPicker(a.id);
            }}
            aria-label={
              rowGroup ? `Group ${a.name}, in ${rowGroup.name}` : `Group ${a.name}`
            }
            data-swipe-action="1"
            data-no-pin="1"
            data-testid={`swipe-action-${a.id}`}
          >
            <span
              className="absolute top-0 bottom-0 flex flex-col items-center justify-center"
              style={{
                width: SWIPE_ACTION_W,
                // Sits at the left while revealing; on an over-swipe it
                // rides the avatar's leading edge.
                left: Math.max(0, sw.x - SWIPE_ACTION_W),
                gap: 4,
                opacity: reveal.opacity,
                transition: swipe.transition(sw.dragging, ["opacity", "left"]),
              }}
              aria-hidden
              data-testid="swipe-action-reveal"
            >
              <span
                className="k2-swipe-pin k2-swipe-group"
                style={{
                  color: rowGroup?.color || "#fff",
                  transform: `scale(${reveal.scale})`,
                  transition: swipe.reduced
                    ? "none"
                    : swipe.transition(sw.dragging, ["transform"]),
                }}
                data-armed={sw.full ? "1" : undefined}
                data-testid="swipe-action-glass"
              >
                <span
                  className="flex"
                  style={{
                    transform: sw.full && !swipe.reduced ? "scale(1.2)" : "scale(1)",
                    transition: swipe.reduced ? "none" : "transform 160ms cubic-bezier(.3,1.6,.5,1)",
                  }}
                  data-testid="swipe-action-glyph"
                >
                  <GroupGlyph />
                </span>
              </span>
              <span
                className="k2-swipe-pin-label truncate text-center"
                style={{ maxWidth: SWIPE_ACTION_W - 8 }}
                data-testid="swipe-action-label"
              >
                {rowGroup?.name || "Group"}
              </span>
            </span>
          </button>
          ) : null}
          <button
            type="button"
            className="w-full flex items-center text-left relative"
            style={{
              gap: 10,
              // Avatar's left and the when/chevron's right line up with the
              // outer edges of the first and third pinned avatars.
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: ZEN_LIST_CONTENT_INSET,
              paddingRight: ZEN_LIST_CONTENT_INSET,
              touchAction: ghost ? "none" : "pan-y",
              transform: `translateX(${sw.x}px)`,
              transition: swipe.transition(sw.dragging, ["transform"]),
            }}
            onClick={() => {
              const swiped = swipe.consumeSkipClick();
              const held = consumeSkipClick();
              if (swiped || held) return;
              setAgent(a.id);
            }}
            aria-describedby={SWIPE_HINT_ID}
            aria-label={
              source === "stub"
                ? `STUB ${a.name}`
                : (isOverlayExtraAddr(a.addr)
                    ? `${a.name}, ${overlayRowPreview(a)}`
                    : a.name) + (busy ? `, ${activityRowText(busy)}` : "")
            }
            data-last-at-key={lastKey}
            data-pin-id={a.id}
            data-pin-from="list"
          >
            <span className="relative shrink-0">
              <WorkspaceAvatar
                initial={a.initial}
                color={a.color}
                iconUrl={a.iconUrl}
                size={50}
                fontSize={18}
              />
              {busy ? (
                <span
                  aria-hidden
                  data-testid="row-activity-dot"
                  className={`absolute rounded-full ${busy.display === "working" ? "k2-pulse" : ""}`}
                  style={{
                    right: -1,
                    bottom: -1,
                    width: 14,
                    height: 14,
                    background: busyColor,
                    color: busyColor,
                    border: "2.5px solid var(--root)",
                    // The pulse ring starts outside the cutout border.
                    ["--k2-pulse-edge" as string]: "2.5px",
                  }}
                />
              ) : null}
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex justify-between items-baseline gap-2">
                <span
                  className="min-w-0 truncate font-semibold"
                  style={{ fontSize: zenTextPx(16), letterSpacing: "-0.2px" }}
                  data-testid="row-name"
                >
                  {a.name}
                </span>
                {source === "stub" ? (
                  <StubMark />
                ) : (
                  <span
                    className="shrink-0 flex items-center gap-1"
                    style={{ color: "#8e8e93", fontWeight: 400, fontSize: zenTextPx(14) }}
                    data-testid="row-when"
                  >
                    {when}
                    {when ? " " : ""}
                    ›
                  </span>
                )}
              </span>
              {busy ? (
                <span
                  className="block truncate"
                  style={{ color: busyColor, lineHeight: 1.3, fontSize: zenTextPx(14) }}
                  data-testid="row-activity"
                >
                  {activityRowText(busy)}
                </span>
              ) : (
                <span
                  className="block truncate"
                  style={{ color: "#8e8e93", lineHeight: 1.3, fontSize: zenTextPx(14) }}
                  data-testid="row-preview"
                >
                  {preview}
                </span>
              )}
            </span>
          </button>
          </div>
          );
        })}
      </div>

      {pinMenu && menuAgent ? (
        <div
          data-no-pin="1"
          onPointerDownCapture={() => {
            pinMenuPressed.current = true;
          }}
        >
          <button
            type="button"
            aria-label="Close pin menu"
            className="fixed inset-0 bg-transparent border-0 p-0"
            style={{ zIndex: 29 }}
            onClick={() => pinMenuAct(closeMenu)}
            data-testid="pin-menu-backdrop"
          />
          <div
            role="menu"
            aria-label={`${menuAgent.name} pin`}
            className="zen-glass fixed"
            data-testid="pin-menu"
            style={{
              zIndex: 30,
              // Under the avatar, so the holding finger is not on an item.
              top: (pinMenu.rect?.bottom ?? 120) + 6,
              left: `clamp(12px, ${
                pinMenu.rect ? pinMenu.rect.left + pinMenu.rect.width / 2 : 0
              }px - 100px, calc(100vw - 212px))`,
              width: 200,
              borderRadius: 16,
              padding: 6,
              color: "#fff",
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center text-left bg-transparent border-0"
              style={{ gap: 10, padding: "10px 12px", minHeight: 44, borderRadius: 10, color: "#fff" }}
              onClick={() =>
                pinMenuAct(() => {
                  closeMenu();
                  setAgent(menuAgent.id);
                })
              }
              data-testid="pin-menu-open"
            >
              <span className="flex-1 text-[16px]">Open</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center text-left bg-transparent border-0"
              style={{ gap: 10, padding: "10px 12px", minHeight: 44, borderRadius: 10, color: "#fff" }}
              onClick={() =>
                pinMenuAct(() => {
                  closeMenu();
                  void useZenStore.getState().unpinChat(menuAgent.id);
                })
              }
              data-testid="pin-menu-unpin"
            >
              <span className="flex-1 text-[16px]">Unpin</span>
              <span aria-hidden className="flex shrink-0" style={{ color: PIN_YELLOW }}>
                <PinGlyph off />
              </span>
            </button>
          </div>
        </div>
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
          onClose={() => {
            setGroupPick(null);
            swipe.close();
          }}
        />
      ) : null}

      <GlassSearchBar
        query={q}
        onQuery={setQ}
        placeholder="Search"
        onPlus={() => setCompose(true)}
        plusLabel="New message"
      />

      {tickets ? <TicketsOverlay onClose={() => setTickets(false)} /> : null}
      {compose ? <OverlayCompose onClose={() => setCompose(false)} /> : null}
      {serversSheet ? <OverlayServers onClose={() => setServersSheet(false)} /> : null}

      {settings ? <ZenSettings onClose={() => setSettings(false)} /> : null}
      </div>
    </div>
  );
}
