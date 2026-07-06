import { useNavigate } from "react-router-dom";
import {
  useServersStore,
  signOutServer,
  hostLabel,
  type RecoveryState,
} from "../stores/servers";

const STATE_LABEL: Record<RecoveryState, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting…",
  reauthenticating: "Re-authenticating…",
  "signin-required": "Sign-in required",
};

const STATE_COLOR: Record<RecoveryState, string> = {
  connected: "var(--success)",
  reconnecting: "var(--warning)",
  reauthenticating: "var(--warning)",
  "signin-required": "var(--error)",
};

export function Settings() {
  const navigate = useNavigate();
  const servers = useServersStore((s) => s.servers);
  const activeServerId = useServersStore((s) => s.activeServerId);
  const recovery = useServersStore((s) => s.recovery);

  const active = servers.find((s) => s.id === activeServerId) ?? null;
  const state: RecoveryState = active
    ? recovery[active.id] ?? "connected"
    : "signin-required";

  return (
    <div className="flex flex-col h-full overflow-y-auto py-4 px-1.5 pb-safe">
      <Section title="Active server">
        {active ? (
          <>
            <Row label="Nickname" value={active.nickname} />
            <Row label="Server" value={hostLabel(active.url)} />
            <Row label="Username" value={active.username} />
            <Row
              label="Password"
              value={active.rememberPassword ? "Remembered" : "Not stored"}
            />
            <Row
              label="State"
              value={
                <span className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: STATE_COLOR[state] }}
                  />
                  {STATE_LABEL[state]}
                </span>
              }
            />
          </>
        ) : (
          <Row label="Server" value="None" />
        )}
      </Section>

      <Section title="About">
        <Row label="Version" value="2.0.0" />
        <Row label="App" value="K2" />
        <Row label="Engine" value="Tauri v2" />
      </Section>

      <button
        onClick={() => navigate("/servers")}
        className="w-full border border-[var(--accent-dim)] text-[var(--accent)] font-semibold text-[13px] py-3.5 mt-4 hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-all"
      >
        Manage servers
      </button>

      {active && (
        <button
          onClick={() => {
            // Deliberate sign-out of THIS server only: drops its token and
            // its remembered password; other servers are untouched.
            signOutServer(active.id);
            navigate("/servers");
          }}
          className="w-full border border-[var(--error)]/30 text-[var(--error)] font-semibold text-[13px] py-3.5 mt-3 hover:border-[var(--error)] hover:bg-[var(--error)]/5 transition-all"
        >
          Sign out of {active.nickname}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] overflow-hidden mb-4">
      <h3 className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase px-4 pt-4 pb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center px-4 py-3.5 border-t border-[var(--border)]">
      <span className="text-[var(--text-muted)] text-[11px]">{label}</span>
      <span className="text-[var(--text)] text-[11px] text-right truncate ml-4 max-w-[60%]">{value}</span>
    </div>
  );
}
