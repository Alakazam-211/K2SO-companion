import { useLocation, useNavigate } from "react-router-dom";
import { useServersStore, type RecoveryState } from "../stores/servers";

// The connected-server strip: a slim, always-visible line directly above
// the TabBar — "Connected to <nickname>" plus the active server's recovery
// state. Tapping it goes to the Servers page.

const DOT_COLOR: Record<RecoveryState, string> = {
  connected: "var(--success)",
  reconnecting: "var(--warning)",
  reauthenticating: "var(--warning)",
  "signin-required": "var(--error)",
};

function stateLabel(state: RecoveryState, nickname: string): string {
  switch (state) {
    case "connected":
      return `Connected to ${nickname}`;
    case "reconnecting":
      return `Reconnecting to ${nickname}…`;
    case "reauthenticating":
      return `Re-authenticating with ${nickname}…`;
    case "signin-required":
      return `Sign-in required — ${nickname}`;
  }
}

export function ServerFooter() {
  const location = useLocation();
  const navigate = useNavigate();
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);

  // The chat view (and C3's open feedback thread) hides all nav chrome
  // (keyboard-layout constraints — docs/ios-keyboard-layout.md); match
  // the TabBar's behavior. The add/edit-server flow (/login) is
  // chrome-free too — it renders inside the shell since the freeze fix.
  if (location.pathname.startsWith("/chat/") || /^\/feedback\/./.test(location.pathname) || location.pathname === "/login") return null;

  const active = servers.find((s) => s.id === activeServerId) ?? null;
  const state: RecoveryState = active
    ? recovery[active.id] ?? "connected"
    : "signin-required";

  return (
    <button
      onClick={() => navigate("/servers")}
      className="flex items-center gap-2 w-full px-4 py-1.5 border-t border-[var(--border)] bg-[var(--surface)] shrink-0 text-left"
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: active ? DOT_COLOR[state] : "var(--text-muted)",
        }}
      />
      <span className="text-[var(--text-muted)] text-[10px] truncate flex-1">
        {active ? stateLabel(state, active.nickname) : "No server connected"}
      </span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-[var(--text-muted)] shrink-0"
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
}
