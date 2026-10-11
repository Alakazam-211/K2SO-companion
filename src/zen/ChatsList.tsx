import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useFeedbackStore } from "../stores/feedback";
import { hostLabel, useServersStore, type RecoveryState } from "../stores/servers";
import { isOverlayExtraAddr, visibleOverlayAgents } from "./overlayExtras";
import { overlayRowPreview } from "./rowPreview";
import { activityForRow, activityRowText } from "./agentActivity";
import { StubMark } from "./StubMark";
import { OverlayAddServer } from "./OverlayAddServer";
import { GlassSearchBar } from "./GlassSearchBar";
import { OverlayCompose } from "./OverlayCompose";
import { OverlayServers } from "./OverlayServers";
import { TicketsOverlay } from "./TicketsOverlay";
import { lastAtKeyFor, sortChatsByRecency } from "./lastAtFetch";
import { mountainListWhen } from "./threadModel";
import { usePinDrag } from "./usePinDrag";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
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

export function ChatsList() {
  const navigate = useNavigate();
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
  const hiddenSidecarAddrs = useZenStore((s) => s.hiddenSidecarAddrs);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinsRef = useRef<HTMLDivElement | null>(null);
  const { onPointerDown, onPointerMove, onPointerUp, ghost, hot, consumeSkipClick, onPinClick } =
    usePinDrag(pinsRef);
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
  const filtered = sortChatsByRecency(
    visibleOverlayAgents(agents, q, hiddenSidecarAddrs),
    lastAtByKey,
    lastAtKeyFor
  );

  // Agent status: re-read the activity snapshot while the list is up. The
  // list stays mounted (hidden) under an open Thread; it does not poll then.
  useEffect(() => {
    if (source !== "live" || zenScreen !== "list") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (document.visibilityState !== "hidden") void refreshActivity();
      timer = setTimeout(tick, ACTIVITY_POLL_MS);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [source, zenScreen, refreshActivity]);

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
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif',
      }}
      data-testid="chats-home"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
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
          gridTemplateColumns: "1fr auto 1fr",
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
        <h1
          className="text-[17px] font-semibold pointer-events-none"
          style={{ letterSpacing: "-0.2px" }}
        >
          Chats
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

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingBottom: searching ? 24 : 96,
          WebkitOverflowScrolling: ghost ? "auto" : "touch",
          overflowY: ghost ? "hidden" : "auto",
          touchAction: ghost ? "none" : undefined,
        }}
        data-testid="chats-list"
      >
      {!searching ? (
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
        {pinned.length === 0 ? (
          <div className="text-center" style={{ opacity: 0.45 }} data-pin-id="" data-pin-from="pin" data-placeholder="1">
            <div
              className="mx-auto mb-2 flex items-center justify-center"
              style={{
                width: 74,
                height: 74,
                borderRadius: "50%",
                border: "1.5px dashed #636366",
                color: "#636366",
                fontSize: 26,
              }}
            >
              +
            </div>
            <div className="text-[12px]" style={{ color: "#d1d1d6" }}>
              Drop here
            </div>
          </div>
        ) : (
          pinned.map((a) => (
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
          ))
        )}
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
          return (
          <button
            key={a.id}
            type="button"
            className="w-full flex items-center text-left relative"
            style={{
              gap: 10,
              padding: "10px 14px 10px 6px",
              touchAction: ghost ? "none" : "pan-y",
            }}
            onClick={() => {
              if (consumeSkipClick()) return;
              setAgent(a.id);
            }}
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

      {settings ? (
        <div
          className="absolute inset-0 flex flex-col"
          style={{ background: "#000", zIndex: 6, paddingTop: "env(safe-area-inset-top)" }}
          data-testid="overlay-settings"
        >
          <div
            className="flex items-center justify-between relative shrink-0"
            style={{
              minHeight: 44,
              padding: "12px 16px 8px",
            }}
          >
            <button
              type="button"
              className="text-[17px] zen-glass zen-glass-pill"
              style={{
                minHeight: 34,
                padding: "0 14px",
              }}
              onClick={() => setSettings(false)}
            >
              Done
            </button>
            <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none">
              Settings
            </h1>
            <span style={{ width: 72 }} />
          </div>
          <button
            type="button"
            className="w-full flex justify-between text-[17px]"
            style={{
              padding: "14px 16px",
              borderBottom: "0.5px solid rgba(255,255,255,.12)",
            }}
            onClick={() => {
              setSettings(false);
              navigate("/servers");
            }}
          >
            <span>Terminal view</span>
            <span style={{ color: "#8e8e93" }}>›</span>
          </button>
          <p
            className="text-[13px]"
            style={{ color: "#8e8e93", padding: "8px 16px 16px", lineHeight: 1.35 }}
          >
            Leave this overlay and open the terminal view — Servers, Sessions, Tickets.
          </p>
        </div>
      ) : null}
      </div>
    </div>
  );
}
