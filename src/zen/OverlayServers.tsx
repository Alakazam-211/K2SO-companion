import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connectServer } from "../lib/revive";
import { hostLabel, useServersStore, type RecoveryState, type ServerEntry } from "../stores/servers";
import { GlassSearchBar } from "./GlassSearchBar";
import { OverlayAddServer } from "./OverlayAddServer";
import { filterServers, splitPinnedServer } from "./serverList";
import { useZenStore } from "./zenStore";

const RECOVERY_DOT: Record<RecoveryState, string> = {
  connected: "#22c55e",
  reconnecting: "#f59e0b",
  reauthenticating: "#f59e0b",
  "signin-required": "#ef4444",
};

const STATE_LABEL: Record<RecoveryState, string> = {
  connected: "connected",
  reconnecting: "reconnecting…",
  reauthenticating: "re-authenticating…",
  "signin-required": "sign-in required",
};

const labelOf = (server: ServerEntry) => server.nickname || hostLabel(server.url);

/** How long the just-connected highlight lives (FLIP lift, then a ring
 *  pulse + checkmark). The sheet closes once it ends. */
export const JUST_CONNECTED_MS = 1000;
/** FLIP lift from the tapped row into the pinned slot. */
const FLIP_MS = 420;
/** Spring-ish: slight overshoot, then settle. */
const FLIP_EASE = "cubic-bezier(0.2, 0.9, 0.25, 1.12)";

