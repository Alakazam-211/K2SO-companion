import { useNavigate } from "react-router-dom";
import {
  useServersStore,
  signOutServer,
  hostLabel,
  type RecoveryState,
} from "../stores/servers";
import { usePushToggle } from "../lib/usePushToggle";
import { ABOUT } from "../lib/about";

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
    <div className="flex flex-col h-full min-h-0 overflow-y-auto py-4 px-1.5 pb-safe">
      <Section title="Active server">
        {active ? (
          <>
            <Row label="Nickname" value={active.nickname} />
            <Row label="Server" value={hostLabel(active.url)} />
            <Row label="Username" value={active.username} />
            <Row label="Password" value="Not stored" />
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

      <Section title="Notifications">
        <PushRow />
      </Section>

      <Section title="Zen mode">
        <button
          onClick={() => navigate("/zen")}
          className="w-full text-left px-4 py-3 text-[13px] text-[var(--accent)]"
        >
          Open Zen
        </button>
      </Section>

      <Section title="About">
        <Row label="Version" value={ABOUT.version} />
        <Row label="App" value={ABOUT.app} />
        <Row label="Engine" value={ABOUT.engine} />
      </Section>

      {/* Thumb-sized actions: full-width, ≥52px tall, and a WIDE gap
          between them — a mis-tap on Manage servers must never land on
          the (danger-styled) sign-out. */}
      <button
        onClick={() => navigate("/servers")}
        className="w-full min-h-[52px] border border-[var(--accent-dim)] text-[var(--accent)] font-semibold text-[14px] py-4 mt-4 hover:border-[var(--accent)] hover:bg-[var(--accent)]/5 transition-all"
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
          className="w-full min-h-[52px] border border-[var(--error)]/50 bg-[var(--error)]/10 text-[var(--error)] font-semibold text-[14px] py-4 mt-8 mb-2 hover:border-[var(--error)] hover:bg-[var(--error)]/15 transition-all"
        >
          Sign out of {active.nickname}
        </button>
      )}
    </div>
  );
}

/** C6 "Push notifications" toggle. DORMANT state (today's builds — no
 *  APNs entitlement / no google-services.json): shows a disabled "Not
 *  available in this build" row instead of the switch. When available,
 *  toggling ON runs the permission→token→register-device flow for the
 *  active server; OFF unregisters this device from every saved server
 *  (registration follows the active server around). */
function PushRow() {
  const { available, reason, enabled, busy, toggle } = usePushToggle();

  if (available === null) {
    return <Row label="Push notifications" value="…" />;
  }
  if (!available) {
    // Surface the probe's diagnostic so a dormant/broken state is
    // debuggable from the Settings screen itself.
    return (
      <Row
        label="Push notifications"
        value={reason ? `Unavailable: ${reason}` : "Not available in this build"}
      />
    );
  }

  return (
    <Row
      label="Push notifications"
      value={
        <button
          onClick={() => void toggle()}
          aria-pressed={enabled}
          // Thumb-sized switch: 48×28 visual pill inside a 56×44 hit area
          // (the button box), so the row breathes and the tap can't miss.
          className="flex items-center justify-center w-14 h-11 -my-2"
          style={{ opacity: busy ? 0.6 : 1 }}
        >
          <span
            className="relative block w-12 h-7 transition-colors"
            style={{
              // Desktop Settings toggle, scaled up: fully SQUARE (zero
              // radius), track = accent when on / border-fill when off,
              // thumb always white — the white square is what makes the
              // OFF state read as a control.
              background: enabled ? "var(--accent)" : "var(--border)",
            }}
          >
            <span
              className="absolute top-1 w-5 h-5 bg-[var(--on-fill)] transition-all"
              style={{ left: enabled ? "24px" : "4px" }}
            />
          </span>
        </button>
      }
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] overflow-hidden mb-4 shrink-0 theme-radius">
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
