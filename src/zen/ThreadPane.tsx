import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { uploadFsBinary } from "../api/client";
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
}: {
  m: ThreadMessage;
  onFileLink?: (ref: string) => void;
}) {
  return (
    <div
      className="px-3 py-2 text-[17px] leading-snug break-words"
      style={{
        borderRadius: 18,
        background: m.mine ? "#0a84ff" : "#3a3a3c",
        color: "#fff",
        opacity: m.pending ? 0.7 : 1,
      }}
    >
      {m.choice ? (
        <div>
          {m.choice.prompt ? (
            <ChatMessageBody
              text={m.choice.prompt}
              className="!p-0 text-white"
              style={{ color: "#fff" }}
              onFileLink={onFileLink}
            />
          ) : null}
          {m.choice.options.length ? (
            <ul className="mt-2 text-[15px]">
              {m.choice.options.map((o) => (
                <li key={o}>
                  {m.choice && m.choice.answer === o ? "● " : "○ "}
                  {o}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-[12px] opacity-80">
            {m.choice.answer != null ? "Answered." : "Reply is not wired on this client."}
          </p>
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
 * BEHAVE: GET /cli/thread. Send is on for any live overlay addr.
 * Never sends to a PTY.
 */
export function ThreadPane() {
  const thread = useZenStore((s) => s.thread);
  const source = useZenStore((s) => s.threadSource);
  const error = useZenStore((s) => s.threadError);
  const agentId = useZenStore((s) => s.agentId);
  const hasMore = useZenStore((s) => s.threadHasMore);
  const loadingEarlier = useZenStore((s) => s.threadLoadingEarlier);
  const loadEarlier = useZenStore((s) => s.loadEarlier);
  const sendThread = useZenStore((s) => s.sendThread);
  const threadAddr = useZenStore((s) => s.threadAddr);
  const threadGroupId = useZenStore((s) => s.threadGroupId);
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<MessageAnchor | null>(null);
  const prevAgent = useRef<string>("");
  const prevFirst = useRef<number | null>(null);

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
        style={{ overflowAnchor: "none" }}
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
                className={`flex flex-col max-w-[78%] ${m.mine ? "self-end items-end" : "self-start items-start"}`}
              >
                {!m.mine ? (
                  <span className="text-[11px] text-[var(--text-muted)] px-3 mb-0.5">
                    {source === "stub" ? <StubMark /> : null}
                    {m.from}
                  </span>
                ) : null}
                <Bubble m={m} onFileLink={openFileFromPath} />
                <span className="text-[11px] text-[var(--text-muted)] px-2 mt-0.5">
                  {m.failed ? "Not sent" : m.pending ? "Sending…" : mountainTime(m.at)}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <div
        className="shrink-0 min-w-0 w-full overflow-hidden px-3 pt-2"
        style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
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
          className="flex items-end min-w-0 gap-2"
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
          {canSend ? (
            <button
              type="button"
              data-testid="composer-attach"
              aria-label="Add file"
              disabled={!canAttach || sending || uploading}
              onClick={() => fileRef.current?.click()}
              className="shrink-0 flex items-center justify-center disabled:opacity-40"
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "#1c1c1e",
                color: "#d1d1d6",
                fontSize: 22,
                lineHeight: 1,
              }}
            >
              ＋
            </button>
          ) : null}
          <div className="flex-1 min-w-0 overflow-hidden flex items-end rounded-[20px] px-3 py-2 bg-[var(--card)]">
            <textarea
              ref={composerRef}
              disabled={!canSend || sending || uploading}
              value={draft}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const files = filesFromClipboard(e.clipboardData);
                if (!files.length) return;
                e.preventDefault();
                queueFiles(files);
              }}
              placeholder="Message"
              className="flex-1 min-w-0 w-full resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-transparent border-0 text-[17px] leading-[22px] text-[var(--text)] outline-none"
              style={{ maxHeight: COMPOSER_MAX_PX }}
              aria-label="Message"
              data-testid="composer-input"
            />
          </div>
          {canSend ? (
            <button
              type="submit"
              disabled={sending || uploading || (!draft.trim() && !attachments.length)}
              className="shrink-0 text-[15px] font-semibold text-[#0a84ff] disabled:opacity-40"
            >
              Send
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
}