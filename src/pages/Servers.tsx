import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useServersStore,
  hostLabel,
  type RecoveryState,
  type ServerEntry,
} from "../stores/servers";
import { connectServer } from "../lib/revive";

// The Servers page — the app's HOME. Lists every saved server with its
// live recovery state; tapping a row makes it the ACTIVE server (and
// reconnects — probe / silent re-login via the revive path). The edit
// affordance opens the add/edit-server flow (`/login`), which also owns
// remove. Fresh installs land here on the big add CTA.

const DOT_COLOR: Record<RecoveryState, string> = {
  connected: "var(--success)",
  reconnecting: "var(--warning)",
  reauthenticating: "var(--warning)",
  "signin-required": "var(--error)",
};

const STATE_LABEL: Record<RecoveryState, string> = {
  connected: "connected",
  reconnecting: "reconnecting…",
  reauthenticating: "re-authenticating…",
  "signin-required": "sign-in required",
};

export function Servers() {
  const navigate = useNavigate();
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const selectServer = async (server: ServerEntry) => {
    useServersStore.getState().setActive(server.id);
    setConnectingId(server.id);
    // Reconnect through the revive path: alive token → still-valid; dead
    // token + remembered password → silent re-login; otherwise the server
    // is marked signin-required and the user finishes in the login flow.
    const outcome = await connectServer(server.id);
    setConnectingId(null);
    if (outcome === "signin-required") {
      navigate(`/login?server=${encodeURIComponent(server.id)}`);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Page header */}
      <div className="flex items-center px-4 py-3 border-b border-[var(--border)] shrink-0">
        <h1 className="text-[var(--accent)] text-[15px] font-bold tracking-wide flex-1">
          Servers
        </h1>
        {servers.length > 0 && (
          <button
            onClick={() => navigate("/login")}
            className="flex items-center gap-1.5 px-3 h-8 text-[var(--accent)] border border-[var(--accent-dim)] text-[11px]"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M7 1v12M1 7h12" />
            </svg>
            Add server
          </button>
        )}
      </div>

      {servers.length === 0 ? (
        /* Empty state — the fresh-install landing */
        <div className="flex-1 flex flex-col items-center justify-center px-8 gap-4">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" />
            <line x1="6" y1="18" x2="6.01" y2="18" />
          </svg>
          <p className="text-[var(--text-muted)] text-[12px] text-center leading-5">
            No servers yet.
            <br />
            Add your K2 server to get started.
          </p>
          <button
            onClick={() => navigate("/login")}
            className="min-h-[44px] px-8 bg-white text-black font-semibold text-[14px] hover:bg-gray-200 transition-colors"
          >
            Add server
          </button>
        </div>
      ) : (
        <div className="flex flex-col py-2">
          {servers.map((server) => {
            const state = recovery[server.id] ?? "signin-required";
            const isActive = server.id === activeServerId;
            const isConnecting = connectingId === server.id;
            return (
              <div
                key={server.id}
                onClick={() => void selectServer(server)}
                className={`flex items-center gap-3 mx-3 mb-2 px-4 py-3.5 bg-[var(--surface)] border cursor-pointer transition-colors ${
                  isActive
                    ? "border-[var(--accent-dim)]"
                    : "border-[var(--border)] hover:border-[var(--border-hover)]"
                }`}
              >
                {/* State dot */}
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    background: DOT_COLOR[state],
                    animation:
                      isConnecting || state === "reconnecting" || state === "reauthenticating"
                        ? "pulse 1.2s ease-in-out infinite"
                        : undefined,
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--text)] text-[13px] font-medium truncate">
                      {server.nickname}
                    </span>
                    {isActive && (
                      <span className="text-[var(--accent)] text-[9px] uppercase tracking-wide border border-[var(--accent-dim)] px-1.5 py-px shrink-0">
                        active
                      </span>
                    )}
                  </div>
                  <div className="text-[var(--text-muted)] text-[10px] truncate mt-0.5">
                    {server.username} @ {hostLabel(server.url)}
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: DOT_COLOR[state] }}>
                    {isConnecting ? "connecting…" : STATE_LABEL[state]}
                  </div>
                </div>
                {/* Edit affordance (edit page owns remove) */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/login?server=${encodeURIComponent(server.id)}`);
                  }}
                  aria-label="Edit server"
                  className="w-9 h-9 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] shrink-0 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
