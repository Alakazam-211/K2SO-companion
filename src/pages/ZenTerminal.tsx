import { useState, useRef, useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { useParams, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { fullViewportHeight, useViewport } from "../lib/useViewportHeight";
import { keyboardColumnHeight } from "../kit/mobileChat/useKeyboardFlip";
import { useKeyboardForwardPlay } from "../kit/mobileChat/useKeyboardForwardPlay";
import { useTapToDismiss } from "../kit/mobileChat/useTapToDismiss";
import { useWorkspacesStore } from "../stores/workspaces";
import { TerminalView } from "../components/TerminalView";
import { ensurePinnedChat, uploadFsBinary } from "../api/client";
import { MessageComposer } from "../components/MessageComposer";
import { AccessoryBar } from "../components/AccessoryBar";
import { LiveInputCapture } from "../components/LiveInputCapture";
import { sendMessageToSession } from "../api/sendMessage";
import type { LiveLocalEdit } from "../lib/liveInputText";
import {
  modeFor,
  setSendMode,
  getDirectHandles,
  subscribeSendModes,
  pruneSendModes,
  type SendMode,
} from "../lib/sendMode";
import { WorkspaceAvatar } from "../zen/WorkspaceAvatar";
import { composerPlaceholder } from "../zen/GlassComposer";
import {
  MAX_UPLOAD_BYTES,
  attachPathsToDraft,
  fileToBase64,
  uploadDirOf,
  uploadFilename,
  workspaceHandleOf,
} from "../zen/composerAttach";
import { useZenStore } from "../zen/zenStore";
import { threadHeaderTitle, threadSidecarTitle } from "../zen/overlayExtras";
import {
  readZenReturn,
  readZenTerminalAgent,
  readZenThread,
  readZenThreadServer,
  terminalIdForAgent,
  zenAddrPath,
  zenTerminalPath,
  zenThreadPath,
  type ZenTerminalAgent,
} from "../zen/terminalJump";
import { scopeFor, scopedKey } from "../api/scope";
import { zenScope } from "../zen/zenScope";
import { useRoomSessions } from "../zen/room/useRoomSessions";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { ServerChip } from "../zen/room/ServerChip";
import { ZEN_SERVER_PARAM, resolveServerRef, withServerParam } from "../zen/room/serverRef";
import { PencilIcon } from "../zen/icons";
import { useBackHandler } from "../lib/androidBack";

const DEV_MODE: boolean = import.meta.env?.DEV ?? false;

const PILL_PX = 34;
const PILL: CSSProperties = { width: PILL_PX, height: PILL_PX, color: "#fff" };
/* Viewer/Claimer segmented control (iOS-style). The selected thumb sits
   fully inside the glass pill: inset by SEG_PAD, radius = outer − pad. */
const SEG_H = 32;
const SEG_PAD = 3;
const SEG_W = 28;
const SEG_THUMB_R = SEG_H / 2 - SEG_PAD;
const SEG_BTN: CSSProperties = { width: SEG_W, height: "100%" };
/** Compact row: avatar left of a name / "Terminal" stack. */
const AVATAR_PX = 28;
/** Header row height (plus the top safe area). */
export const ZEN_TERMINAL_HEADER_PX = 46;

/** Zen terminal page — a glass copy of the ChatSession shell. Same
 *  TerminalView, Watch/Drive, send modes, reload/respawn and keyboard
 *  sizing; only the chrome differs. Back returns to the agent's Zen
 *  thread, never /sessions. No thread toggle here by design. */
export function ZenTerminal() {
  const { terminalId } = useParams<{ terminalId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  // The server this terminal lives on, fixed for the page (MS6/MS7, MA17):
  // `?server=` (a room on another server, flag on), else Zen's room
  // server, which with no room open is the active one. Old links without
  // `server=` mean the active server.
  const multiOn = useMultiServerPrefs((s) => s.multiServer);
  const [termScope] = useState(() => {
    const ref = multiOn ? (search.get(ZEN_SERVER_PARAM) || "").trim() : "";
    const id = ref ? resolveServerRef(ref) : null;
    return id ? scopeFor(id) : zenScope();
  });
  // Another server's sessions come from THAT server (MA18).
  const { sessions: allSessions, onActive } = useRoomSessions(termScope);
  const projects = useWorkspacesStore((s) => s.projects);
  const session = allSessions.find((sess) => sess.terminalId === terminalId);

  // Who this terminal belongs to: router state (survives reload via
  // history.state) → the Zen store by terminal id → generic header.
  const stateAgent = readZenTerminalAgent(location.state);
  const zenAgents = useZenStore((s) => s.agents);
  const storeAgent = stateAgent
    ? null
    : zenAgents.find((a) => a.terminalId && a.terminalId === terminalId) ??
      zenAgents.find(
        (a) => a.kind !== "group" && terminalIdForAgent(a, allSessions) === terminalId
      ) ??
      null;
  const agent: ZenTerminalAgent | null =
    stateAgent ??
    (storeAgent
      ? {
          agentId: storeAgent.id,
          name: threadHeaderTitle(storeAgent),
          initial: storeAgent.initial,
          color: storeAgent.color,
          iconUrl: storeAgent.iconUrl,
          chatTitle: threadSidecarTitle(storeAgent),
          projectPath: storeAgent.path ?? null,
          addr: storeAgent.addr ?? null,
        }
      : null);
  // `＋` uploads into the agent's workspace `.k2/downloads/` (the Zen
  // thread's flow, desktop's compose bar): handle from its overlay addr,
  // dir from its absolute path.
  const storeById = agent ? zenAgents.find((a) => a.id === agent.agentId) : undefined;
  const attachWorkspace = workspaceHandleOf(agent?.addr ?? storeById?.addr);
  const attachDir = uploadDirOf(agent?.projectPath ?? storeById?.path);
  const canAttach = Boolean(attachWorkspace) && Boolean(attachDir);
  const agentName = (agent?.name || "").trim();
  const headerName = agentName && agentName !== "—" ? agentName : "Terminal";

  const projectPath = session?.cwd || agent?.projectPath || "";
  const workspacePath =
    (session && projects.find((p) => p.id === session.workspaceId)?.path) ||
    projectPath;
  const [input, setInput] = useState("");
  const viewport = useViewport();
  const containerHeight = viewport.height;

  const directHandles = useSyncExternalStore(
    subscribeSendModes,
    getDirectHandles,
    getDirectHandles
  );
  // Send-mode memory is per server (MA6): `<serverId>|<terminalId>`.
  const modeKey = terminalId ? scopedKey(termScope, terminalId) : "";
  const sendMode: SendMode = modeKey ? modeFor(directHandles, modeKey) : "safe";
  const sendModeRef = useRef(sendMode);
  sendModeRef.current = sendMode;
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Watch (default) is a size policy; Drive is an explicit tap, reset
  // on session change (ChatSession rule).
  const [driveForId, setDriveForId] = useState(terminalId);
  const [drive, setDrive] = useState(false);
  if (terminalId && driveForId !== terminalId) {
    setDriveForId(terminalId);
    setDrive(false);
  }

  useEffect(() => {
    if (allSessions.length === 0) return;
    pruneSendModes(allSessions.map((s) => s.terminalId));
  }, [allSessions]);

  const terminalWrapperRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // Mobile chat kit, forward play: the grid re-fits its rows on every
  // size change, so it must not re-lay out while the keyboard moves. Show:
  // the column is held at its old height (keyboardColumnHeight); hide:
  // the column goes final and the grid's box is pinned at its old height.
  // The composer plays by transform; when the motion clears, the pin and
  // the transform go in one commit — the grid re-fits ONCE.
  const gridPin = useRef<{ flex: string; height: string } | null>(null);
  useKeyboardForwardPlay({
    motion: viewport.motion,
    movers: () => [
      columnRef.current?.querySelector<HTMLElement>(
        '[data-testid="terminal-composer-bar"], [data-testid="zen-terminal-direct-bar"]'
      ) ?? null,
    ],
    hold: {
      begin(m) {
        const w = terminalWrapperRef.current;
        if (!w || m.to <= m.from) return; // show: the column holds
        gridPin.current = { flex: w.style.flex, height: w.style.height };
        // The column grew by (to − from) in this commit; the grid had
        // that much less.
        const h = Math.max(0, w.getBoundingClientRect().height - (m.to - m.from));
        w.style.flex = "0 0 auto";
        w.style.height = `${h}px`;
      },
      end() {
        const w = terminalWrapperRef.current;
        const pin = gridPin.current;
        gridPin.current = null;
        if (!w || !pin) return;
        w.style.flex = pin.flex;
        w.style.height = pin.height;
      },
    },
  });
  // Reading the output closes the keyboard (a tap, not a scroll) — unless
  // the terminal takes typing directly (a tap there means "type here").
  useTapToDismiss({
    area: () => terminalWrapperRef.current,
    composer: () =>
      columnRef.current?.querySelector<HTMLElement>('[data-testid="terminal-composer-bar"]') ?? null,
    canDismiss: () => sendModeRef.current !== "direct",
  });
  const sendInputRef = useRef<((text: string) => void) | null>(null);
  const reloadRef = useRef<(() => void) | null>(null);
  const captureFocusRef = useRef<(() => void) | null>(null);
  const sendKeyRef = useRef<
    ((bytes: string, localEdit?: LiveLocalEdit) => void) | null
  >(null);
  const [reloading, setReloading] = useState(false);
  const [debugInfo, setDebugInfo] = useState("");

  useEffect(() => {
    const wrapper = terminalWrapperRef.current;
    if (!wrapper) return;
    const updateDebug = () => {
      setDebugInfo(`w=${wrapper.offsetHeight} h=${containerHeight.toFixed(0)}`);
    };
    requestAnimationFrame(updateDebug);
    const t = setTimeout(updateDebug, 500);
    return () => clearTimeout(t);
  }, [containerHeight]);

  // Tapping into the composer ("Message <Agent>") while watching claims Drive —
  // the same setDrive(true) as the pencil segment, so TerminalView's
  // claim/resize is identical. One-way: never flips back to Watch.
  // Only state changes; the composer stays mounted and focused, so the
  // iOS keyboard still opens and the column re-sizes as usual.
  const claimOnComposerFocus = () => {
    if (!drive) setDrive(true);
  };

  // Tapping the terminal itself while watching claims Drive the same
  // way (TerminalView only fires this for a plain tap — never a scroll
  // drag or long-press selection). Focus is called synchronously in
  // the same touchend so iOS raises the keyboard on this tap; in safe
  // send there is no direct input, so it only claims (as in Drive).
  const claimOnTerminalTap = () => {
    if (drive) return;
    setDrive(true);
    if (sendMode === "direct") captureFocusRef.current?.();
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || !terminalId || sendBusy) return;
    setSendError(null);
    setSendBusy(true);
    // Clear at once (no waiting out the tunnel round-trip); a failure
    // puts the text back, ahead of anything typed since.
    setInput("");
    void sendMessageToSession(termScope, terminalId, text)
      .catch((e: unknown) => ({
        ok: false as const,
        message: e instanceof Error ? e.message : String(e),
      }))
      .then((out) => {
        setSendBusy(false);
        if (out.ok) return;
        setSendError(out.message);
        setInput((cur) => (cur.trim() ? `${text}\n${cur}` : text));
      });
  };

  // `＋`: upload now, then put the returned path(s) in the draft the way
  // desktop's compose bar does, so the user sends them with the normal send.
  const handleAttach = (files: File[]) => {
    if (!files.length || uploading) return;
    if (!canAttach || !attachWorkspace || !attachDir) {
      setSendError("Files need this agent's workspace.");
      return;
    }
    const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (tooBig) {
      setSendError(`"${uploadFilename(tooBig)}" is too large (50 MB max)`);
      return;
    }
    setSendError(null);
    setUploading(true);
    void (async () => {
      const paths: string[] = [];
      try {
        for (const f of files) {
          const filename = uploadFilename(f);
          const r = await uploadFsBinary(
            termScope,
            attachWorkspace,
            attachDir,
            filename,
            await fileToBase64(f)
          );
          if (!r.ok || !r.data?.path) {
            setSendError(r.error || `Could not upload ${filename}`);
            break;
          }
          paths.push(r.data.path);
        }
      } finally {
        setUploading(false);
      }
      if (paths.length) setInput((prev) => attachPathsToDraft(prev, paths));
    })();
  };

  // The toggle swaps the message field for the direct-typing field. The
  // keyboard stays as it was: open moves focus to the new field in this
  // same tap (iOS keeps the keyboard up), closed stays closed.
  const switchMode = (mode: SendMode) => {
    if (!terminalId) return;
    const column = columnRef.current;
    const active = document.activeElement;
    const keyboardOpen =
      !!column && active instanceof HTMLElement && column.contains(active) && active.matches("textarea, input");
    flushSync(() => {
      setSendMode(modeKey, mode);
      setSendError(null);
    });
    if (!keyboardOpen) return;
    const next =
      mode === "direct"
        ? column?.querySelector<HTMLElement>('[data-k2="live-capture"]')
        : column?.querySelector<HTMLElement>('[data-testid="terminal-composer-bar"] textarea');
    next?.focus({ preventScroll: true });
  };

  const handleReload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      // Pinned main chat: force-respawn, then follow the new PTY id on
      // THIS page (keep the agent context in state).
      if (session?.isMainChat && workspacePath) {
        const r = await ensurePinnedChat(termScope, workspacePath, { forceRespawn: true });
        if (onActive) await useWorkspacesStore.getState().fetchAllSessions();
        if (r.ok && r.data?.sessionId && r.data.sessionId !== terminalId) {
          navigate(withServerParam(zenTerminalPath(r.data.sessionId), onActive ? null : termScope.id), {
            replace: true,
            state: agent ? { agent } : location.state,
          });
          return;
        }
      }
      reloadRef.current?.();
      await new Promise((res) => setTimeout(res, 800));
    } finally {
      setReloading(false);
    }
  };

  const backToThread = () => {
    // The session's own Thread (Done mode, drawer origin), even after a
    // reload dropped history.state; `?thread=` would re-read the agent
    // list and lose a drawer-built row ("Not chattable").
    // Back to THIS terminal's server (MA17): a room elsewhere carries it.
    const room = onActive ? null : termScope.id;
    const back = agent?.back ?? readZenReturn(terminalId);
    if (back) {
      navigate(withServerParam(zenAddrPath(back.addr), back.serverId ?? room), {
        state: { zenReturn: back },
      });
      return;
    }
    const id = agent?.agentId || readZenThread();
    const threadServer = agent?.agentId ? room : readZenThreadServer() ?? room;
    navigate(withServerParam(zenThreadPath(id), id ? threadServer : null));
  };

  // Android Back = Done: back to this session's Thread.
  useBackHandler(Boolean(terminalId), backToThread);

  if (!terminalId) return null;

  const subtitle = agent?.chatTitle ? `${agent.chatTitle} · Terminal` : "Terminal";

  return (
    // Fixed backdrop + visualViewport-sized column (ChatSession / Zen
    // thread keyboard idiom): the composer sits on the keyboard and an
    // iOS focus-pan can't drag the header under the notch.
    <div
      className="fixed inset-0 z-40 zen-font"
      data-testid="zen-terminal"
      style={{ background: "#000" }}
    >
      <div
        ref={columnRef}
        className="relative flex flex-col min-h-0"
        data-testid="zen-terminal-column"
        style={{ height: keyboardColumnHeight(viewport, fullViewportHeight()), overflow: "hidden" }}
      >
        {/* Glass header with the Zen thread's progressive blur. In flow,
            not over the grid: a terminal row under the header would be
            unreadable and TerminalView sizes rows to its box. */}
        <header
          className="relative w-full min-w-0 shrink-0"
          data-testid="zen-terminal-header"
          style={{ zIndex: 10, paddingTop: "env(safe-area-inset-top)" }}
        >
          <div className="zen-header-blur" data-testid="zen-terminal-header-blur" aria-hidden>
            <span className="zen-header-blur-1" />
            <span className="zen-header-blur-2" />
            <span className="zen-header-blur-3" />
            <span className="zen-header-blur-4" />
            <span className="zen-header-tint" />
          </div>
          <div
            className="relative flex items-center w-full min-w-0 px-3"
            data-testid="zen-terminal-header-row"
            style={{ height: ZEN_TERMINAL_HEADER_PX, columnGap: 8 }}
          >
            <button
              type="button"
              onClick={backToThread}
              data-testid="zen-terminal-done"
              className="text-[17px] shrink-0 zen-glass zen-glass-pill"
              style={{ height: PILL_PX, padding: "0 14px", color: "#fff" }}
            >
              Done
            </button>
            <span data-testid="zen-terminal-avatar" className="flex shrink-0">
              <WorkspaceAvatar
                initial={agent?.initial || headerName.slice(0, 1) || "?"}
                color={storeById ? storeById.color : agent?.color}
                iconUrl={storeById ? storeById.iconUrl : agent?.iconUrl}
                size={AVATAR_PX}
                fontSize={12}
                fallback="#2c2c2e"
              />
            </span>
            <div
              className="flex-1 min-w-0 flex flex-col zen-header-text"
              data-testid="zen-terminal-titles"
            >
              <span
                data-testid="zen-terminal-title"
                className="block w-full text-[15px] font-semibold truncate leading-tight"
                style={{ color: "#fff" }}
              >
                {headerName}
              </span>
              <span
                data-testid="zen-terminal-subtitle"
                className="block w-full text-[12px] truncate leading-tight"
                style={{ color: "#8e8e93" }}
              >
                {subtitle}
              </span>
              <ServerChip serverId={termScope.id} testId="zen-terminal-server" align="left" />
            </div>
            <span className="flex items-center shrink-0" style={{ gap: 6 }}>
              <div
                data-k2="watch-drive"
                className="zen-seg flex items-center shrink-0 zen-glass zen-glass-pill overflow-hidden"
                style={{ position: "relative", height: SEG_H, padding: SEG_PAD, overflow: "hidden" }}
                role="group"
                aria-label="Viewer or claimer"
              >
                <span
                  data-k2="watch-drive-thumb"
                  className="zen-seg-thumb"
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: SEG_PAD,
                    bottom: SEG_PAD,
                    left: SEG_PAD,
                    width: `calc(50% - ${SEG_PAD}px)`,
                    borderRadius: SEG_THUMB_R,
                    transform: drive ? "translateX(100%)" : "translateX(0%)",
                  }}
                />
                <button
                  data-k2="watch-btn"
                  type="button"
                  aria-pressed={!drive}
                  aria-label="Viewer — watch only"
                  title="Viewer — watch only"
                  onClick={() => setDrive(false)}
                  className="zen-seg-btn flex items-center justify-center"
                  data-selected={!drive || undefined}
                  style={SEG_BTN}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                <button
                  data-k2="drive-btn"
                  type="button"
                  aria-pressed={drive}
                  aria-label="Claimer — type and resize"
                  title="Claimer — type and resize"
                  onClick={() => setDrive(true)}
                  className="zen-seg-btn flex items-center justify-center"
                  data-selected={drive || undefined}
                  style={SEG_BTN}
                >
                  <PencilIcon size={15} strokeWidth={1.75} />
                </button>
              </div>
              <button
                data-k2="mode-toggle"
                type="button"
                // A tap here must not blur the open field first (iOS drops
                // the keyboard); switchMode moves focus itself.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => switchMode(sendMode === "safe" ? "direct" : "safe")}
                aria-label={
                  sendMode === "safe" ? "Switch to direct typing" : "Switch to safe send"
                }
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
                style={PILL}
              >
                {sendMode === "direct" ? (
                  <span aria-hidden="true" className="text-[12px] font-semibold leading-none">
                    &gt;_
                  </span>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="6" width="20" height="12" rx="2" />
                    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={handleReload}
                disabled={reloading}
                aria-label="Reload session"
                className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill disabled:opacity-60"
                style={PILL}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={reloading ? "animate-spin" : ""} aria-hidden>
                  <path d="M21 2v6h-6" />
                  <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                  <path d="M3 22v-6h6" />
                  <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                </svg>
              </button>
            </span>
          </div>
        </header>

        {DEV_MODE && (
          <div style={{ flexShrink: 0, color: "#8e8e93", fontSize: 9, padding: "2px 8px", opacity: 0.7 }}>
            h={containerHeight.toFixed(0)} | vv={window.visualViewport?.height?.toFixed(0)} | {debugInfo}
          </div>
        )}

        <div
          ref={terminalWrapperRef}
          style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}
          onClick={() => {
            if (sendMode === "direct") captureFocusRef.current?.();
          }}
        >
          <TerminalView
            scope={termScope}
            terminalId={terminalId}
            projectPath={projectPath}
            onInputRef={sendInputRef}
            onReloadRef={reloadRef}
            drive={drive}
            onTapWhileViewing={claimOnTerminalTap}
          />
        </div>

        {sendMode === "direct" ? (
          <div
            className="px-3 pt-2 zen-composer-bar"
            data-testid="zen-terminal-direct-bar"
            style={{ flexShrink: 0 }}
          >
            <AccessoryBar
              variant="zen"
              onKey={(bytes, localEdit) => {
                if (sendKeyRef.current) sendKeyRef.current(bytes, localEdit);
                else sendInputRef.current?.(bytes);
              }}
            />
            <LiveInputCapture
              send={(bytes) => sendInputRef.current?.(bytes)}
              focusRef={captureFocusRef}
              sendKeyRef={sendKeyRef}
            />
          </div>
        ) : (
          <MessageComposer
            variant="zen"
            testIdPrefix="terminal-composer"
            value={input}
            onChange={setInput}
            onSend={handleSend}
            busy={sendBusy || uploading}
            onAttach={canAttach ? handleAttach : undefined}
            onAttachError={setSendError}
            attachDisabled={uploading || sendBusy}
            placeholder={composerPlaceholder({
              name: agentName,
              addr: agent?.addr ?? storeById?.addr,
              sidecar: agent?.chatTitle,
            })}
            onFocus={claimOnComposerFocus}
            accessory={
              uploading ? (
                <p
                  className="text-[11px] text-[var(--text-muted)] leading-snug mb-1.5"
                  data-testid="terminal-composer-label"
                >
                  Uploading…
                </p>
              ) : sendError ? (
                <div className="flex items-start gap-2 pb-2">
                  <span className="flex-1 text-[var(--warning)] text-[11px] leading-snug">
                    {sendError}
                  </span>
                  <button
                    onClick={() => setSendError(null)}
                    aria-label="Dismiss send error"
                    className="text-[var(--text-muted)] text-[11px] px-1 shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
