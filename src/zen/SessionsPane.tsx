import { useEffect, useRef, useState } from "react";
import { getActivePresets } from "../api/client";
import { useWorkspacesStore } from "../stores/workspaces";
import { activityColor, activityForRow, type RowActivity } from "./agentActivity";
import { mainHandleOf, workspaceSessions } from "./sessionDrawer";
import { harnessOfSession } from "./llmHarness";
import { LlmIcon } from "./LlmIcon";
import { llmIconSvg } from "./llmIcons";
import { canSidecar, emojiByHarness, parseActiveLlms, type ActiveLlm } from "./llmPresets";
import { PlusGlyph } from "./PlusGlyph";
import { matchSidecarSession, type OverlaySidecar, type SessionSidecarInput } from "./sidecarRows";
import type { StubAgent } from "./stubData";
import { useZenStore } from "./zenStore";

export const SESSIONS_EMPTY = "No other sessions in this workspace";
export const NEW_SESSION_LABEL = "New session";
/** Subtitle on a `+` choice the daemon can only run as a plain tab. */
export const OPENS_AS_TERMINAL = "Opens as a terminal";

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
  const spawnLlmSession = useZenStore((s) => s.spawnLlmSession);
  const [loading, setLoading] = useState(true);
  /** Enabled presets (`GET /cli/companion/presets`). Null hides `+`
   *  (not loaded, 404 on an older daemon, or an unknown body). */
  const [llms, setLlms] = useState<ActiveLlm[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void getActivePresets()
      .then((r) => {
        if (mounted.current) setLlms(r.ok ? parseActiveLlms(r.data) : null);
      })
      .catch(() => {
        if (mounted.current) setLlms(null);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

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
  const byTerminal = new Map<string, SessionSidecarInput>();
  for (const s of sessions) if (s.terminalId) byTerminal.set(s.terminalId, s);
  const emojis = emojiByHarness(llms);
  const iconFor = (terminalId: string | null | undefined, fallback?: SessionSidecarInput) => {
    const harness = harnessOfSession(
      (terminalId ? byTerminal.get(terminalId) : undefined) ?? fallback ?? { terminalId },
      activity.bySession
    );
    // A vendored mark wins; a custom preset's emoji covers the rest.
    const emoji = harness && !llmIconSvg(harness) ? emojis[harness] ?? null : null;
    return <LlmIcon harness={harness} emoji={emoji} />;
  };
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
  const pickLlm = (llm: ActiveLlm) => {
    if (!agent || pendingId) return;
    setPendingId(llm.id);
    setAddError(null);
    void spawnLlmSession(
      agent.id,
      llm,
      listed.sidecars.map((c) => c.addr)
    ).then((r) => {
      if (!r.ok) {
        if (mounted.current) {
          setPendingId(null);
          setAddError(r.error);
        }
        return;
      }
      if (mounted.current) setPendingId(null);
      onClose();
      if (r.kind === "terminal") onOpenTerminal(r.terminalId, r.title);
    });
  };
  const canAdd = !!agent && !!path && !!handle && agent.kind !== "group" && !!llms && llms.length > 0;

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
            {iconFor(listed.mainTerminalId)}
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
            {iconFor(side.terminalId, matchSidecarSession(side.addr, side.path, sessions))}
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
                {iconFor(t.terminalId)}
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
        {canAdd ? (
          <div className="p-2" data-testid="sessions-new">
            <button
              type="button"
              className="w-full flex items-center gap-2 text-left zen-glass zen-glass-round"
              style={{ minHeight: 40, padding: "0 12px", color: "var(--text)" }}
              aria-expanded={addOpen}
              data-testid="sessions-new-toggle"
              disabled={!!pendingId}
              onClick={() => {
                setAddError(null);
                setAddOpen((v) => !v);
              }}
            >
              <PlusGlyph />
              <span className="text-[13px]">{NEW_SESSION_LABEL}</span>
            </button>
            {addOpen ? (
              <div
                role="menu"
                aria-label="Active LLMs"
                className="mt-2 overflow-hidden zen-glass zen-glass-round"
                data-testid="sessions-llm-list"
              >
                {llms!.map((llm) => {
                  const busy = pendingId === llm.id;
                  const terminalOnly = !canSidecar(llm.harness);
                  return (
                    <button
                      key={llm.id}
                      type="button"
                      role="menuitem"
                      className="w-full flex items-center gap-2 text-left px-3 py-2 bg-transparent border-b border-[rgba(255,255,255,0.08)] last:border-b-0"
                      style={{ opacity: pendingId && !busy ? 0.4 : 1 }}
                      disabled={!!pendingId}
                      data-testid="sessions-llm"
                      data-llm-id={llm.id}
                      onClick={() => pickLlm(llm)}
                    >
                      <LlmIcon harness={llm.harness ?? llm.name} emoji={llm.emoji} />
                      <span className="flex flex-col flex-1 min-w-0">
                        <span className="truncate text-[12px] text-[var(--text)]">
                          {busy ? `Starting ${llm.name}…` : llm.name}
                        </span>
                        {terminalOnly ? (
                          <span className="truncate text-[10px] text-[var(--text-muted)]">
                            {OPENS_AS_TERMINAL}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {addError ? (
              <p
                className="mt-2 px-1 text-[11px]"
                style={{ color: "#ef4444" }}
                role="alert"
                data-testid="sessions-new-error"
              >
                {addError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
