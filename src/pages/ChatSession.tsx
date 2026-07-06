import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWorkspacesStore } from "../stores/workspaces";
import { TerminalView } from "../components/TerminalView";
import { ensurePinnedChat } from "../api/client";
import { SessionTitle } from "../components/SessionTitle";
import { MessageComposer } from "../components/MessageComposer";
import { AccessoryBar } from "../components/AccessoryBar";
import { LiveInputCapture } from "../components/LiveInputCapture";
import { sendMessageToSession } from "../api/sendMessage";
import type { LiveLocalEdit } from "../lib/liveInputText";
import { useTerminalMetaStore } from "../stores/terminalMeta";
import {
  modeFor,
  setSendMode,
  getDirectHandles,
  subscribeSendModes,
  pruneSendModes,
  getSessionRoles,
  subscribeSessionRoles,
  setSessionRole,
  pruneSessionRoles,
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
  const [containerHeight, setContainerHeight] = useState(window.innerHeight);

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

  // Daemon-judged role for this grid connection (viewer = read-only, the
  // composer hides entirely). The `mode` frame lands in the grid-WS
  // callback (T2's surface, TerminalView); until their store export
  // lands, the seam is the `k2-grid-mode` CustomEvent fed into the same
  // sendMode.ts registry — either producer works, this page only reads.
  const sessionRoles = useSyncExternalStore(
    subscribeSessionRoles,
    getSessionRoles,
    getSessionRoles
  );
  const isViewer = terminalId ? sessionRoles.get(terminalId) === "viewer" : false;

  useEffect(() => {
    const onMode = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { sessionId?: string; mode?: string }
        | undefined;
      if (d?.sessionId && (d.mode === "viewer" || d.mode === "claimer")) {
        setSessionRole(d.sessionId, d.mode);
      }
    };
    window.addEventListener("k2-grid-mode", onMode);
    return () => window.removeEventListener("k2-grid-mode", onMode);
  }, []);

  // T2's TerminalView writes the daemon-judged mode into terminalMeta —
  // bridge it into the sendMode role registry this page reads (the
  // CustomEvent seam above stays as a secondary producer; last write wins,
  // both carry the same daemon `mode` frame).
  useEffect(() => {
    if (!terminalId) return;
    return useTerminalMetaStore.subscribe((s) => {
      const mode = s.meta[terminalId]?.mode;
      if (mode === "viewer" || mode === "claimer") setSessionRole(terminalId, mode);
    });
  }, [terminalId]);

  // Prune mode/role handles for terminals that no longer exist (skip the
  // pre-fetch empty list — it would GC live handles, not dead ones).
  useEffect(() => {
    if (allSessions.length === 0) return;
    const liveIds = allSessions.map((s) => s.terminalId);
    pruneSendModes(liveIds);
    pruneSessionRoles(liveIds);
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

  // Listen for viewport resize from native JS injection + visualViewport
  useEffect(() => {
    const root = document.getElementById("root");
    const rootStyle = root ? getComputedStyle(root) : null;
    const safeAreaTop = parseInt(rootStyle?.paddingTop || '0', 10) || 0;
    const fullHeight = window.innerHeight;

    const update = () => {
      const vv = window.visualViewport;
      const vvHeight = vv ? vv.height : window.innerHeight;
      if (vvHeight < fullHeight - 100) {
        // Keyboard open — subtract top safe area only (keyboard covers bottom)
        setContainerHeight(vvHeight - safeAreaTop);
      } else {
        // Keyboard closed — need room for home indicator + input bar padding
        setContainerHeight(fullHeight - safeAreaTop - 34);
      }
      // Prevent iOS from scrolling the page during keyboard animation
      window.scrollTo(0, 0);
    };

    const onCustom = (e: Event) => {
      const h = (e as CustomEvent).detail?.height;
      if (h && h < fullHeight - 100) {
        setContainerHeight(h - safeAreaTop);
      } else {
        setContainerHeight(fullHeight - safeAreaTop - 34);
      }
    };

    // Set initial height accounting for safe area
    update();

    window.addEventListener("k2-viewport-resize", onCustom);
    window.visualViewport?.addEventListener("resize", update);

    // Poll during focus transitions
    const onFocusIn = () => { setTimeout(update, 100); setTimeout(update, 300); setTimeout(update, 500); };
    const onFocusOut = () => { setTimeout(update, 100); setTimeout(update, 300); };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      window.removeEventListener("k2-viewport-resize", onCustom);
      window.visualViewport?.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

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

  // The Safe send | Direct type segmented control — rendered in the
  // composer's header (Safe) and at the top of the live strip (Direct),
  // so the way back is always visible.
  const modeToggle = (
    <div className="flex mb-2" role="tablist" aria-label="Send mode">
      <button
        role="tab"
        aria-selected={sendMode === "safe"}
        onClick={() => switchMode("safe")}
        className={`h-8 px-3 text-[11px] border ${
          sendMode === "safe"
            ? "bg-[var(--accent)] text-[var(--background)] border-[var(--accent)] font-semibold"
            : "text-[var(--text-secondary)] border-[var(--accent-dim)]"
        }`}
      >
        Safe send
      </button>
      <button
        role="tab"
        aria-selected={sendMode === "direct"}
        onClick={() => switchMode("direct")}
        className={`h-8 px-3 text-[11px] border border-l-0 ${
          sendMode === "direct"
            ? "bg-[var(--warning)] text-[var(--background)] border-[var(--warning)] font-semibold"
            : "text-[var(--text-secondary)] border-[var(--accent-dim)]"
        }`}
      >
        Direct type
      </button>
      {sendMode === "direct" && (
        <span className="self-center pl-3 text-[10px] text-[var(--warning)]">
          keystrokes are live — tap the terminal to type
        </span>
      )}
    </div>
  );

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: containerHeight,
      overflow: "hidden",
    }}>
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
          if (sendMode === "direct" && !isViewer) captureFocusRef.current?.();
        }}
      >
        <TerminalView terminalId={terminalId} projectPath={projectPath} onInputRef={sendInputRef} onReloadRef={reloadRef} />
      </div>

      {/* Input bar slot — three states:
          viewer  → no input surface at all (the daemon gate is the
                    source of truth; this hide is the honest UX);
          Direct  → the composer UNMOUNTS entirely (T4): the amber
                    live strip carries the mode toggle + the Orca
                    accessory key bar + the hidden capture — keystrokes
                    stream to the PTY and the terminal's own cursor is
                    the caret;
          Safe    → today's composer (Return = newline, ↑ sends via the
                    daemon's safe injector). */}
      {isViewer ? (
        <div
          className="px-4 pt-3 border-t border-[var(--border)] bg-[var(--surface)] input-bar"
          style={{ flexShrink: 0 }}
        >
          <div className="text-[var(--text-muted)] text-[12px] pb-3">
            View-only — this session is shared with you without typing
            access.
          </div>
        </div>
      ) : sendMode === "direct" ? (
        <div
          className="px-4 pt-3 border-t input-bar"
          style={{
            flexShrink: 0,
            // The MessageComposer's warning tint, on the live strip:
            // every keystroke lands on a shared PTY — the bar must
            // FEEL hot.
            background: "rgba(245, 158, 11, 0.10)",
            borderTopColor: "var(--warning)",
          }}
        >
          {modeToggle}
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
          value={input}
          onChange={setInput}
          onSend={handleSend}
          busy={sendBusy}
          placeholder="Message the agent…  (↑ to send)"
          headerSlot={modeToggle}
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
  );
}
