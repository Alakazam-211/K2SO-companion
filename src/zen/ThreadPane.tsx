import { ChatMessageBody } from "../components/ChatMessage";
import { asErrorText } from "../lib/apiError";
import { StubMark } from "./StubMark";
import { mountainTime, type ThreadMessage } from "./threadModel";
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

  const empty =
    (source === "live" || source === "stub") && !error && thread.length === 0;

  return (
    <div
      className="flex flex-col flex-1 min-h-0 min-w-0 overflow-x-hidden"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' }}
    >
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-2.5 py-3 flex flex-col gap-1">
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
        {thread.map((m, i) => (
          <div
            key={m.id || `seq-${m.seq ?? i}`}
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
        className="flex items-center gap-2 px-3 pt-2 shrink-0 min-w-0 w-full overflow-hidden"
        style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
      >
        <div className="flex-1 min-w-0 overflow-hidden flex items-center rounded-full px-3 py-2 bg-[var(--card)]">
          <input
            disabled
            placeholder="Cannot send — POST /cli/thread/post not proven"
            className="flex-1 min-w-0 w-full bg-transparent border-0 text-[17px] text-[var(--text)] outline-none overflow-hidden text-ellipsis"
            aria-label="Message"
          />
        </div>
        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-widest shrink-0">
          {source === "stub" ? "STUB" : "no send"}
        </span>
      </div>
    </div>
  );
}