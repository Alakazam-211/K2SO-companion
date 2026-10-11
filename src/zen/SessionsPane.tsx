import { useEffect, useMemo, useRef, useState } from "react";
import {
  getActivePresets,
  getChatCustomNames,
  getChatList,
  getThreadLatest,
  getWorkspaceLiveSessions,
  spawnResumeTab,
} from "../api/client";
import { activityColor, activityForRow, type RowActivity } from "./agentActivity";
import { mainHandleOf, workspaceSessions } from "./sessionDrawer";
import { harnessOfSession } from "./llmHarness";
import { LlmIcon } from "./LlmIcon";
import { llmIconSvg } from "./llmIcons";
import { canSidecar, emojiByHarness, parseActiveLlms, type ActiveLlm } from "./llmPresets";
import { PlusGlyph } from "./PlusGlyph";
import {
  OPEN_READ_ONLY,
  OPEN_WITHOUT_WAKING,
  READ_ONLY_NOTE,
  WAKING,
  wakeHistoryRow,
  wakePlanFor,
} from "./historyWake";
import {
  buildHistory,
  HISTORY_PAGE,
  historyCandidates,
  isConversationAddr,
  latestBatches,
  launchForHarness,
  parseChatList,
  parseCustomNames,
  parseThreadLatest,
  parseWorkspaceLive,
  threadAddrOfLive,
  type ChatListEntry,
  type HistoryRow,
  type LatestEntry,
  type LiveWorkspaceSession,
} from "./sessionHistory";
import {
  matchSidecarSession,
  readRememberedSidecars,
  type OverlaySidecar,
  type SessionSidecarInput,
} from "./sidecarRows";
import type { StubAgent } from "./stubData";
import { mountainTime } from "./threadModel";
import { posixNormalize } from "./workspacePath";
import { useZenStore } from "./zenStore";
import { useZenScope, zenScope } from "./zenScope";
import { useRoomSessions } from "./room/useRoomSessions";
import { ServerChip } from "./room/ServerChip";
import {
  useNotifyPrefsStore,
  workspacePrefFor,
  workspaceSourceText,
} from "../stores/notifyPrefs";
import { BellIcon, useNotifyPrefsLive } from "./NotifyBell";

export const SESSIONS_EMPTY = "No other sessions in this workspace";
export const NEW_SESSION_LABEL = "New session";
/** Subtitle on a `+` choice the daemon can only run as a plain tab. */
export const OPENS_AS_TERMINAL = "Opens as a terminal";
export const ACTIVE_HEADING = "Active";
export const HISTORY_HEADING = "History";
export const HISTORY_EMPTY = "No past sessions";
export const SHOW_MORE = "Show more";
/** A live tab with no conversation (a blank shell): nothing to open. */
export const NO_THREAD_HINT = "No thread — a plain shell";

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
const HEADING = "px-3 pt-3 pb-1 text-[10px] tracking-widest text-[var(--text-muted)]";

function When({ at }: { at: number | null }) {
  const when = mountainTime(at);
  if (!when) return null;
  return (
    <span className="truncate text-[10px] text-[var(--text-muted)]" data-testid="session-when">
      {when}
    </span>
  );
}

/** "Notifications for <workspace>" at the top of the Sessions drawer
 *  (K2 0.45.5, `thread-push-v1`). One switch per workspace: sidecars ride
 *  their workspace's setting. Hidden until the active server has the
 *  feature and its prefs list this workspace. */
