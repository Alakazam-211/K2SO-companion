import { useState } from "react";
import { connectServer } from "../lib/revive";
import { hostLabel, useServersStore, type RecoveryState, type ServerEntry } from "../stores/servers";
import { GlassSearchBar } from "./GlassSearchBar";
import { OverlayAddServer } from "./OverlayAddServer";
import { filterServers, sortServersActiveFirst } from "./serverList";
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

/** In-overlay server list. Tap switches the active server. Sign-in
 *  required opens OverlayAddServer. Never navigates to `/servers`.
 *  Active server first, the rest alphabetical; the bottom glass bar
 *  (shared with Chats) searches and `+` adds. Rendered inside the Chats
 *  column, which is sized to the visual viewport, so `inset-0` keeps the
 *  bar above the iOS keyboard. */
export function OverlayServers({ onClose }: { onClose: () => void }) {
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const visible = filterServers(
    sortServersActiveFirst(servers, activeServerId, labelOf),
    query,
    (server) => [server.nickname, hostLabel(server.url), server.username]
  );

  const pick = async (server: ServerEntry) => {
    if (connectingId) return;
    setConnectingId(server.id);
    const outcome = await connectServer(server.id);
    setConnectingId(null);
    if (outcome === "still-valid" || outcome === "revived") {
      useServersStore.getState().setActive(server.id);
      await useZenStore.getState().hydrateAgents();
      onClose();
      return;
    }
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
          <p
            className="px-4 py-6 text-[14px]"
            style={{ color: "#8e8e93" }}
            data-testid="overlay-servers-empty"
          >
            No servers match
          </p>
        ) : (
          visible.map((server) => {
            const state = recovery[server.id] ?? "signin-required";
            const isActive = server.id === activeServerId;
            const isConnecting = connectingId === server.id;
            const label = labelOf(server);
            return (
              <div
                key={server.id}
                className="w-full flex items-center"
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
                  data-testid="overlay-server-row"
                >
                  <span
                    className="shrink-0"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: RECOVERY_DOT[state],
                    }}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[16px] font-semibold">{label}</span>
                      {isActive ? (
                        <span
                          className="shrink-0 text-[11px] uppercase"
                          style={{ color: "#22d3ee" }}
                        >
                          active
                        </span>
                      ) : null}
                    </span>
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
