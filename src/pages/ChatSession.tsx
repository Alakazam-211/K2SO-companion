import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useWorkspacesStore } from "../stores/workspaces";
import { TerminalView } from "../components/TerminalView";
import { ensurePinnedChat } from "../api/client";
import { SessionTitle } from "../components/SessionTitle";
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

const DEV_MODE: boolean = import.meta.env?.DEV ?? false;

export function ChatSession() {
  const { terminalId } = useParams<{ terminalId: string }>();
  const navigate = useNavigate();
  const projects = useWorkspacesStore((s) => s.projects);
  const session = useWorkspacesStore((s) =>
    s.allSessions.find((sess) => sess.terminalId === terminalId)
  );
  const projectPath = session?.cwd || "";
  // Workspace root for ensure-pinned-chat (prefer the registered project
  // path; fall back to the session's cwd).
  const workspacePath =
    (session && projects.find((p) => p.id === session.workspaceId)?.path) ||
    projectPath;
  const allSessions = useWorkspacesStore((s) => s.allSessions);
  const [input, setInput] = useState("");
  // Keyboard-height column sizing — the shared ProjectChat/FeedbackThread
  // idiom (useViewportHeight): the hook pins `window.scrollTo(0, 0)` on
  // every viewport update, so iOS can't leave the page panned after the
  // focus animation (the old bespoke handler here missed that reset on
  // the k2-viewport-resize path and the header clipped under the notch).
  const containerHeight = useViewportHeight();

  // T3 — Safe send (default) | Direct type, per-terminal + session-local
  // (sendMode.ts store; nothing persisted across launches).
  // (3rd arg = server snapshot so the page also renders under
  // renderToString — the headless smoke harness.)
  const directHandles = useSyncExternalStore(
    subscribeSendModes,
    getDirectHandles,
    getDirectHandles
  );
  const sendMode: SendMode = terminalId ? modeFor(directHandles, terminalId) : "safe";
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Watch (default) is a size policy, not a messaging gate. Composer
  // stays on Safe send → terminal.write. Do not hide it for viewer.
  // Drive is an explicit header tap — never auto-claimed. Reset on
  // session change so a new open is always Watch.
  const [driveForId, setDriveForId] = useState(terminalId);
  const [drive, setDrive] = useState(false);
  if (terminalId && driveForId !== terminalId) {
    setDriveForId(terminalId);
    setDrive(false);
  }

  // Prune send-mode handles for terminals that no longer exist (skip
  // the pre-fetch empty list — it would GC live handles, not dead ones).
  useEffect(() => {
    if (allSessions.length === 0) return;
    pruneSendModes(allSessions.map((s) => s.terminalId));
  }, [allSessions]);

  const terminalWrapperRef = useRef<HTMLDivElement>(null);
  const sendInputRef = useRef<((text: string) => void) | null>(null);
  const reloadRef = useRef<(() => void) | null>(null);
  // T4 Direct mode — the hidden capture populates these: focus() (the
  // tap-the-terminal → keyboard-up path) and the pipeline's control-
  // byte entry (accessory chords flush pending IME text first).
  const captureFocusRef = useRef<(() => void) | null>(null);
  const sendKeyRef = useRef<
    ((bytes: string, localEdit?: LiveLocalEdit) => void) | null
  >(null);
  const [reloading, setReloading] = useState(false);
  const [debugInfo, setDebugInfo] = useState("");

  // Manual touch-scroll: WKWebView with scrollEnabled=false sometimes blocks
  // CSS overflow:auto scrolling. We handle it manually via touchmove.
  // Fullscreen-TUI sessions (mouse-reporting mode) never reach this
  // handler: TerminalView's T5a touch effect converts those drags to
  // SGR wheel events and stopPropagation()s before this wrapper sees
  // them (there's no scrollback to scrollTop through on the alt screen).
  useEffect(() => {
    const wrapper = terminalWrapperRef.current;
    if (!wrapper) return;

    let startY = 0;
    let scrollEl: HTMLElement | null = null;

    const findScrollEl = () => {
      if (!scrollEl) {
        // Find the TerminalView's scroll container (overflow: auto), not the wrapper (overflow: hidden)
        const candidates = wrapper.querySelectorAll('div');
        for (const el of candidates) {
          if (el.style.overflow === 'auto' && el.scrollHeight > el.clientHeight) {
            scrollEl = el;
            break;
          }
        }
        // Fallback: first element with overflow auto
        if (!scrollEl) {
          for (const el of candidates) {
            if (el.style.overflow === 'auto') {
              scrollEl = el;
              break;
            }
          }
        }
      }
      return scrollEl;
    };

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      findScrollEl();
    };

    const onTouchMove = (e: TouchEvent) => {
      const el = findScrollEl();
      if (!el) return;
      const deltaY = startY - e.touches[0].clientY;
      startY = e.touches[0].clientY;
      el.scrollTop += deltaY;
      // Dispatch scroll event so TerminalView's auto-scroll logic updates
      el.dispatchEvent(new Event('scroll'));
      e.preventDefault();
    };

    wrapper.addEventListener("touchstart", onTouchStart, { passive: true });
    wrapper.addEventListener("touchmove", onTouchMove, { passive: false });

    const updateDebug = () => {
      const el = findScrollEl();
      setDebugInfo(`w=${wrapper.offsetHeight} s=${el?.clientHeight ?? -1}/${el?.scrollHeight ?? -1} top=${el?.scrollTop?.toFixed(0) ?? -1}`);
    };
    requestAnimationFrame(updateDebug);
    const t = setTimeout(updateDebug, 500);

    return () => {
      clearTimeout(t);
      wrapper.removeEventListener("touchstart", onTouchStart);
      wrapper.removeEventListener("touchmove", onTouchMove);
      scrollEl = null;
    };
  }, [containerHeight]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !terminalId || sendBusy) return;
    setSendError(null);

    // Safe send only — in Direct mode the composer UNMOUNTS entirely
    // (T4): keystrokes stream live through LiveInputCapture instead.
    // POST the whole message through the daemon's
    // injector (per-session lock + ESC-sanitize + bracketed-paste framing
    // + deterministic submit). NO trailing \r: the injector owns submit.
    // The draft only clears on a confirmed delivery; failures surface
    // reason/hint in the accessory row and keep the text.
    setSendBusy(true);
    void sendMessageToSession(terminalId, text).then((out) => {
      setSendBusy(false);
      if (out.ok) setInput("");
      else setSendError(out.message);
    });
  };

  const switchMode = (mode: SendMode) => {
    if (!terminalId) return;
    setSendMode(terminalId, mode);
    setSendError(null);
  };

  const handleReload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      // On the pinned MAIN CHAT tab, "reload" restores the SELECTED session
      // (same as the desktop refresh): force-respawn so the daemon KILLS the
      // possibly-wrong live PTY and re-resolves — a plain ensure would just
      // hand back the already-live (fresh) session, which is why reload
      // couldn't restore the right session before.
      if (session?.isMainChat && workspacePath) {
        const r = await ensurePinnedChat(workspacePath, { forceRespawn: true });
        await useWorkspacesStore.getState().fetchAllSessions();
        if (r.ok && r.data?.sessionId && r.data.sessionId !== terminalId) {
          navigate(`/chat/${r.data.sessionId}`, { replace: true });
          return; // remounts on the restored session
        }
      }
      // Regular terminal, or a pinned chat whose PTY id didn't change:
      // reconnect the stream. Hold the spinner briefly so the tap registers.
      reloadRef.current?.();
      await new Promise((res) => setTimeout(res, 800));
    } finally {
      setReloading(false);
    }
  };

  if (!terminalId) return null;

  return (
    // Backdrop covers the whole viewport (the ProjectChat overlay
    // structure): `fixed` anchors to the layout viewport, so an iOS
    // focus-pan of #root/document can't drag the header out from under
    // the notch — the inner column re-adds the top safe-area (a fixed
    // child doesn't inherit #root's safe-area padding).
    <div className="fixed inset-0 z-40 bg-[var(--background)]">
    <div
      className="flex flex-col"
      style={{
        height: containerHeight,
        paddingTop: "env(safe-area-inset-top)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)]" style={{ flexShrink: 0 }}>
        <button onClick={() => navigate("/sessions")} className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 -ml-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 1L3 7l6 6" /></svg>
        </button>
        <div className="flex-1 min-w-0">
          {session ? (
            <SessionTitle session={session} />
          ) : (
            <span className="text-[var(--text)] text-[13px] font-semibold">Terminal</span>
          )}
        </div>
        {/* Watch/Drive: size policy only. Default Watch. Drive is an
            explicit tap — never auto. Composer stays terminal.write. */}
        <div
          data-k2="watch-drive"
          className="flex h-8 border border-[var(--accent-dim)] shrink-0"
          role="group"
          aria-label="Watch or Drive"
        >
          <button
            data-k2="watch-btn"
            type="button"
            aria-pressed={!drive}
            onClick={() => setDrive(false)}
            className={`px-2 text-[11px] font-semibold ${
              !drive
                ? "bg-[var(--accent)] text-black"
                : "text-[var(--accent)]"
            }`}
          >
            Watch
          </button>
          <button
            data-k2="drive-btn"
            type="button"
            aria-pressed={drive}
            onClick={() => setDrive(true)}
            className={`px-2 text-[11px] font-semibold ${
              drive
                ? "bg-[var(--accent)] text-black"
                : "text-[var(--accent)]"
            }`}
          >
            Drive
          </button>
        </div>
        {/* Send-mode toggle — glyph is the current mode (bubble = Safe,
            >_ = Direct). Never auto-focuses the capture (Orca rule). */}
        <button
          data-k2="mode-toggle"
          onClick={() =>
            switchMode(sendMode === "safe" ? "direct" : "safe")
          }
          aria-label={
            sendMode === "safe"
              ? "Switch to direct typing"
              : "Switch to safe send"
          }
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0"
        >
          {sendMode === "direct" ? (
            // Terminal prompt — Direct type is active.
            <span
              aria-hidden="true"
              className="text-[13px] font-semibold leading-none"
            >
              &gt;_
            </span>
          ) : (
            // Chat bubble — Safe send is active.
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </button>
        <button
          onClick={handleReload}
          disabled={reloading}
          aria-label="Reload session"
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 disabled:opacity-60"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={reloading ? "animate-spin" : ""}>
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
        </button>
        <div className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
      </div>

      {DEV_MODE && (
        <div style={{ flexShrink: 0, color: "#22d3ee", fontSize: 9, padding: "2px 8px", opacity: 0.7 }}>
          h={containerHeight.toFixed(0)} | vv={window.visualViewport?.height?.toFixed(0)} | {debugInfo}
        </div>
      )}

      {/* Terminal — only scrollable area. In Direct mode a TAP focuses
          the hidden capture (keyboard up, keystrokes live); click never
          fires after a scroll/drag gesture, so T5a's TUI wheel drags and
          the scrollback shim stay untouched. Never auto-focused on mode
          switch (Orca rule). */}
      <div
        ref={terminalWrapperRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}
        onClick={() => {
          if (sendMode === "direct") captureFocusRef.current?.();
        }}
      >
        <TerminalView terminalId={terminalId} projectPath={projectPath} onInputRef={sendInputRef} onReloadRef={reloadRef} drive={drive} />
      </div>

      {/* Input bar: Watch keeps Safe send (textarea → terminal.write).
          Drive claims PTY size only — composer still uses terminal.write,
          not grid `{action:"input"}` for text. */}
      {sendMode === "direct" ? (
        <div
          className="px-4 pt-3 border-t border-[var(--border)] bg-[var(--surface)] input-bar input-bar-lift"
          style={{ flexShrink: 0 }}
        >
          <AccessoryBar
            onKey={(bytes, localEdit) => {
              // Through the capture pipeline (pending IME text flushes
              // before the chord); raw seam as a fallback if the
              // capture hasn't mounted its ref yet.
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
          lift
          value={input}
          onChange={setInput}
          onSend={handleSend}
          busy={sendBusy}
          placeholder="Message the agent…  (↑ to send)"
          accessory={
            sendError ? (
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