function WorkspaceNotify({
  handle,
  projectId,
  fallbackName,
}: {
  handle: string;
  projectId: string | null;
  fallbackName: string;
}) {
  // The bell is about the room's server (MS23), not the active one.
  const serverId = useZenScope().id || null;
  useNotifyPrefsLive(serverId ? [serverId] : []);
  const on = useNotifyPrefsStore((s) => !!serverId && s.threadPush[serverId] === true);
  const prefs = useNotifyPrefsStore((s) => (serverId ? s.prefs[serverId] : undefined));
  const error = useNotifyPrefsStore((s) => (serverId ? s.errors[serverId] ?? null : null));
  const ws = on ? workspacePrefFor(prefs, { handle, projectId }) : null;
  if (!serverId || !prefs || !ws) return null;
  const enabled = ws.threadPush;
  const name = ws.name || fallbackName || handle;
  const set = (v: boolean | null) =>
    void useNotifyPrefsStore.getState().setWorkspacePush(serverId, ws.projectId, v);
  return (
    <div
      className="px-3 py-2 border-b border-[var(--border)]"
      data-testid="workspace-notify"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--text)]">
          Notifications for {name}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`Notifications for ${name}`}
          data-testid="workspace-bell"
          className="shrink-0 flex items-center justify-center bg-transparent border-0"
          style={{ width: 28, height: 28, color: enabled ? "var(--text)" : "var(--text-muted)" }}
          onClick={() => set(!enabled)}
        >
          <BellIcon on={enabled} size={16} />
        </button>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
        <span className="truncate" data-testid="workspace-notify-source">
          {error ? `Could not save: ${error}` : workspaceSourceText(ws, prefs.principal)}
        </span>
        {ws.source === "user" ? (
          <button
            type="button"
            data-testid="workspace-notify-reset"
            className="shrink-0 bg-transparent border-0 p-0 text-[10px]"
            style={{ color: "var(--accent)" }}
            onClick={() => set(null)}
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Sessions in the open chat's workspace. Same shell as the Files drawer.
 *  **Active** (`GET /cli/companion/sessions`): Main, sidecar chats as
 *  `agent/sidecar`, then plain tabs. **+ New session**. **History**: past
 *  conversations here that are not open (see `sessionHistory.ts`). A
 *  History tap wakes the session first (`historyWake.ts`), so it moves to
 *  Active; a harness K2 cannot resume opens read-only.
 *  Every row opens its Thread in Done mode, never the terminal; the chat
 *  header's Terminal button still reaches the PTY. */
export function SessionsPane({
  agent,
  onClose,
  onOpenTerminal,
}: {
  agent: StubAgent | undefined;
  onClose: () => void;
  onOpenTerminal: (terminalId: string, title: string) => void;
}) {
  /** The room's server: the drawer lists, spawns and wakes on it (MA18). */
  const scope = useZenScope();
  const roomSessions = useRoomSessions(scope);
  const sessions = roomSessions.sessions;
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
  /** `/cli/sessions/list-for-workspace`: plain tab → Thread addr. */
  const [live, setLive] = useState<LiveWorkspaceSession[] | null>(null);
  const [chats, setChats] = useState<ChatListEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [latest, setLatest] = useState<Map<string, LatestEntry>>(() => new Map());
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [historyLoading, setHistoryLoading] = useState(true);
  /** History row being woken (its addr), and the last wake failure. */
  const [waking, setWaking] = useState<string | null>(null);
  const [wakeError, setWakeError] = useState<{ addr: string; error: string } | null>(null);
  /** Bumped after a wake to re-read live tabs + History. */
  const [reload, setReload] = useState(0);
  useEffect(() => {
    mounted.current = true;
    void getActivePresets(scope)
      .then((r) => {
        if (mounted.current) setLlms(r.ok ? parseActiveLlms(r.data) : null);
      })
      .catch(() => {
        if (mounted.current) setLlms(null);
      });
    return () => {
      mounted.current = false;
    };
  }, [scope]);

  useEffect(() => {
    let alive = true;
    void roomSessions
      .refresh()
      .finally(() => {
        if (alive) setLoading(false);
      });
    void useZenStore.getState().refreshActivity();
    return () => {
      alive = false;
    };
  }, []);

  const path = (agent?.path || "").trim();
  // A History conversation (bare id) is not a workspace handle: use the
  // workspace's main chat row on the same path.
  const handle = isConversationAddr(agent?.addr)
    ? mainHandleOf(
        agents.find(
          (a) =>
            (a.path || "").trim() === path &&
            a.kind !== "group" &&
            !!a.addr &&
            !a.addr.includes("/") &&
            !isConversationAddr(a.addr)
        )?.addr
      )
    : mainHandleOf(agent?.addr);

  useEffect(() => {
    if (!path) {
      setLive([]);
      setChats([]);
      setHistoryLoading(false);
      return;
    }
    let alive = true;
    void Promise.all([
      getWorkspaceLiveSessions(scope, path).catch(() => null),
      getChatList(scope, path).catch(() => null),
      getChatCustomNames(scope).catch(() => null),
    ]).then(([l, c, n]) => {
      if (!alive) return;
      setLive(l?.ok ? parseWorkspaceLive(l.data) : []);
      setChats(c?.ok ? parseChatList(c.data) : []);
      setNames(n?.ok ? parseCustomNames(n.data) : {});
    });
    return () => {
      alive = false;
    };
  }, [scope, path, reload]);

  const mainRow =
    agents.find(
      (a) => (a.path || "").trim() === path && (a.addr || "").trim() === handle && a.kind !== "group"
    ) ?? null;
  const name = mainRow?.name || agent?.name || handle;
  const serverProjects = useZenStore((s) => s.serverProjects);
  const normPath = posixNormalize(path);
  const workspaceProjectId =
    mainRow?.projectId ||
    agent?.projectId ||
    serverProjects.find((p) => !!normPath && p.path === normPath)?.id ||
    null;
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

  const liveById = new Map((live ?? []).map((l) => [l.sessionId, l]));
  const terminalRows = listed.terminals.map((t) => ({
    ...t,
    addr: threadAddrOfLive(liveById.get(t.terminalId)),
  }));
  const activeAddrs = new Set<string>([
    handle,
    ...listed.sidecars.map((c) => c.addr),
    ...terminalRows.map((t) => t.addr || ""),
  ].filter(Boolean));
  const liveConversations = (live ?? []).map((l) => l.conversationId || "").filter(Boolean);
  const mainConversation = latest.get(handle)?.conversationId ?? null;
  const activeConversations = new Set<string>(
    [...liveConversations, mainConversation || ""].filter(Boolean)
  );
  const remembered = useMemo(() => {
    const norm = posixNormalize(path);
    return readRememberedSidecars(scope.id, { adoptLegacy: true }).filter(
      (r) => norm && posixNormalize(r.path) === norm && mainHandleOf(r.addr) === handle
    );
  }, [scope, path, handle]);
  const candidates = chats ? historyCandidates(chats, activeConversations) : [];
  const page = candidates.slice(0, historyLimit);
  const lookupKey = [handle, ...remembered.map((r) => r.addr), ...page.map((c) => c.id)].join(",");

  useEffect(() => {
    if (!chats || live === null) return;
    const want = lookupKey.split(",").filter((a) => a && !latest.has(a));
    if (want.length === 0) {
      setHistoryLoading(false);
      return;
    }
    let alive = true;
    setHistoryLoading(true);
    void Promise.all(
      latestBatches(want).map((batch) => getThreadLatest(scope, batch).catch(() => null))
    ).then((results) => {
      if (!alive) return;
      const next = new Map(latest);
      for (const r of results) {
        if (!r?.ok) continue;
        for (const [addr, entry] of parseThreadLatest(r.data)) next.set(addr, entry);
      }
      // A failed lookup must not loop: mark what came back empty as missing.
      for (const a of want) if (!next.has(a)) next.set(a, { addr: a, conversationId: null, at: null, missing: true });
      setLatest(next);
      setHistoryLoading(false);
    });
    return () => {
      alive = false;
    };
    // `latest` is read, not watched: it changes only from this effect.
  }, [scope, lookupKey, chats, live]);

  const history: HistoryRow[] = chats
    ? buildHistory({
        chats: page,
        names,
        remembered,
        latest,
        activeAddrs,
        activeConversations,
      })
    : [];
  const historyMore = candidates.length > historyLimit;

  const pickMain = () => {
    onClose();
    openWorkspaceSession({ addr: handle, path });
  };
  const pickSide = (side: OverlaySidecar) => {
    onClose();
    openWorkspaceSession({ addr: side.addr, path: side.path, side });
  };
  /** A plain tab opens its Thread (`ws/N` or conversation id), not the PTY. */
  const pickTerminal = (t: { terminalId: string; title: string; addr: string | null }) => {
    if (!t.addr) return;
    pickSide({ addr: t.addr, path, name, chatTitle: t.title, terminalId: t.terminalId });
  };
  /** Open a History row's Thread without waking it (read-only history). */
  const openHistoryReadOnly = (h: HistoryRow) => {
    pickSide({
      addr: h.addr,
      path,
      name,
      chatTitle: h.label || h.title,
      hostLive: false,
      launch: launchForHarness(h.harness, llms),
    });
  };
  /** Wake a History row the way desktop Chat history does (resume spawn,
   *  or the sidecar respawn), then open its Thread in Done mode. A failure
   *  stays on the row with an "Open without waking" action. */
  const pickHistory = (h: HistoryRow) => {
    if (waking) return;
    if (wakePlanFor(h, llms).kind === "readonly") {
      openHistoryReadOnly(h);
      return;
    }
    setWaking(h.addr);
    setWakeError(null);
    // Captured once: the whole wake (list, spawn, resync) stays on it.
    const wakeScope = zenScope();
    void wakeHistoryRow(
      { row: h, path, llms, sidecarLaunch: launchForHarness(h.harness, llms) },
      {
        listLive: async (p) => {
          const r = await getWorkspaceLiveSessions(wakeScope, p);
          return r.ok ? parseWorkspaceLive(r.data) : null;
        },
        spawnTab: async (p, launch, label) => {
          const r = await spawnResumeTab(wakeScope, p, launch, label);
          return { ok: r.ok, sessionId: r.data?.sessionId ?? null, error: r.error };
        },
        ensureSidecar: (row) => useZenStore.getState().ensureSidecarHost(row),
        refreshSessions: () => roomSessions.refresh(),
      }
    ).then((r) => {
      if (!mounted.current) return;
      setWaking(null);
      if (!r.ok) {
        setWakeError({ addr: h.addr, error: r.error });
        return;
      }
      setReload((n) => n + 1);
      pickSide({
        addr: r.addr,
        path,
        name,
        chatTitle: h.label || h.title,
        hostLive: true,
        terminalId: r.terminalId ?? undefined,
        launch: launchForHarness(h.harness, llms),
      });
    });
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
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="truncate text-[10px] text-[var(--text-muted)] tracking-widest">
            Sessions
          </span>
          <ServerChip serverId={scope.id} testId="sessions-server" align="left" />
        </span>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] text-[11px] px-1"
          aria-label="Hide sessions"
        >
          ›
        </button>
      </div>
      {handle && agent?.kind !== "group" ? (
        <WorkspaceNotify
          handle={handle}
          projectId={workspaceProjectId}
          fallbackName={name}
        />
      ) : null}
      <div className="flex-1 overflow-y-auto">
        <div className={HEADING} data-testid="sessions-active">
          {ACTIVE_HEADING}
        </div>
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
        {terminalRows.map((t) => (
          <button
            key={t.terminalId}
            type="button"
            className={ROW}
            data-testid="session-row-terminal"
            data-thread-addr={t.addr || undefined}
            disabled={!t.addr}
            aria-disabled={!t.addr}
            style={t.addr ? undefined : { opacity: 0.5 }}
            onClick={() => pickTerminal(t)}
          >
            {iconFor(t.terminalId)}
            <span className="flex flex-col flex-1 min-w-0">
              <span className="truncate text-[12px] text-[var(--text)]">{t.title}</span>
              {t.addr ? (
                t.addr.includes("/") ? (
                  <span className="truncate text-[10px] text-[var(--text-muted)]">{t.addr}</span>
                ) : null
              ) : (
                <span
                  className="truncate text-[10px] text-[var(--text-muted)]"
                  data-testid="session-no-thread"
                >
                  {live === null ? "loading" : NO_THREAD_HINT}
                </span>
              )}
              <Status a={activityForRow({ terminalId: t.terminalId }, activity, true)} />
            </span>
            {t.addr && currentAddr === t.addr ? <Check /> : null}
          </button>
        ))}
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
        <div className={HEADING} data-testid="sessions-history">
          {HISTORY_HEADING}
        </div>
        {history.map((h) => {
          const busy = waking === h.addr;
          const readOnly = wakePlanFor(h, llms).kind === "readonly";
          const failed = wakeError?.addr === h.addr ? wakeError.error : null;
          const emoji = h.harness && !llmIconSvg(h.harness) ? emojis[h.harness] ?? null : null;
          return (
            <div key={h.addr} data-testid="session-history-item" data-thread-addr={h.addr}>
              <button
                type="button"
                className={ROW}
                data-testid="session-row-history"
                data-thread-addr={h.addr}
                data-read-only={readOnly || undefined}
                aria-busy={busy || undefined}
                disabled={!!waking}
                style={waking && !busy ? { opacity: 0.4 } : undefined}
                onClick={() => pickHistory(h)}
              >
                <LlmIcon harness={h.harness} emoji={emoji} />
                <span className="flex flex-col flex-1 min-w-0">
                  <span className="truncate text-[12px] text-[var(--text)]">{h.title}</span>
                  {h.label ? (
                    <span className="truncate text-[10px] text-[var(--text-muted)]">{h.label}</span>
                  ) : null}
                  {busy ? (
                    <span
                      className="truncate text-[10px] text-[var(--accent)]"
                      data-testid="session-waking"
                    >
                      {WAKING}
                    </span>
                  ) : (
                    <When at={h.at} />
                  )}
                  {readOnly ? (
                    <>
                      <span
                        className="truncate text-[10px] text-[var(--text)]"
                        data-testid="session-read-only"
                      >
                        {OPEN_READ_ONLY}
                      </span>
                      <span
                        className="text-[10px] leading-snug text-[var(--text-muted)]"
                        data-testid="session-read-only-note"
                      >
                        {READ_ONLY_NOTE}
                      </span>
                    </>
                  ) : null}
                </span>
                {currentAddr === h.addr ? <Check /> : null}
              </button>
              {failed ? (
                <div className="px-3 pb-2 border-b border-[var(--border)]">
                  <p
                    className="text-[11px]"
                    style={{ color: "#ef4444" }}
                    role="alert"
                    data-testid="session-wake-error"
                  >
                    {failed}
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-[11px] text-[var(--accent)] bg-transparent p-0"
                    data-testid="session-open-without-waking"
                    onClick={() => {
                      setWakeError(null);
                      openHistoryReadOnly(h);
                    }}
                  >
                    {OPEN_WITHOUT_WAKING}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
        {history.length === 0 ? (
          <div
            className="px-3 py-2 text-[12px] text-[var(--text-muted)]"
            data-testid="sessions-history-empty"
          >
            {historyLoading || chats === null ? "loading" : HISTORY_EMPTY}
          </div>
        ) : null}
        {historyMore ? (
          <div className="p-2">
            <button
              type="button"
              className="w-full text-center text-[12px] text-[var(--text-muted)] bg-transparent py-1"
              data-testid="sessions-history-more"
              disabled={historyLoading}
              onClick={() => setHistoryLimit((n) => n + HISTORY_PAGE)}
            >
              {historyLoading ? "loading" : SHOW_MORE}
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
