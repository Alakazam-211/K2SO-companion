import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFeedbackStore } from "../stores/feedback";
import { hostLabel, useServersStore, type RecoveryState } from "../stores/servers";
import { isOverlayExtraAddr, visibleOverlayAgents } from "./overlayExtras";
import { overlayRowPreview } from "./rowPreview";
import { StubMark } from "./StubMark";
import { OverlayAddServer } from "./OverlayAddServer";
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
export function ChatsList() {
  const navigate = useNavigate();
  const agents = useZenStore((s) => s.agents);
  const source = useZenStore((s) => s.agentSource);
  const agentError = useZenStore((s) => s.agentError);
  const setAgent = useZenStore((s) => s.setAgent);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const ensureLastAt = useZenStore((s) => s.ensureLastAt);
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
    : "No server";

  const filtered = sortChatsByRecency(
    visibleOverlayAgents(agents, q, hiddenSidecarAddrs),
    lastAtByKey,
    lastAtKeyFor
  );

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

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
      style={{
        background: "#000",
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
          className="text-[17px] justify-self-start"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
            background: "#1c1c1e",
            color: "#fff",
          }}
          onClick={() => setSettings(true)}
        >
          Settings
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
            className="relative flex items-center justify-center shrink-0"
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              background: "#1c1c1e",
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
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
            className="flex items-center justify-center shrink-0"
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              background: "#1c1c1e",
            }}
            onClick={() => setServersSheet(true)}
            aria-label={`Server ${serverLabel}`}
            title={serverLabel}
          >
            <span
              className="shrink-0"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: activeServer ? RECOVERY_DOT[recoveryState] : "#8e8e93",
              }}
            />
          </button>
        </span>
      </header>

      <div
        ref={pinsRef}
        className="grid grid-cols-3 shrink-0"
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
      <p
        className="text-center shrink-0"
        style={{ fontSize: 11, color: "#8e8e93", padding: "0 16px 10px", lineHeight: 1.3 }}
      >
        {pinned.length
          ? "Hold a pin, then drag it to reorder. Hold a chat, then drag it up here to pin. Drag a pin down to unpin."
          : "Hold a chat, then drag it up here to pin."}
      </p>

      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingBottom: 96,
          WebkitOverflowScrolling: ghost ? "auto" : "touch",
          overflowY: ghost ? "hidden" : "auto",
          touchAction: ghost ? "none" : undefined,
        }}
        data-testid="chats-list"
      >
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
                : isOverlayExtraAddr(a.addr)
                  ? `${a.name}, ${overlayRowPreview(a)}`
                  : a.name
            }
            data-last-at-key={lastKey}
            data-pin-id={a.id}
            data-pin-from="list"
          >
            <WorkspaceAvatar
              initial={a.initial}
              color={a.color}
              iconUrl={a.iconUrl}
              size={50}
              fontSize={18}
            />
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
              <span
                className="block text-[14px] truncate"
                style={{ color: "#8e8e93", lineHeight: 1.3 }}
                data-testid="row-preview"
              >
                {preview}
              </span>
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

      <div
        className="absolute left-3 right-3 flex items-center"
        data-no-pin="1"
        style={{
          bottom: "max(14px, env(safe-area-inset-bottom))",
          gap: 10,
          zIndex: 4,
        }}
      >
        <label
          className="flex-1 min-w-0 flex items-center"
          style={{
            gap: 8,
            background: "#1c1c1e",
            borderRadius: 22,
            padding: "9px 14px",
          }}
        >
          <span className="sr-only">Search</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[17px]"
            style={{ color: "#fff" }}
            aria-label="Search"
          />
        </label>
        <button
          type="button"
          title="New message"
          aria-label="New message"
          className="flex items-center justify-center"
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: "#1c1c1e",
            color: "#fff",
          }}
          onClick={() => setCompose(true)}
        >
          +
        </button>
      </div>

      {tickets ? <TicketsOverlay onClose={() => setTickets(false)} /> : null}
      {compose ? <OverlayCompose onClose={() => setCompose(false)} /> : null}
      {serversSheet ? <OverlayServers onClose={() => setServersSheet(false)} /> : null}

      {settings ? (
        <div
          className="absolute inset-0 flex flex-col"
          style={{ background: "#000", zIndex: 6 }}
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
              className="text-[17px]"
              style={{
                minHeight: 34,
                padding: "0 14px",
                borderRadius: 17,
                background: "#1c1c1e",
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
  );
}
