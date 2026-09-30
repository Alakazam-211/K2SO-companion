import { useState } from "react";
import { connectServer } from "../lib/revive";
import { hostLabel, useServersStore, type RecoveryState, type ServerEntry } from "../stores/servers";
import { OverlayAddServer } from "./OverlayAddServer";
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

/** In-overlay server list. Tap switches the active server. Sign-in
 *  required opens OverlayAddServer. Never navigates to `/servers`. */
export function OverlayServers({ onClose }: { onClose: () => void }) {
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const pick = async (server: ServerEntry) => {
    if (connectingId) return;
    useServersStore.getState().setActive(server.id);
    setConnectingId(server.id);
    const outcome = await connectServer(server.id);
    setConnectingId(null);
    if (outcome === "signin-required") {
      setEditingId(server.id);
      return;
    }
    if (outcome === "unreachable") return;
    await useZenStore.getState().hydrateAgents();
    onClose();
  };

  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
  };

  if (adding || editingId) {
    return (
      <div
        className="absolute inset-0 flex flex-col"
        style={{ background: "#000", zIndex: 6 }}
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
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-servers"
    >
      <div
        className="flex items-center justify-between relative shrink-0"
        style={{
          minHeight: 44,
          padding: "max(12px, env(safe-area-inset-top)) 16px 8px",
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
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none">
          Servers
        </h1>
        <button
          type="button"
          className="text-[17px]"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
            background: "#1c1c1e",
          }}
          onClick={() => setAdding(true)}
        >
          Add
        </button>
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "0 8px 24px", WebkitOverflowScrolling: "touch" }}
        data-testid="overlay-servers-list"
      >
        {servers.length === 0 ? (
          <p className="px-4 py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            No servers yet.
          </p>
        ) : (
          servers.map((server) => {
            const state = recovery[server.id] ?? "signin-required";
            const isActive = server.id === activeServerId;
            const isConnecting = connectingId === server.id;
            const label = server.nickname || hostLabel(server.url);
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
                  className="shrink-0 text-[17px]"
                  style={{
                    minHeight: 34,
                    padding: "0 12px",
                    borderRadius: 17,
                    background: "#1c1c1e",
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
    </div>
  );
}
