import { useAuthStore } from "../stores/auth";
import { ws } from "../api/websocket";

export function Settings() {
  const { serverUrl, username, logout } = useAuthStore();
  const isWsConnected = ws.isConnected;

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4">
      <Section title="Connection">
        <Row label="Server" value={serverUrl} />
        <Row label="Username" value={username} />
        <Row
          label="WebSocket"
          value={
            <span className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: isWsConnected ? "var(--success)" : "var(--error)" }}
              />
              {isWsConnected ? "Connected" : "Disconnected"}
            </span>
          }
        />
      </Section>

      <Section title="About">
        <Row label="Version" value="1.0.0" />
        <Row label="App" value="K2SO Companion" />
        <Row label="Engine" value="Tauri v2" />
      </Section>

      <button
        onClick={() => logout()}
        className="w-full border border-[var(--error)]/30 text-[var(--error)] font-semibold text-[13px] py-3.5 mt-4 hover:border-[var(--error)] hover:bg-[var(--error)]/5 transition-all"
      >
        Disconnect
      </button>
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
