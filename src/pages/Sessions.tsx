import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkspacesStore } from "../stores/workspaces";
import { setTabTitle, type GlobalSession } from "../api/client";
import { SessionTitle } from "../components/SessionTitle";

export function Sessions() {
  const allSessions = useWorkspacesStore((s) => s.allSessions);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  // Long-press → rename (non-pinned tabs only). One press at a time, so a
  // single shared timer/flag is fine.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const [renameTarget, setRenameTarget] = useState<{ projectId: string; tabId: string; current: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  const startPress = (session: GlobalSession) => {
    longPressed.current = false;
    // Only tab-driven, non-pinned sessions are renamable (the pinned main
    // chat isn't; non-tab sessions have no tab to title).
    if (session.isMainChat || !session.tabId || !session.projectId) return;
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      const current = session.label || session.agentName;
      setRenameValue(current);
      setRenameTarget({ projectId: session.projectId!, tabId: session.tabId!, current });
    }, 500);
  };
  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const onCardClick = (session: GlobalSession) => {
    if (longPressed.current) {
      longPressed.current = false; // swallow the click that follows a long-press
      return;
    }
    navigate(`/chat/${session.terminalId}`);
  };

  const saveRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    setSavingRename(true);
    const r = await setTabTitle(renameTarget.projectId, renameTarget.tabId, name);
    await useWorkspacesStore.getState().fetchAllSessions();
    setSavingRename(false);
    if (r.ok) setRenameTarget(null); // keep the modal open if it didn't save
  };

  // Sort alphabetically by label, filter by search
  const filtered = allSessions
    .filter((s) => {
      if (!query) return true;
      const q = query.toLowerCase();
      const hay = [
        s.label,
        s.workspaceName,
        s.agentName,
        s.isMainChat ? "main chat" : "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col h-full min-h-0 pb-safe">
      <div
        className="shrink-0 px-4 pt-3 pb-3"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border-hover)",
        }}
      >
        <div className="relative min-w-0">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="w-full min-w-0 text-[var(--text)] text-[14px] focus:outline-none"
            style={{
              padding: "10px 32px 10px 12px",
              background: "var(--background)",
              border: "1px solid var(--border-hover)",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--accent-dim)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border-hover)";
            }}
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-0 top-0 h-full w-8 flex items-center justify-center text-[var(--text-muted)]"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 gap-2">
            <span className="text-[var(--text-muted)] text-[13px]">
              {allSessions.length === 0
                ? "No active sessions"
                : "No matching sessions"}
            </span>
            {allSessions.length === 0 && (
              <span className="text-[var(--text-muted)] text-[11px] opacity-60">
                Tap + to start a new session
              </span>
            )}
          </div>
        ) : (
          <div className="py-1 px-1.5 flex flex-col gap-1">
            {filtered.map((session) => (
              <button
                key={session.terminalId}
                onClick={() => onCardClick(session)}
                onTouchStart={() => startPress(session)}
                onTouchEnd={cancelPress}
                onTouchMove={cancelPress}
                onContextMenu={(e) => e.preventDefault()}
                className="flex items-center gap-2.5 text-left w-full"
                style={{
                  padding: "8px 12px",
                  minHeight: 44,
                  background: "#1c1c1e",
                  border: "1px solid #333",
                }}
              >
                {/* Workspace color bar */}
                <div
                  className="w-1 self-stretch shrink-0"
                  style={{ backgroundColor: session.workspaceColor || "var(--accent)" }}
                />
                {/* [workspace name] | [main chat badge | tab name] */}
                <div className="flex-1 min-w-0">
                  <SessionTitle session={session} />
                </div>
                {/* Online indicator */}
                <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Rename modal (long-press a non-pinned card) — centered */}
      {renameTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          onClick={() => !savingRename && setRenameTarget(null)}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative w-full max-w-sm bg-[var(--surface)] border border-[var(--border)] p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[var(--text)] text-[13px] font-semibold">Rename tab</span>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveRename(); }}
              placeholder="Tab name"
              className="w-full bg-[var(--background)] border border-[var(--border)] px-3 py-2.5 text-[var(--text)] text-[13px] focus:outline-none focus:border-[var(--accent-dim)]"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRenameTarget(null)}
                disabled={savingRename}
                className="px-4 py-2 text-[var(--text-muted)] text-[12px]"
              >
                Cancel
              </button>
              <button
                onClick={saveRename}
                disabled={savingRename || !renameValue.trim()}
                className="px-4 py-2 bg-white text-black font-semibold text-[12px] disabled:opacity-40"
              >
                {savingRename ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
