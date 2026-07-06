import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useServersStore } from "../stores/servers";
import { useFeedbackStore } from "../stores/feedback";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useBottomAnchor } from "../lib/useBottomAnchor";
import { MessageComposer } from "../components/MessageComposer";
import {
  commentFeedback,
  deliveredLine,
  optionsActionable,
  relativeAge,
  resolveFeedback,
} from "../api/feedback";
import { KindTag, PriorityTag, StatusTag } from "./Feedback";

// Feedback C3 — the thread screen (`/feedback/:id`): the ask (title +
// body) then the comment thread as chat bubbles (agent left, you right),
// with a full-width composer. Every reply is a plain comment — the daemon
// injects human comments into the asking session, and the FIRST human
// comment on a waiting question/approval IS the answer (no separate
// Answer button); the response's answered/delivered fields drive the
// receipt line. Resolve / Dismiss / Reopen ride the resolve route. The
// TabBar + server footer hide here like /chat/:id (their route guards).
//
// Live: the feedback store's /events subscription refetches this thread
// (coalesced 300ms) on commented/answered/status-changed for the open id.
// Only `openItem` is replaced — the composer draft below is local state,
// so mid-typed text survives every refetch.
//
// Rendered as a FULL-SCREEN OVERLAY sized by the ChatSession keyboard-
// height idiom (useViewportHeight — the ProjectChat structure): iOS
// WKWebView never shrinks the layout viewport when the keyboard opens
// (docs/ios-keyboard-layout.md), so a plain `h-full` column gets PANNED
// up and the header scrolls off. Anchoring the column `fixed` at the
// viewport top and giving it an explicit pixel height keeps the header
// fixed and floats the composer above the keyboard; only the comments
// list shrinks/scrolls.