function prefersReducedMotion(): boolean {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

function CheckMark() {
  return (
    <svg
      className="k2-server-check shrink-0"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-testid="servers-pinned-check"
    >
      <path
        d="M3 8.5l3.2 3.2L13 4.8"
        fill="none"
        stroke="#22c55e"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** In-overlay server list. Tap switches the active server. Sign-in
 *  required opens OverlayAddServer. Never navigates to `/servers`.
 *  The active server is pinned in its own card under the header (outside
 *  the scroller, never filtered); the list below holds the others A–Z.
 *  A successful switch FLIPs the tapped row into the pinned slot, rings it
 *  green with a checkmark, then closes. The bottom glass bar (shared with
 *  Chats) searches and `+` adds. Rendered inside the Chats column, which
 *  is sized to the visual viewport, so `inset-0` keeps the bar above the
 *  iOS keyboard. */
export function OverlayServers({ onClose }: { onClose: () => void }) {
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);
  const [returningId, setReturningId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const pinnedRef = useRef<HTMLDivElement | null>(null);
  const flipFrom = useRef<{ id: string; rect: DOMRect | null } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { pinned, others } = splitPinnedServer(servers, activeServerId, labelOf);
  const visible = filterServers(others, query, (server) => [
    server.nickname,
    hostLabel(server.url),
    server.username,
  ]);
  const pinnedState: RecoveryState = pinned
    ? recovery[pinned.id] ?? "signin-required"
    : "signin-required";
  // Success signal: the tapped server became active AND reads connected.
  const justConnected =
    !!pinned && justConnectedId === pinned.id && pinnedState === "connected";

  // FLIP: the row's rect was captured before the switch; the pinned card
  // now sits at its final rect. Start it at the row and let it spring home.
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    const el = pinnedRef.current;
    if (!from?.rect || !el || from.id !== activeServerId) return;
    if (prefersReducedMotion() || typeof el.animate !== "function") return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = from.rect.left - to.left;
    const dy = from.rect.top - to.top;
    const sx = from.rect.width / to.width;
    const sy = from.rect.height / to.height;
    el.animate(
      [
        {
          transformOrigin: "top left",
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        },
        {
          transformOrigin: "top left",
          transform: `translate(${dx * 0.45}px, ${dy * 0.45}px) scale(1.02)`,
          offset: 0.45,
        },
        {
          transformOrigin: "top left",
          transform: "none",
        },
      ],
      { duration: FLIP_MS, easing: FLIP_EASE }
    );
  }, [activeServerId]);

  // The highlight marker clears once the ring + check have played.
  useEffect(() => {
    if (!justConnectedId) return;
    const t = window.setTimeout(() => {
      setJustConnectedId(null);
      setReturningId(null);
    }, JUST_CONNECTED_MS);
    return () => window.clearTimeout(t);
  }, [justConnectedId]);

  const pick = async (server: ServerEntry) => {
    if (busy.current) return;
    busy.current = true;
    setConnectingId(server.id);
    const outcome = await connectServer(server.id);
    if (!mounted.current) return;
    setConnectingId(null);
    if (outcome === "still-valid" || outcome === "revived") {
      const store = useServersStore.getState();
      const previousId = store.activeServerId;
      flipFrom.current = {
        id: server.id,
        rect: rowRefs.current.get(server.id)?.getBoundingClientRect() ?? null,
      };
      store.setActive(server.id);
      setJustConnectedId(server.id);
      setReturningId(previousId && previousId !== server.id ? previousId : null);
      // Hold the sheet open long enough to see the new server land.
      const hold = new Promise<void>((resolve) =>
        window.setTimeout(resolve, JUST_CONNECTED_MS)
      );
      try {
        await Promise.all([useZenStore.getState().hydrateAgents(), hold]);
      } finally {
        busy.current = false;
      }
      if (mounted.current) onClose();
      return;
    }
    busy.current = false;
    if (outcome === "signin-required") {
      setEditingId(server.id);
      return;
    }
  };

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
  };

  if (adding || editingId) {
    return (
      <div
        className="absolute inset-0 flex flex-col"
        style={{ background: "#000", zIndex: 6, paddingTop: "env(safe-area-inset-top)" }}
        data-testid="overlay-servers"
      >
        <OverlayAddServer
          editingId={editingId}
          onCancel={closeForm}
          onSaved={onClose}
        />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="overlay-servers"
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
          className="text-[17px] k2-tile"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
          }}
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none">
          Servers
        </h1>
      </div>
      {pinned ? (
        <div
          className="shrink-0 relative"
          style={{ padding: "4px 12px 10px", zIndex: 2 }}
          data-testid="servers-pinned"
        >
          <div
            key={pinned.id}
            ref={pinnedRef}
            className={`k2-tile flex items-center relative${
              justConnected ? " k2-server-just-connected" : ""
            }`}
            style={{ gap: 10, padding: "10px 10px 10px 14px", borderRadius: 14 }}
            data-just-connected={justConnected ? "true" : undefined}
          >
            <button
              type="button"
              className="flex-1 min-w-0 flex items-center text-left"
              style={{ gap: 10 }}
              onClick={() => void pick(pinned)}
              aria-label={labelOf(pinned)}
              data-testid="overlay-server-pinned"
            >
              <span
                className={`shrink-0 relative${connectingId === pinned.id ? " k2-pulse" : ""}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: RECOVERY_DOT[pinnedState],
                  color: RECOVERY_DOT[pinnedState],
                }}
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[16px] font-semibold">{labelOf(pinned)}</span>
                  <span
                    className="shrink-0 flex items-center text-[11px] uppercase"
                    style={{
                      gap: 4,
                      color: pinnedState === "connected" ? "#22c55e" : RECOVERY_DOT[pinnedState],
                      letterSpacing: ".04em",
                    }}
                  >
                    {justConnected ? <CheckMark /> : null}
                    {connectingId === pinned.id
                      ? "connecting…"
                      : pinnedState === "connected"
                        ? "Connected"
                        : STATE_LABEL[pinnedState]}
                  </span>
                </span>
                <span
                  className="block text-[14px] truncate"
                  style={{ color: "#8e8e93", lineHeight: 1.3 }}
                >
                  {pinned.username} @ {hostLabel(pinned.url)}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="shrink-0 text-[17px] k2-tile"
              style={{
                minHeight: 34,
                padding: "0 12px",
                borderRadius: 17,
                color: "#8e8e93",
              }}
              aria-label={`Edit ${labelOf(pinned)}`}
              onClick={() => setEditingId(pinned.id)}
            >
              Edit
            </button>
          </div>
        </div>
      ) : null}
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "0 8px 96px", WebkitOverflowScrolling: "touch" }}
        data-testid="overlay-servers-list"
      >
        {servers.length === 0 ? (
          <p className="px-4 py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            No servers yet.
          </p>
        ) : visible.length === 0 ? (
          query.trim() ? (
            <p
              className="px-4 py-6 text-[14px]"
              style={{ color: "#8e8e93" }}
              data-testid="overlay-servers-empty"
            >
              No servers match
            </p>
          ) : null
        ) : (
          visible.map((server) => {
            const state = recovery[server.id] ?? "signin-required";
            const isConnecting = connectingId === server.id;
            const label = labelOf(server);
            return (
              <div
                key={server.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(server.id, el);
                  else rowRefs.current.delete(server.id);
                }}
                className={`w-full flex items-center${
                  returningId === server.id ? " k2-server-return" : ""
                }`}
                style={{
                  gap: 10,
                  padding: "10px 8px 10px 6px",
                  borderBottom: "0.5px solid rgba(255,255,255,.12)",
                }}
              >
                <button
                  type="button"
                  className="flex-1 min-w-0 flex items-center text-left"
                  style={{ gap: 10 }}
                  onClick={() => void pick(server)}
                  aria-label={label}
                  aria-busy={isConnecting || undefined}
                  data-testid="overlay-server-row"
                >
                  <span
                    className={`shrink-0 relative${isConnecting ? " k2-pulse" : ""}`}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: RECOVERY_DOT[state],
                      color: RECOVERY_DOT[state],
                    }}
                    data-testid={isConnecting ? "overlay-server-connecting" : undefined}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="truncate block text-[16px] font-semibold">{label}</span>
                    <span
                      className="block text-[14px] truncate"
                      style={{ color: "#8e8e93", lineHeight: 1.3 }}
                    >
                      {server.username} @ {hostLabel(server.url)}
                    </span>
                    <span
                      className="block text-[12px]"
                      style={{ color: RECOVERY_DOT[state] }}
                    >
                      {isConnecting ? "connecting…" : STATE_LABEL[state]}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="shrink-0 text-[17px] k2-tile"
                  style={{
                    minHeight: 34,
                    padding: "0 12px",
                    borderRadius: 17,
                    color: "#8e8e93",
                  }}
                  aria-label={`Edit ${label}`}
                  onClick={() => setEditingId(server.id)}
                >
                  Edit
                </button>
              </div>
            );
          })
        )}
      </div>
      <GlassSearchBar
        query={query}
        onQuery={setQuery}
        placeholder="Search servers"
        searchLabel="Search servers"
        onPlus={() => setAdding(true)}
        plusLabel="Add server"
        testId="overlay-servers-bar"
        inputTestId="overlay-servers-search"
        plusTestId="overlay-servers-add"
      />
    </div>
  );
}
