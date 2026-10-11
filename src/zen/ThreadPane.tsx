import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { getThreadActivity, uploadFsBinary } from "../api/client";
import { ChatMessageBody } from "../components/ChatMessage";
import { asErrorText } from "../lib/apiError";
import {
  MAX_UPLOAD_BYTES,
  attachmentSendBody,
  fileToBase64,
  filesFromClipboard,
  uploadDirOf,
  uploadFilename,
  workspaceHandleOf,
} from "./composerAttach";
import { StubMark } from "./StubMark";
import { mountainTime, type ThreadMessage } from "./threadModel";
import {
  captureTopMessage,
  restoreTopMessage,
  stickToNewest,
  type MessageAnchor,
} from "./threadScroll";
import { connectOverlayEvents } from "./overlayEvents";
import {
  applyActivityCatchUp,
  applyActivityFrame,
  createCatchUpGate,
  isActivityFrame,
  isThreadFrame,
  type ThreadTurn,
} from "./threadTurn";
import { ThreadWorkingStrip } from "./ThreadWorkingStrip";
import { isSendableAddr } from "./sendGate";
import { sourceWord, useZenStore } from "./zenStore";

/** iMessage grows the field then caps (~5 lines) and scrolls inside. */
export const COMPOSER_MAX_PX = 132;

export function composerHeight(scrollHeight: number, maxPx = COMPOSER_MAX_PX): number {
  if (!Number.isFinite(scrollHeight) || scrollHeight < 24) return 24;
  return Math.min(scrollHeight, maxPx);
}

function Bubble({
  m,
  onFileLink,
  canAnswer,
  answering,
  answerError,
  onAnswer,
}: {
  m: ThreadMessage;
  onFileLink?: (ref: string) => void;
  canAnswer: boolean;
  answering: boolean;
  answerError: string | null;
  onAnswer: (option: string) => void;
}) {
  const secret = m.kind === "secret";
  const choice = secret ? null : m.choice;
  const answered =
    choice != null && choice.answer != null && String(choice.answer) !== "";
  return (
    <div
      className="px-3 py-2 text-[17px] leading-snug break-words min-w-0 max-w-full overflow-hidden"
      style={{
        borderRadius: 18,
        background: m.mine ? "#0a84ff" : "#3a3a3c",
        color: "#fff",
        opacity: m.pending ? 0.7 : 1,
      }}
    >
      {choice ? (
        <div>
          {choice.prompt ? (
            <ChatMessageBody
              text={choice.prompt}
              className="!p-0 text-white"
              style={{ color: "#fff" }}
              onFileLink={onFileLink}
            />
          ) : null}
          {choice.options.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {choice.options.map((o) => {
                const picked = answered && choice.answer === o;
                const tappable = canAnswer && !answered && !answering && Boolean(m.id);
                return (
                  <button
                    key={o}
                    type="button"
                    disabled={!tappable}
                    aria-pressed={picked}
                    onClick={() => onAnswer(o)}
                    className="rounded-full px-3 py-1.5 text-[15px] leading-none border"
                    style={{
                      borderColor: picked ? "#fff" : "rgba(255,255,255,0.4)",
                      background: picked ? "#fff" : "transparent",
                      color: picked ? "#1c1c1e" : "#fff",
                      opacity: tappable || picked ? 1 : 0.55,
                    }}
                  >
                    {o}
                  </button>
                );
              })}
            </div>
          ) : null}
          {answered ? (
            <p className="mt-1 text-[12px] opacity-80">Answered.</p>
          ) : answerError ? (
            <p className="mt-1 text-[12px] opacity-80" role="alert">
              {answerError}
            </p>
          ) : answering ? (
            <p className="mt-1 text-[12px] opacity-80">Sending…</p>
          ) : null}
        </div>
      ) : (
        <ChatMessageBody
          text={m.text}
          className="!p-0 text-white"
          style={{ color: "#fff" }}
          onFileLink={onFileLink}
        />
      )}
    </div>
  );
}

/**
 * Overlay thread pane. LOOK: iMessage in/out bubbles + Mountain Time.
 * BEHAVE: GET /cli/thread then WS /cli/overlay/events?conversation=.
 * Send is on for any live overlay addr. Never sends to a PTY.
 */
/** Gap between the floating header's bottom edge and the first message. */
const THREAD_TOP_GAP = 8;

/** Scroller top padding: clears the status bar plus a floating header. */
export function threadTopPadding(topInset?: number): string | undefined {
  if (topInset == null || !Number.isFinite(topInset) || topInset <= 0) return undefined;
  return `calc(env(safe-area-inset-top) + ${Math.ceil(topInset) + THREAD_TOP_GAP}px)`;
}