export function FeedbackThread() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const activeServerId = useServersStore((s) => s.activeServerId);
  const item = useFeedbackStore((s) => s.openItem);
  const openError = useFeedbackStore((s) => s.openError);

  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Post-comment receipt ("answered" flash + the delivered line). */
  const [receipt, setReceipt] = useState<{ answered: boolean; line: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerHeight = useViewportHeight();
  // Bottom anchoring: re-pin the list through keyboard open/close
  // resizes (containerHeight changes) + composer focus, but only while
  // the user is at the tail — history reading is never yanked.
  const { onScroll, scrollToBottom } = useBottomAnchor(scrollRef, containerHeight);

  // Open (and re-open on deep-link/server switch); the store's events WS
  // needs to be live even when this screen is the entry point.
  useEffect(() => {
    useFeedbackStore.getState().ensureLive();
  }, [activeServerId]);
  useEffect(() => {
    if (id) void useFeedbackStore.getState().openThread(id);
    return () => useFeedbackStore.getState().closeThread();
  }, [id]);

  // Keep the newest message in view when the thread GROWS (first load +
  // new comments) — the ProjectChat tail-growth rule. No-op refetches
  // (live events, status changes) no longer re-pin a scrolled-up reader.
  const commentCount = item?.comments.length ?? 0;
  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (!item || commentCount === prevCount.current) return;
    prevCount.current = commentCount;
    scrollToBottom();
  }, [item, commentCount, scrollToBottom]);

  const submit = useCallback(
    async (op: () => Promise<void>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        await op();
        // Refresh the thread + list/badge instantly; the daemon events
        // arrive slightly later and coalesce into a no-op-ish refetch.
        await useFeedbackStore.getState().refetchOpen();
        void useFeedbackStore.getState().refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  const sendComment = (text: string): void => {
    const body = text.trim();
    if (!body || !item) return;
    void submit(async () => {
      const res = await commentFeedback(item.id, body);
      setReply("");
      setReceipt({
        answered: res.answered === true,
        line: deliveredLine(item.agentName, res.delivered, res.deliveryReason),
      });
    });
  };

  const setStatus = (status: "resolved" | "dismissed" | "waiting"): void => {
    if (!item) return;
    setReceipt(null);
    void submit(() => resolveFeedback(item.id, status));
  };

  const nowSec = Date.now() / 1000;
  const openItem = item && (item.status === "waiting" || item.status === "answered");

  return (
    // Backdrop covers the whole viewport (incl. the strip below a
    // keyboard-shortened inner column) — the ProjectChat overlay idiom.
    <div className="fixed inset-0 z-40 bg-[var(--background)]">
    <div
      className="flex flex-col"
      style={{
        height: containerHeight,
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      {/* Header: back + title + status (ChatSession header idiom). */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <button
          onClick={() => navigate("/feedback")}
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 -ml-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-[var(--text)] text-[13px] font-medium truncate">
            {item?.title ?? "Feedback"}
          </span>
          {item && (
            <span className="text-[var(--text-muted)] text-[10px] truncate">
              {item.workspace ? `${item.workspace} · ` : ""}
              {item.agentName} · asked {relativeAge(item.createdAt, nowSec)} ago
            </span>
          )}
        </div>
        {item && (
          <div className="flex items-center gap-1.5 shrink-0">
            <PriorityTag priority={item.priority} />
            <KindTag kind={item.kind} />
            <StatusTag status={item.status} />
          </div>
        )}
      </div>

      {openError ? (
        <div className="flex-1 flex flex-col items-center justify-center px-8 gap-3">
          <p className="text-[var(--error)] text-[11px] text-center leading-5">
            Failed to load item: {openError}
          </p>
          <button
            onClick={() => id && void useFeedbackStore.getState().openThread(id)}
            className="px-4 py-2 border border-[var(--accent-dim)] text-[var(--accent)] text-[11px]"
          >
            Retry
          </button>
        </div>
      ) : !item ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-[11px]">
          Loading thread…
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {/* The ask body (title is in the header; body adds context). */}
            {item.body && (
              <div className="mb-3 px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap break-words leading-5">
                {item.body}
              </div>
            )}

            {/* Structured options — one-tap replies while waiting; the
                accepted choice stays highlighted after. */}
            {item.options && item.options.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {item.options.map((opt) => {
                  const accepted = item.answer === opt;
                  const tappable = optionsActionable(item) && !busy;
                  return (
                    <button
                      key={opt}
                      disabled={!tappable}
                      onClick={() => sendComment(opt)}
                      className={`px-3 py-2 text-[11px] border transition-colors ${
                        accepted
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]/20"
                          : tappable
                            ? "border-[var(--border-hover)] text-[var(--text-secondary)]"
                            : "border-[var(--border)] text-[var(--text-muted)] opacity-50"
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Thread — agent bubbles left, yours right. The first
                comment is the ask itself, seeded in the agent's voice. */}
            <div className="flex flex-col gap-2">
              {item.comments.map((c, i) => {
                const own = c.author === "owner";
                return (
                  <div key={`${c.at}-${i}`} className={`flex ${own ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] px-3 py-2 border ${
                        own
                          ? "bg-[var(--accent-dim)]/20 border-[var(--accent-dim)]"
                          : "bg-[var(--surface)] border-[var(--border)]"
                      }`}
                    >
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className={`text-[9px] font-semibold ${own ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"}`}>
                          {own ? "You" : c.author}
                        </span>
                        <span className="text-[9px] text-[var(--text-muted)] tabular-nums">
                          {relativeAge(c.at, nowSec)}
                        </span>
                      </div>
                      <div className="text-[12px] text-[var(--text)] whitespace-pre-wrap break-words leading-5">
                        {c.body}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Composer — the shared terminal-style composer (thumb-sized
              ↑ sends). Receipts + Resolve/Dismiss/Reopen ride the
              accessory rows above the input; every send is still a plain
              comment (the first human comment on a waiting ask IS the
              answer — sendComment is unchanged). */}
          <MessageComposer
            value={reply}
            onChange={setReply}
            onSend={() => sendComment(reply)}
            busy={busy}
            placeholder={`Message ${item.agentName}`}
            accessory={
              <>
                {actionError && (
                  <div className="mb-2 text-[var(--error)] text-[10px]">{actionError}</div>
                )}
                {receipt && (
                  <div className="mb-2 text-[10px]">
                    {receipt.answered && (
                      <span className="text-[var(--success)] mr-2">✓ answered</span>
                    )}
                    <span className={receipt.line.startsWith("sent") ? "text-[var(--text-muted)]" : "text-[var(--warning)]"}>
                      {receipt.line}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2 mb-2">
                  {openItem ? (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => setStatus("resolved")}
                        className="px-3 py-2 text-[11px] text-[var(--text-secondary)] border border-[var(--border)] disabled:opacity-50"
                      >
                        Resolve
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setStatus("dismissed")}
                        className="px-3 py-2 text-[11px] text-[var(--text-muted)] border border-[var(--border)] disabled:opacity-50"
                      >
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => setStatus("waiting")}
                      className="px-3 py-2 text-[11px] text-[var(--text-secondary)] border border-[var(--border)] disabled:opacity-50"
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </>
            }
          />
        </>
      )}
    </div>
    </div>
  );
}
