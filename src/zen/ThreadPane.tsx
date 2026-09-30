import { useLayoutEffect, useRef, useState } from "react";
import { ChatMessageBody } from "../components/ChatMessage";
import { asErrorText } from "../lib/apiError";
import { StubMark } from "./StubMark";
import { mountainTime, type ThreadMessage } from "./threadModel";
import {
  captureTopMessage,
  restoreTopMessage,
  stickToNewest,
  type MessageAnchor,
} from "./threadScroll";
import { sourceWord, useZenStore } from "./zenStore";

function Bubble({ m }: { m: ThreadMessage }) {
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
        <ChatMessageBody text={m.text} className="!p-0 text-white" style={{ color: "#fff" }} />
      )}
    </div>
  );
}

/**
 * Overlay thread pane. LOOK: iMessage in/out bubbles + Mountain Time.
 * BEHAVE this hash: GET /cli/thread. Composer is labelled; POST /cli/thread/post
 * is not proven on this client yet. Never sends to a PTY.
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
  const sending = useZenStore((s) => s.sending);
  const sendError = useZenStore((s) => s.sendError);
  const [draft, setDraft] = useState("");
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
          <span className="text-[11px] text-[var(--text-muted)] tracking-widest uppercase px-2">
            {sourceWord(source)} thread
          </span>
        ) : null}
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
            <Bubble m={m} />
            <span className="text-[11px] text-[var(--text-muted)] px-2 mt-0.5">
              {m.failed ? "Not sent" : m.pending ? "Sending…" : mountainTime(m.at)}
            </span>
          </div>
        ))}
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
            : sending
              ? "Sending…"
              : sendError
                ? sendError
                : ""}
        </p>
        <form
          className="flex items-center min-w-0 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft;
            void sendThread(text).then(() => {
              if (!useZenStore.getState().sendError) setDraft("");
            });
          }}
        >
          <div className="flex-1 min-w-0 overflow-hidden flex items-center rounded-full px-3 py-2 bg-[var(--card)]">
            <input
              disabled={source !== "live" || !threadAddr || sending}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message"
              className="flex-1 min-w-0 w-full bg-transparent border-0 text-[17px] text-[var(--text)] outline-none"
              aria-label="Message"
            />
          </div>
          {source === "live" && threadAddr ? (
            <button
              type="submit"
              disabled={sending || !draft.trim()}
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