export function ThreadPane({
  viewportHeight,
  topInset,
}: {
  viewportHeight?: number;
  /** Height (px, below the safe area) of a header floating over the list. */
  topInset?: number;
} = {}) {
  const thread = useZenStore((s) => s.thread);
  const source = useZenStore((s) => s.threadSource);
  const error = useZenStore((s) => s.threadError);
  const agentId = useZenStore((s) => s.agentId);
  const hasMore = useZenStore((s) => s.threadHasMore);
  const loadingEarlier = useZenStore((s) => s.threadLoadingEarlier);
  const loadEarlier = useZenStore((s) => s.loadEarlier);
  const sendThread = useZenStore((s) => s.sendThread);
  const answerChoice = useZenStore((s) => s.answerChoice);
  const answeringId = useZenStore((s) => s.answeringId);
  const answerError = useZenStore((s) => s.answerError);
  const answerErrorId = useZenStore((s) => s.answerErrorId);
  const threadAddr = useZenStore((s) => s.threadAddr);
  const threadGroupId = useZenStore((s) => s.threadGroupId);
  const conversationId = useZenStore((s) => s.threadConversationId);
  const agents = useZenStore((s) => s.agents);
  const sending = useZenStore((s) => s.sending);
  const sendError = useZenStore((s) => s.sendError);
  const openFileFromPath = useZenStore((s) => s.openFileFromPath);
  const canSend =
    (source === "live" ||
      (source === "error" && isSendableAddr(threadAddr))) &&
    (Boolean((threadGroupId || "").trim()) || isSendableAddr(threadAddr));
  const attachWorkspace = workspaceHandleOf(threadAddr);
  const agent = agents.find((a) => a.id === agentId);
  const attachDir = uploadDirOf(agent?.path);
  const canAttach = canSend && Boolean(attachWorkspace) && Boolean(attachDir);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const sendReady =
    Boolean(draft.trim() || attachments.length) && !sending && !uploading;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<MessageAnchor | null>(null);
  const prevAgent = useRef<string>("");
  const prevFirst = useRef<number | null>(null);
  // Was the reader at the newest BEFORE the column resized? A pure
  // container resize fires no scroll event, so this holds the pre-resize
  // reading (the useBottomAnchor rule). Opens pinned to the tail.
  const atNewest = useRef(true);
  // The working strip's turn. The gate drops a catch-up answer that raced
  // an activity frame (the frame is newer) or a later catch-up (a late
  // `{turn:null}` must not clear a live strip).
  const [turn, setTurn] = useState<ThreadTurn | null>(null);
  const catchUps = useRef(createCatchUpGate());
  const addrRef = useRef(threadAddr);
  addrRef.current = threadAddr;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const first = thread[0]?.seq ?? null;
    const agentChanged = agentId !== prevAgent.current;
    const opened = agentChanged || prevFirst.current == null;
    if (pendingAnchor.current) {
      restoreTopMessage(el, pendingAnchor.current);
      pendingAnchor.current = null;
    } else if (opened) {
      stickToNewest(el);
    } else {
      const near =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (near) stickToNewest(el);
    }
    prevAgent.current = agentId;
    prevFirst.current = first;
  }, [thread, agentId, source]);

  useLayoutEffect(() => {
    setDraft("");
    setAttachments([]);
    setAttachError(null);
  }, [agentId]);

  useEffect(() => {
    setTurn(null);
  }, [agentId, conversationId, threadGroupId]);

  useEffect(() => {
    if (source !== "live" && source !== "error") return;
    let stopped = false;
    // `GET /cli/thread/activity`: the live turn, or null. Pre-0.45 servers
    // 404 and the strip just never shows.
    const catchUpActivity = async () => {
      const addr = addrRef.current;
      if (!addr || threadGroupId) return;
      const current = catchUps.current.begin();
      try {
        const r = await getThreadActivity(addr);
        if (stopped || addrRef.current !== addr || !current()) return;
        if (!r.ok) return;
        const at = Date.now();
        setTurn((t) => applyActivityCatchUp(t, r.data, at));
      } catch {
        /* keep the strip as it is */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void useZenStore.getState().refreshOpenThread();
        void catchUpActivity();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    if (!conversationId || threadGroupId) {
      return () => {
        stopped = true;
        document.removeEventListener("visibilitychange", onVis);
      };
    }
    // No catch-up before the socket: onOpen fires on the first open too,
    // and the poll fallback's onNeedCatchUp covers a socket that never opens.
    const live = connectOverlayEvents({
      conversationId,
      onItem: (raw) => {
        if (isActivityFrame(raw)) {
          catchUps.current.frame();
          const at = Date.now();
          setTurn((t) => applyActivityFrame(t, raw, at));
          return;
        }
        if (isThreadFrame(raw)) useZenStore.getState().ingestThreadRaw(raw);
      },
      onNeedCatchUp: () => {
        void useZenStore.getState().refreshOpenThread();
        void catchUpActivity();
      },
      onOpen: () => void catchUpActivity(),
    });
    return () => {
      stopped = true;
      live.stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [source, conversationId, threadGroupId]);

  // Keyboard open/close: Zen sizes the column to the visual viewport, so
  // the scroller shrinks with scrollTop unchanged and the newest message
  // would slide under the composer. Re-stick if the reader was there.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || viewportHeight == null) return;
    if (atNewest.current) stickToNewest(el);
  }, [viewportHeight]);

  // The floating header growing (sidecar line, banner) adds top padding,
  // which pushes the tail down by the same amount. Keep the newest in view.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || topInset == null) return;
    if (atNewest.current) stickToNewest(el);
  }, [topInset]);

  // The strip appearing or changing shape keeps the newest in view when
  // the reader was already at the bottom.
  const turnShape = turn ? `${turn.turnId}:${turn.phase}:${turn.end ? 1 : 0}` : "";
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !turnShape) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) stickToNewest(el);
  }, [turnShape]);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${composerHeight(el.scrollHeight)}px`;
  }, [draft]);

  function queueFiles(files: File[]) {
    if (!files.length) return;
    if (!canAttach) {
      setAttachError("Files are per workspace, not per project chat.");
      return;
    }
    setAttachError(null);
    setAttachments((prev) => {
      const next = [...prev];
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          setAttachError(`"${uploadFilename(f)}" is too large (50 MB max)`);
          continue;
        }
        if (next.some((x) => x.name === f.name && x.size === f.size && x.type === f.type)) {
          continue;
        }
        next.push(f);
      }
      return next;
    });
  }

  async function onLoadEarlier() {
    const el = scrollerRef.current;
    if (el) {
      const msgs = Array.from(
        el.querySelectorAll<HTMLElement>("[data-thread-msg]")
      );
      pendingAnchor.current = captureTopMessage(el, msgs);
    }
    await loadEarlier();
  }

  const empty =
    (source === "live" || source === "stub") && !error && thread.length === 0;

  return (
    <div
      className="flex flex-col flex-1 min-h-0 min-w-0 overflow-x-hidden"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}
    >
      <div
        ref={scrollerRef}
        data-testid="thread-scroller"
        className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-2.5 py-3 flex flex-col gap-1"
        style={{ overflowAnchor: "none", paddingTop: threadTopPadding(topInset) }}
        onScroll={(e) => {
          const el = e.currentTarget;
          atNewest.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {source === "loading" ? (
          <span
            className="text-[11px] text-[var(--text-muted)] tracking-widest uppercase px-2"
            data-testid="thread-loading"
          >
            {sourceWord(source)} thread
          </span>
        ) : (
          <>
            {source === "error" && error ? (
              <span className="text-[11px] text-[var(--warning)] px-2">
                {asErrorText(error)}
              </span>
            ) : null}
            {empty ? (
              <span
                className="text-[11px] text-[var(--text-muted)] px-2"
                data-testid="thread-empty"
              >
                No messages
              </span>
            ) : null}
            {hasMore && source === "live" ? (
              <button
                type="button"
                data-testid="load-earlier"
                onClick={() => void onLoadEarlier()}
                disabled={loadingEarlier}
                className="self-center text-[13px] text-[var(--text-muted)] py-2"
              >
                {loadingEarlier ? "Loading…" : "Load earlier messages"}
              </button>
            ) : null}
            {thread.map((m, i) => (
              <div
                key={m.id || `seq-${m.seq ?? i}`}
                data-thread-msg=""
                data-seq={m.seq ?? undefined}
                className={`flex flex-col max-w-[78%] min-w-0 ${m.mine ? "self-end items-end" : "self-start items-start"}`}
              >
                {!m.mine ? (
                  <span className="text-[11px] text-[var(--text-muted)] px-3 mb-0.5">
                    {source === "stub" ? <StubMark /> : null}
                    {m.from}
                  </span>
                ) : null}
                <Bubble
                  m={m}
                  onFileLink={openFileFromPath}
                  canAnswer={
                    canSend &&
                    !threadGroupId &&
                    (source === "live" || source === "error")
                  }
                  answering={answeringId === m.id}
                  answerError={answerErrorId === m.id ? answerError : null}
                  onAnswer={(option) => void answerChoice(m.id, option)}
                />
                <span className="text-[11px] text-[var(--text-muted)] px-2 mt-0.5">
                  {m.failed ? "Not sent" : m.pending ? "Sending…" : mountainTime(m.at)}
                </span>
              </div>
            ))}
            {turn && !threadGroupId ? <ThreadWorkingStrip turn={turn} /> : null}
          </>
        )}
      </div>
      {/* zen-composer-bar: home-indicator inset at rest, collapsed while
          typing so it is not a gap above the keyboard (.input-bar idiom). */}
      <div
        className="shrink-0 min-w-0 w-full overflow-hidden px-3 pt-2 zen-composer-bar"
        data-testid="composer-bar"
      >
        <p
          className="text-[11px] text-[var(--text-muted)] leading-snug break-words mb-1.5"
          data-testid="composer-label"
        >
          {source === "stub"
            ? "STUB — Cannot send — POST /cli/thread/post not proven"
            : uploading
              ? "Uploading…"
              : sending
                ? "Sending…"
                : attachError
                  ? attachError
                  : sendError
                    ? sendError
                    : canSend
                      ? ""
                      : source === "live"
                        ? "Not chattable"
                        : ""}
        </p>
        {attachments.length ? (
          <div
            className="flex flex-wrap gap-1.5 mb-1.5"
            data-testid="attach-chips"
          >
            {attachments.map((f, i) => (
              <button
                key={`${f.name}-${i}`}
                type="button"
                data-testid="attach-chip"
                className="text-[12px] px-2 py-1 rounded-full bg-[var(--card)] text-[var(--text)]"
                onClick={() =>
                  setAttachments((prev) => prev.filter((_, j) => j !== i))
                }
                aria-label={`Remove ${uploadFilename(f)}`}
              >
                {uploadFilename(f)} ×
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="flex items-end min-w-0"
          data-testid="composer-form"
          onPaste={(e) => {
            const files = filesFromClipboard(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            queueFiles(files);
          }}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!canSend || sending || uploading) return;
            const text = draft;
            const pending = attachments;
            if (!text.trim() && !pending.length) return;
            void (async () => {
              let body = text;
              if (pending.length) {
                if (!canAttach || !attachWorkspace || !attachDir) {
                  setAttachError("Files are per workspace, not per project chat.");
                  return;
                }
                setUploading(true);
                setAttachError(null);
                const paths: string[] = [];
                try {
                  for (const f of pending) {
                    const filename = uploadFilename(f);
                    const b64 = await fileToBase64(f);
                    const r = await uploadFsBinary(
                      attachWorkspace,
                      attachDir,
                      filename,
                      b64
                    );
                    if (!r.ok || !r.data?.path) {
                      setAttachError(r.error || `Could not upload ${filename}`);
                      return;
                    }
                    paths.push(r.data.path);
                  }
                } finally {
                  setUploading(false);
                }
                body = attachmentSendBody(text, paths);
              }
              await sendThread(body);
              if (!useZenStore.getState().sendError) {
                setDraft("");
                setAttachments([]);
                setAttachError(null);
              }
            })();
          }}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            data-testid="composer-file-input"
            onChange={(e) => {
              const list = e.target.files;
              queueFiles(list ? Array.from(list) : []);
              e.target.value = "";
            }}
          />
          <div
            className="flex-1 min-w-0 overflow-hidden flex items-end gap-1 rounded-[20px] pl-1 pr-1 py-1 k2-tile"
            data-testid="composer-field"
          >
            {canSend ? (
              <button
                type="button"
                data-testid="composer-attach"
                aria-label="Add file"
                disabled={!canAttach || sending || uploading}
                onClick={() => fileRef.current?.click()}
                className="shrink-0 flex items-center justify-center bg-transparent border-0 text-[var(--text-muted)] disabled:opacity-40"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  fontSize: 22,
                  lineHeight: 1,
                }}
              >
                ＋
              </button>
            ) : null}
            <textarea
              ref={composerRef}
              disabled={!canSend || sending || uploading}
              value={draft}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => {
                window.scrollTo(0, 0);
                const el = scrollerRef.current;
                if (el && atNewest.current) stickToNewest(el);
              }}
              onPaste={(e) => {
                const files = filesFromClipboard(e.clipboardData);
                if (!files.length) return;
                e.preventDefault();
                queueFiles(files);
              }}
              placeholder="Message"
              className={`flex-1 min-w-0 w-full resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-transparent border-0 text-[17px] leading-[22px] text-[var(--text)] outline-none py-1 ${canSend ? "" : "px-2"}`}
              style={{ maxHeight: COMPOSER_MAX_PX }}
              aria-label="Message"
              data-testid="composer-input"
            />
            {canSend ? (
              <button
                type="submit"
                aria-label="Send"
                data-testid="composer-send"
                disabled={!sendReady}
                // Keep focus in the textarea so the iOS keyboard stays up
                // (AccessoryBar pattern). Not on attach — it opens a picker.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                className={`shrink-0 flex items-center justify-center k2-tile ${
                  sendReady
                    ? "text-white"
                    : "k2-tile-raised text-[var(--text-muted)] opacity-60"
                }`}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  ...(sendReady
                    ? { background: "#0a84ff", borderColor: "#0a84ff" }
                    : {}),
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="M5 12l7-7 7 7" />
                </svg>
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}