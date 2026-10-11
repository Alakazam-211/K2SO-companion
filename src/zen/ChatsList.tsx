import { useEffect, useMemo, useRef, useState } from "react";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useFeedbackStore } from "../stores/feedback";
import { hostLabel, useServersStore, type RecoveryState } from "../stores/servers";
import { isOverlayExtraAddr, visibleOverlayAgents } from "./overlayExtras";
import { overlayRowPreview } from "./rowPreview";
import { activityForRow, activityRowText } from "./agentActivity";
import { StubMark } from "./StubMark";
import { OverlayAddServer } from "./OverlayAddServer";
import {
  GlassSearchBar,
  SEARCH_BAR_HEIGHT,
  SEARCH_BAR_KEYBOARD_GAP,
} from "./GlassSearchBar";
import { OverlayCompose } from "./OverlayCompose";
import { OverlayServers } from "./OverlayServers";
import { TicketsOverlay } from "./TicketsOverlay";
import { lastAtKeyFor, sortChatsByRecency } from "./lastAtFetch";
import { currentFocusGroup, filterByFocus, listTitle, pinProjectIdForRow } from "./serverPins";
import { connectProjectEvents } from "./ticketEvents";
import { mountainListWhen } from "./threadModel";
import { usePinDrag } from "./usePinDrag";
import { SWIPE_ACTION_W, swipeReveal, useRowSwipe } from "./useRowSwipe";
import "./swipePin.css";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { ZenSettings } from "./ZenSettings";
import { useZenStore } from "./zenStore";

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
/** Title cap: at 375pt the side columns keep ~100px for the pills. */
const TITLE_MAX_W = "min(34vw, 140px)";

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
  const selectFocusGroup = useZenStore((s) => s.selectFocusGroup);
  const hiddenSidecarAddrs = useZenStore((s) => s.hiddenSidecarAddrs);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinsRef = useRef<HTMLDivElement | null>(null);
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
  const { ghost, hot, consumeSkipClick, onPinClick } = pinDrag;
  const togglePin = (id: string) => {
    const st = useZenStore.getState();
    if (!canPin(id)) return;
    if (st.pinnedIds.includes(id)) void st.unpinChat(id);
    else void st.pinChat(id);
  };
  const swipe = useRowSwipe(togglePin, canPin);
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
  const waitingCount = useFeedbackStore((s) => s.waitingCount);
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
  }, [filtered, source, ensureLastAt]);

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
        style={{
          height: containerHeight,
          paddingTop: "env(safe-area-inset-top)",
        }}
        data-testid="chats-column"
      >
      <header
        className="grid items-center shrink-0 w-full min-w-0"
        data-no-pin="1"
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
          className="min-w-0 text-[17px] font-semibold"
          style={{ letterSpacing: "-0.2px", maxWidth: TITLE_MAX_W }}
          data-testid="chats-title"
        >
          {group ? (
            <button
              type="button"
              className="flex items-center min-w-0 max-w-full bg-transparent border-0 p-0"
              style={{ gap: 6, color: "#fff", font: "inherit", letterSpacing: "inherit" }}
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
        <span className="flex items-center justify-self-end" style={{ gap: 8 }} data-testid="chats-header-right">
          <button
            type="button"
            className="relative flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
            style={{
              width: 34,
              height: 34,
              color: "#fff",
            }}
            onClick={() => setTickets(true)}
            aria-label={waitingCount ? `Tickets, ${waitingCount} waiting` : "Tickets"}
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
            {waitingCount > 0 ? (
              <span
                className="absolute"
                data-testid="tickets-badge"
                style={{
                  top: -2,
                  right: -2,
                  minWidth: 15,
                  height: 15,
                  padding: "0 4px",
                  borderRadius: 8,
                  background: "#f59e0b",
                  color: "#000",
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: "15px",
                  textAlign: "center",
                }}
              >
                {waitingCount > 99 ? "99+" : waitingCount}
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

      {pinError ? (
        <p
          role="status"
          className="shrink-0 px-4 pb-1 text-[13px] truncate"
          style={{ color: "#ff453a" }}
          data-no-pin="1"
          data-testid="chats-pin-error"
        >
          {pinError}
        </p>
      ) : null}

      {/* No pins: a hold-drag still needs somewhere to land. A zero-height
          anchor under the header, so the strip floats over the list without
          shifting the row under the finger. */}
      {!searching && pinned.length === 0 && hot ? (
        <div className="relative shrink-0" style={{ height: 0, zIndex: 5 }} data-no-pin="1">
          <div
            ref={pinsRef}
            className="k2-pin-drop absolute"
            style={{ top: 4, left: 12, right: 12 }}
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
        onScroll={swipe.openId ? swipe.close : undefined}
      >
      <span id={SWIPE_HINT_ID} className="sr-only">
        Swipe right to pin or unpin. Or press and hold, then drag to the top.
      </span>
      {/* Pins only when there are pins: an empty tray is dead space. */}
      {!searching && pinned.length > 0 ? (
      <div
        ref={pinsRef}
        className="grid grid-cols-3"
        style={{
          padding: "4px 10px 8px",
          gap: "14px 6px",
          minHeight: 96,
          margin: "0 8px",
          borderRadius: 16,
          background: hot ? "rgba(10,132,255,.12)" : "transparent",
          outline: hot ? "1.5px dashed rgba(10,132,255,.5)" : "1.5px dashed transparent",
        }}
        data-testid="chats-pins"
      >
        {pinned.map((a) => (
            <button
              key={a.id}
              type="button"
              className="text-center bg-transparent border-0 p-0"
              style={{ color: "#fff", touchAction: "none" }}
              data-pin-id={a.id}
              data-pin-from="pin"
              aria-label={`Pinned ${a.name}`}
              onClick={() => onPinClick(a.id)}
            >
              <div className="mb-2 flex justify-center" data-testid="pin-avatar">
                <WorkspaceAvatar
                  initial={a.initial}
                  color={a.color}
                  iconUrl={a.iconUrl}
                  size={74}
                  fontSize={26}
                  fallback="#2c2c2e"
                />
              </div>
              <div
                className="text-[12px] truncate mx-auto"
                style={{ color: "#d1d1d6", maxWidth: 110 }}
              >
                {a.name}
              </div>
            </button>
          ))}
      </div>
      ) : null}
        {source === "loading" ? (
          <p className="px-4 py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            Loading
          </p>
        ) : null}
        {source !== "loading" && agentError && filtered.length > 0 ? (
          <p className="px-4 py-3 text-[14px]" style={{ color: "#f59e0b" }}>
            {agentError}
          </p>
        ) : null}
        {source !== "loading" && filtered.length === 0 ? (
          <p
            className="px-4 py-6 text-[14px]"
            style={{ color: "#8e8e93" }}
            data-testid="chats-empty"
          >
            {agentError || "No agents on this list."}
          </p>
        ) : null}
        {filtered.map((a) => {
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
          const busyColor =
            busy?.display === "waiting"
              ? "var(--warning)"
              : busy?.display === "monitoring"
                ? "var(--accent)"
                : "var(--success)";
          const isPinned = pinnedIds.includes(a.id);
          const rowCanPin = pinnable.has(a.id);
          const sw = swipe.offsetFor(a.id);
          const pinVerb = isPinned ? "Unpin" : "Pin";
          const reveal = swipeReveal(sw.x, swipe.reduced);
          return (
          <div
            key={a.id}
            className="relative overflow-hidden"
            data-swipe-row={a.id}
          >
          {/* Leading swipe action: a round glass pin revealed as the row
              slides right. The button is the whole revealed strip (row
              height, so the hit target stays over 44px); the strip itself
              is clear, only the glass circle is drawn. None on rows the
              server cannot pin (sidecars, project groups). */}
          {rowCanPin ? (
          <button
            type="button"
            className="absolute left-0 top-0 bottom-0 overflow-hidden border-0 p-0 bg-transparent"
            style={{
              width: sw.x,
              background: "transparent",
              transition: swipe.transition(sw.dragging, ["width"]),
            }}
            onClick={() => {
              togglePin(a.id);
              swipe.close();
            }}
            aria-label={`${pinVerb} ${a.name}`}
            data-swipe-action="1"
            data-no-pin="1"
            data-testid={`swipe-action-${a.id}`}
          >
            <span
              className="absolute top-0 bottom-0 flex flex-col items-center justify-center"
              style={{
                width: SWIPE_ACTION_W,
                // Sits at the left while revealing; on an over-swipe it
                // rides the row's leading edge.
                left: Math.max(0, sw.x - SWIPE_ACTION_W),
                gap: 4,
                opacity: reveal.opacity,
                transition: swipe.transition(sw.dragging, ["opacity", "left"]),
              }}
              aria-hidden
              data-testid="swipe-action-reveal"
            >
              <span
                className="k2-swipe-pin"
                style={{
                  color: PIN_YELLOW,
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
                  <PinGlyph off={isPinned} />
                </span>
              </span>
              <span className="k2-swipe-pin-label">{pinVerb}</span>
            </span>
          </button>
          ) : null}
          <button
            type="button"
            className="w-full flex items-center text-left relative"
            style={{
              gap: 10,
              padding: "10px 14px 10px 6px",
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
                <span className="truncate text-[16px] font-semibold" style={{ letterSpacing: "-0.2px" }}>
                  {a.name}
                </span>
                {source === "stub" ? (
                  <StubMark />
                ) : (
                  <span
                    className="shrink-0 flex items-center gap-1 text-[14px]"
                    style={{ color: "#8e8e93", fontWeight: 400 }}
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
                  className="block text-[14px] truncate"
                  style={{ color: busyColor, lineHeight: 1.3 }}
                  data-testid="row-activity"
                >
                  {activityRowText(busy)}
                </span>
              ) : (
                <span
                  className="block text-[14px] truncate"
                  style={{ color: "#8e8e93", lineHeight: 1.3 }}
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
