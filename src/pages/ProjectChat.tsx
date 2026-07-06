// Slice C2 — the project chat: ONE message stream with the group's
// Point of Contact (PRD §2), the mobile port of the desktop's
// ProjectChatPanel semantics:
//
//   - Opens on the recent tail (GET messages, default 20); "Show
//     earlier" widens the tail window (`limit` stepping — the route has
//     no `before` param) up to the daemon's 500 cap, preserving scroll.
//   - Live: `project-group:message-created` bumps the store revision
//     (events WS in stores/projectGroups.ts); this screen coalesce-
//     refetches on a trailing 300ms window. DRAFT PROTECTION: the
//     composer draft is screen-local state; refetches only replace
//     `messages`.
//   - Composer posts as the human owner (`author` omitted); mobile
//     sends with the Send button (no ⌘⏎ — that's a desktop-ism). The
//     msg response's delivery outcome renders the receipt line under
//     the sent bubble ("delivered to <PoC>" / "stored — no Point of
//     Contact yet" / "PoC session unreachable").
//   - Bubbles: owner right in accent, agents left, author label +
//     relative time (the mockup Chat layout).
//
// Rendered as a FULL-SCREEN OVERLAY (fixed, above ServerFooter/TabBar)
// — the /chat/:id chrome-hiding behavior without editing the shared nav
// components — sized by the ChatSession keyboard-height idiom.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchProjectGroupMessages,
  fetchProjectGroupShow,
  postProjectGroupMessage,
  type ProjectGroupMessage,
  type ProjectGroupShow,
} from "../api/projectGroups";
import { useProjectGroupsStore, startEvents } from "../stores/projectGroups";
import { MessageComposer } from "../components/MessageComposer";
import { useServersStore } from "../stores/servers";
import { useViewportHeight } from "../lib/useViewportHeight";
import { useBottomAnchor } from "../lib/useBottomAnchor";
import { useSwipeBack } from "../lib/useSwipeBack";
import {
  MESSAGES_DEFAULT_LIMIT,
  canLoadEarlier,
  composerPlaceholder,
  deliveredLine,
  formatRelativeTime,
  mergeMessages,
  nextEarlierLimit,
  pocLabel,
} from "../lib/projectChat";

/** The most recent post's delivery outcome, rendered under its bubble. */
interface LastPost {
  messageId: string;
  delivered: boolean;
  deliveryReason: string | null;
}

