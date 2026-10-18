import { useEffect, useState, useSyncExternalStore } from "react";
import { chatCache } from "./chatCache";
import { chatOpenTimings, subscribeChatTimings, type ChatOpenTiming } from "./chatTiming";

const MUTED = "#8e8e93";

let snapshot: ChatOpenTiming[] = chatOpenTimings();
let version = 0;
function subscribe(fn: () => void) {
  return subscribeChatTimings(() => {
    version += 1;
    fn();
  });
}
let seen = -1;
function getSnapshot(): ChatOpenTiming[] {
  if (seen !== version) {
    seen = version;
    snapshot = chatOpenTimings();
  }
  return snapshot;
}

function ms(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)} ms`;
}

function size(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line per open: what was painted from cache and when the server
 *  answered. */
export function timingLine(t: ChatOpenTiming): string {
  const cached = t.cachedMs != null ? `cache ${ms(t.cachedMs)} (${t.cachedFrom}, ${t.cachedCount})` : "no cache";
  const server =
    t.responseMs == null
      ? "waiting"
      : t.ok === false
        ? `failed ${ms(t.responseMs)}`
        : `server ${ms(t.responseMs)} · paint ${ms(t.paintMs)} · ${t.items ?? "—"} items · ${size(t.bytes)}`;
  return `${cached} · ${server}`;
}

/** Server settings → Diagnostics → "Chat open timing": the last opens on
 *  this server (this session only, in memory) and the chat cache's size.
 *  Collapsed by default. */
export function ChatTimingRow({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  const all = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const rows = all.filter((t) => t.serverId === serverId).slice(0, 12);
  const [stats, setStats] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void chatCache()
      .stats()
      .then((s) => {
        if (live) setStats(`${s.device} chats on this phone · ${size(s.bytes)} · ${s.memory} in memory (${s.backend})`);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);
  const panelId = `server-settings-chat-timing-${serverId}`;
  return (
    <div data-testid="server-settings-chat-timing">
      <button
        type="button"
        className="w-full flex items-center justify-between text-left text-[15px]"
        style={{ minHeight: 40, padding: "9px 16px", color: MUTED }}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="server-settings-chat-timing-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Chat open timing</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke={MUTED}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {open ? (
        <div
          id={panelId}
          className="text-[12px]"
          style={{ padding: "0 16px 10px", color: MUTED, lineHeight: 1.45 }}
          data-testid="server-settings-chat-timing-panel"
        >
          {stats ? <div style={{ marginBottom: 6 }}>{stats}</div> : null}
          {rows.length === 0 ? (
            <span>No chats opened on this server yet.</span>
          ) : (
            rows.map((t) => (
              <div key={t.id} style={{ marginBottom: 4 }} data-testid="chat-timing-row">
                <div className="truncate" style={{ color: "#fff" }}>
                  {t.kind === "project" ? "Project chat" : t.room.replace(/^t:/, "")}
                </div>
                <div>{timingLine(t)}</div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
