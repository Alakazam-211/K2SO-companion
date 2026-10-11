import { useEffect, useState } from "react";
import { useWorkspacesStore } from "../stores/workspaces";
import { activityColor, activityForRow, type RowActivity } from "./agentActivity";
import { mainHandleOf, workspaceSessions } from "./sessionDrawer";
import type { OverlaySidecar } from "./sidecarRows";
import type { StubAgent } from "./stubData";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { useZenStore } from "./zenStore";

export const SESSIONS_EMPTY = "No other sessions in this workspace";

function activityWord(a: RowActivity): string {
  return a.display === "waiting" ? "Needs you" : a.display === "monitoring" ? "Monitoring" : "Working";
}

function Status({ a }: { a: RowActivity | null }) {
  if (!a) return null;
  return (
    <span
      className="flex items-center gap-1 text-[10px] shrink-0"
      style={{ color: activityColor(a) }}
      data-testid="session-activity"
    >
      <span
        aria-hidden
        className="inline-block rounded-full"
        style={{ width: 6, height: 6, background: activityColor(a) }}
      />
      {activityWord(a)}
    </span>
  );
}

function Check() {
  return (
    <svg
      data-testid="session-current"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Viewing"
      className="shrink-0"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

const ROW =
  "w-full flex items-center gap-2 text-left px-3 py-2 border-b border-[var(--border)] bg-transparent";

/** Tabs open in the open chat's workspace (`GET /cli/companion/sessions`).
 *  Same shell as the Files drawer. Main chat first, then sidecar chats as
 *  `agent/sidecar`, then plain terminals. */
export function SessionsPane({
  agent,
  onClose,
  onOpenTerminal,
}: {
  agent: StubAgent | undefined;
  onClose: () => void;
  onOpenTerminal: (terminalId: string, title: string) => void;
}) {
  const sessions = useWorkspacesStore((s) => s.allSessions);
  const agents = useZenStore((s) => s.agents);
  const activity = useZenStore((s) => s.activity);
  const chatSessions = useZenStore((s) => s.chatSessions);
  const openWorkspaceSession = useZenStore((s) => s.openWorkspaceSession);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void useWorkspacesStore
      .getState()
      .fetchAllSessions()
      .finally(() => {
        if (alive) setLoading(false);
      });
    void useZenStore.getState().refreshActivity();
    return () => {
      alive = false;
    };
  }, []);

  const path = (agent?.path || "").trim();
  const handle = mainHandleOf(agent?.addr);
  const mainRow =
    agents.find(
      (a) => (a.path || "").trim() === path && (a.addr || "").trim() === handle && a.kind !== "group"
    ) ?? null;
  const name = mainRow?.name || agent?.name || handle;
  const listed = path && handle
    ? workspaceSessions(sessions, { path, name, addr: handle })
    : { mainTerminalId: null, sidecars: [] as OverlaySidecar[], terminals: [] };
  const currentAddr = (agent?.addr || "").trim();
  const avatar = mainRow ?? agent;
  const hasOthers =
    currentAddr !== handle || listed.sidecars.length > 0 || listed.terminals.length > 0;

  const pickMain = () => {
    onClose();
    openWorkspaceSession({ addr: handle, path });
  };
  const pickSide = (side: OverlaySidecar) => {
    onClose();
    openWorkspaceSession({ addr: side.addr, path: side.path, side });
  };

  return (
    <aside
      className="flex flex-col h-full min-h-0 border-l border-[var(--border)] bg-[var(--surface)] shrink-0"
      style={{ width: 220 }}
      aria-label="Sessions"
      data-testid="sessions-drawer"
    >
      <div className="flex items-center px-2 h-9 border-b border-[var(--border)]">
        <span className="flex-1 min-w-0 truncate text-[10px] text-[var(--text-muted)] tracking-widest">
          Sessions
        </span>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] text-[11px] px-1"
          aria-label="Hide sessions"
        >
          ›
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {handle ? (
          <button type="button" className={ROW} data-testid="session-row-main" onClick={pickMain}>
            <WorkspaceAvatar
              initial={avatar?.initial || name.slice(0, 1) || "?"}
              color={avatar?.color}
              iconUrl={avatar?.iconUrl}
              size={24}
              fontSize={10}
              fallback="#2c2c2e"
            />
            <span className="flex flex-col flex-1 min-w-0">
              <span className="truncate text-[12px] text-[var(--text)]">Main</span>
              <span className="truncate text-[10px] text-[var(--text-muted)]">{handle}</span>
              <Status
                a={
                  path
                    ? activityForRow({ path, addr: handle }, activity, false, chatSessions)
                    : null
                }
              />
            </span>
            {currentAddr === handle ? <Check /> : null}
          </button>
        ) : null}
        {listed.sidecars.map((side) => (
          <button
            key={side.addr}
            type="button"
            className={ROW}
            data-testid="session-row-sidecar"
            onClick={() => pickSide(side)}
          >
            <span className="flex flex-col flex-1 min-w-0">
              <span className="truncate text-[12px] text-[var(--text)]">{side.addr}</span>
              {side.chatTitle && side.chatTitle !== side.addr.split("/").slice(1).join("/") ? (
                <span className="truncate text-[10px] text-[var(--text-muted)]">{side.chatTitle}</span>
              ) : null}
              <Status a={activityForRow(side, activity, true)} />
            </span>
            {currentAddr === side.addr ? <Check /> : null}
          </button>
        ))}
        {listed.terminals.length > 0 ? (
          <>
            <div
              className="px-3 pt-3 pb-1 text-[10px] tracking-widest text-[var(--text-muted)]"
              data-testid="sessions-terminals"
            >
              Terminals
            </div>
            {listed.terminals.map((t) => (
              <button
                key={t.terminalId}
                type="button"
                className={ROW}
                data-testid="session-row-terminal"
                onClick={() => {
                  onClose();
                  onOpenTerminal(t.terminalId, t.title);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-[var(--text-muted)]">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <span className="flex flex-col flex-1 min-w-0">
                  <span className="truncate text-[12px] text-[var(--text)]">{t.title}</span>
                  <Status a={activityForRow({ terminalId: t.terminalId }, activity, true)} />
                </span>
              </button>
            ))}
          </>
        ) : null}
        {!hasOthers ? (
          <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]" data-testid="sessions-empty">
            {loading && sessions.length === 0 ? "loading" : SESSIONS_EMPTY}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