export function ProjectChat() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const activeServerId = useServersStore((s) => s.activeServerId);
  const revision = useProjectGroupsStore((s) => s.revision);
  const containerHeight = useViewportHeight();

  const [show, setShow] = useState<ProjectGroupShow | null>(null);
  const [showError, setShowError] = useState<string | null>(null);

  // null = never fetched (loading state).
  const [messages, setMessages] = useState<ProjectGroupMessage[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [limit, setLimit] = useState(MESSAGES_DEFAULT_LIMIT);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  // Composer — deliberately screen-local so live refetches can never
  // eat a mid-typed draft.
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastPost, setLastPost] = useState<LastPost | null>(null);

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Bottom anchoring: re-pin the list through keyboard open/close
  // resizes (containerHeight changes) + composer focus, but only while
  // the user is at the tail — history reading is never yanked.
  const { onScroll, scrollToBottom } = useBottomAnchor(scrollRef, containerHeight);
  // Left-edge swipe-back = the header back button (to the projects list).
  const swipeRef = useSwipeBack(() => navigate("/projects"));
  const limitRef = useRef(limit);
  limitRef.current = limit;

  // Mark this group OPEN in the store: live message events mark-seen
  // (instead of dotting) + this screen refetches on the revision bump.
  useEffect(() => {
    if (!groupId) return;
    useProjectGroupsStore.getState().setOpenGroup(groupId);
    const stop = startEvents();
    return () => {
      stop();
      const s = useProjectGroupsStore.getState();
      if (s.openGroupId === groupId) s.setOpenGroup(null);
    };
  }, [groupId, activeServerId]);

  // Group identity (name, members, PoC) for the header + receipt line.
  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    void fetchProjectGroupShow(groupId).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data) {
        setShow(r.data);
        setShowError(null);
      } else {
        setShowError(r.error ?? "Failed to load project");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [groupId, activeServerId, revision]);

  const load = useCallback(
    async (lim: number): Promise<void> => {
      if (!groupId) return;
      const r = await fetchProjectGroupMessages(groupId, { limit: lim });
      if (r.ok && r.data) {
        const page = r.data;
        // Merge, don't replace: earlier-loaded history survives a live
        // refetch whose window is smaller than what's on screen.
        setMessages((prev) => mergeMessages(prev ?? [], page.messages));
        setTruncated(page.truncated);
        setLoadError(null);
      } else {
        setLoadError(r.error ?? "Failed to load chat");
      }
    },
    [groupId]
  );

  // Mount → fetch the recent tail.
  useEffect(() => {
    if (messages === null) void load(limitRef.current);
  }, [messages, load]);

  // Event-driven refresh: any project-group event bumps the store
  // revision; refetch on a trailing 300ms window — each bump resets the
  // timer via the cleanup, so a burst fires ONE fetch. Only `messages`
  // is replaced; the draft lives in its own state and survives.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    const timer = setTimeout(() => {
      void load(limitRef.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [revision, load]);

  // Keep the newest message in view when the TAIL grows — but not when
  // history is prepended (loadEarlier preserves its own scroll anchor).
  const lastId = messages && messages.length > 0 ? messages[messages.length - 1].id : null;
  const prevLastId = useRef<string | null>(null);
  useEffect(() => {
    if (lastId === null || lastId === prevLastId.current) return;
    prevLastId.current = lastId;
    scrollToBottom();
  }, [lastId, scrollToBottom]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (loadingEarlier) return;
    const next = nextEarlierLimit(limitRef.current);
    setLimit(next);
    setLoadingEarlier(true);
    // Anchor the viewport: prepended history must not yank the scroll.
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      await load(next);
      requestAnimationFrame(() => {
        const anchored = scrollRef.current;
        if (anchored) anchored.scrollTop = prevTop + (anchored.scrollHeight - prevHeight);
      });
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadingEarlier, load]);

  const send = useCallback((): void => {
    const text = draft.trim();
    if (!text || busy || !groupId) return;
    setBusy(true);
    setSendError(null);
    void postProjectGroupMessage(groupId, text).then((r) => {
      setBusy(false);
      if (!r.ok || !r.data) {
        setSendError(r.error ?? "Failed to send");
        return;
      }
      const posted = r.data;
      setDraft("");
      setLastPost({
        messageId: posted.id,
        delivered: posted.delivered,
        deliveryReason: posted.deliveryReason,
      });
      // Show the sent message (with its receipt line) immediately —
      // the event-driven refetch confirms it moments later.
      setMessages((prev) =>
        mergeMessages(prev ?? [], [
          {
            id: posted.id,
            groupId: posted.groupId,
            author: posted.author,
            body: posted.body,
            createdAt: posted.createdAt,
          },
        ])
      );
      useProjectGroupsStore.getState().markGroupSeen(groupId);
    });
  }, [draft, busy, groupId]);

  if (!groupId) return null;

  const poc = show ? pocLabel(show.members, show.pocWorkspaceId) : null;
  const showEarlier = canLoadEarlier(limit, truncated);
  const atCeiling = truncated && !showEarlier;
  const groupName =
    show?.name ??
    useProjectGroupsStore.getState().groups?.find((g) => g.id === groupId)?.name ??
    "Project";

  return (
    // Backdrop covers the whole viewport (incl. the ServerFooter/TabBar
    // strip below a keyboard-shortened inner column). It's also the
    // swipe-back transform target (the drag translates it).
    <div ref={swipeRef} className="fixed inset-0 z-40 bg-[var(--background)]">
    <div
      className="flex flex-col"
      style={{
        height: containerHeight,
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      {/* Header: back · name/PoC · dashboards */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <button
          onClick={() => navigate("/projects")}
          aria-label="Back to projects"
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0 -ml-2"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 1L3 7l6 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[var(--text)] text-[13px] font-semibold truncate">
            {groupName}
          </div>
          {poc && (
            <div className="text-[var(--text-muted)] text-[10px] truncate">PoC: {poc}</div>
          )}
        </div>
        {/* Top-right: the HTML dashboards browser */}
        <button
          onClick={() => navigate(`/projects/${groupId}/docs`)}
          aria-label="Dashboards"
          className="w-10 h-10 border border-[var(--accent-dim)] text-[var(--accent)] flex items-center justify-center shrink-0"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="1" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
        </button>
      </div>

      {/* The stream, oldest-first */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {loadError || showError ? (
          <div className="text-[var(--error)] text-[12px]">
            {loadError ?? showError}
          </div>
        ) : messages === null ? (
          <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-[12px]">
            Loading chat…
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-center px-6">
            <p className="text-[var(--text-muted)] text-[11px] leading-5">
              No messages yet — everything posted here also lands in the PoC&rsquo;s
              session.
            </p>
          </div>
        ) : (
          <>
            {showEarlier && (
              <div className="flex justify-center mb-3">
                <button
                  disabled={loadingEarlier}
                  onClick={() => void loadEarlier()}
                  className="px-3 py-1.5 text-[11px] text-[var(--text-secondary)] border border-[var(--border)] bg-[var(--surface)] disabled:opacity-50"
                >
                  {loadingEarlier ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            )}
            {atCeiling && (
              <div className="mb-3 text-center text-[10px] text-[var(--text-muted)] opacity-70">
                Showing the latest 500 messages — earlier history isn&rsquo;t shown.
              </div>
            )}
            <div className="flex flex-col gap-2.5">
              {messages.map((m) => {
                const isOwner = m.author === "owner";
                const receipt =
                  lastPost?.messageId === m.id
                    ? deliveredLine(lastPost.delivered, lastPost.deliveryReason, poc)
                    : null;
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col max-w-[85%] ${isOwner ? "self-end items-end" : "self-start items-start"}`}
                  >
                    <div className="flex items-baseline gap-2 px-0.5">
                      <span
                        className={`text-[10px] font-semibold ${
                          isOwner ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                        }`}
                      >
                        {isOwner ? "You" : m.author}
                      </span>
                      <span className="text-[9px] text-[var(--text-muted)] tabular-nums">
                        {formatRelativeTime(m.createdAt, nowSec)}
                      </span>
                    </div>
                    <div
                      className={`mt-0.5 px-3 py-2 text-[12px] leading-5 whitespace-pre-wrap break-words border ${
                        isOwner
                          ? "bg-[var(--accent-dim)]/20 border-[var(--accent-dim)] text-[var(--text)]"
                          : "bg-[var(--surface)] border-[var(--border)] text-[var(--text)]"
                      }`}
                    >
                      {m.body}
                    </div>
                    {receipt && (
                      <div className="mt-0.5 px-0.5 text-[9px] text-[var(--text-muted)] opacity-80 italic">
                        {receipt}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Composer — the shared terminal-style composer (thumb-sized ↑
          sends; Return = newline). Draft stays screen-local so live
          refetches can't eat it; `send` posts as owner and drives the
          delivered-receipt line under the sent bubble. */}
      <MessageComposer
        lift
        value={draft}
        onChange={setDraft}
        onSend={send}
        busy={busy}
        placeholder={
          show ? composerPlaceholder(show.members, show.pocWorkspaceId) : "Message the PoC"
        }
        accessory={
          sendError ? (
            <div className="mb-1.5 text-[11px] text-[var(--error)]">{sendError}</div>
          ) : undefined
        }
      />
    </div>
    </div>
  );
}
