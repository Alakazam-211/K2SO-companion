// One message in a Home chat, in the Thread's look (ThreadPane's
// `ThreadRow` / `Bubble`): your bubble on the accent fill, theirs on the
// agent bubble, iMessage tails on a run's last, the name and time over
// someone else's run, the status line under yours. What differs (brief
// §2.9; desktop `HomeChatMessageRow.tsx`):
//   - a reply's quote strip inside the bubble ("Ana: first line"); a tap
//     jumps to the original ("Original message deleted" / "Original not
//     loaded" when it can't be shown);
//   - reaction chips under the bubble;
//   - a message just jumped to wears a fading accent wash (1.2 s);
//   - a call's record is a LINE, never a bubble, with "Call back".
// The hold menu (React, Reply, Copy) is the view's: a bubble carries
// MESSAGE_HOLD_ATTR and `useMessageHold` on the list does the rest.

import { memo, type CSSProperties } from "react";
import type { HomeChatMessage } from "../../api/homeChatPure";
import { callRecordLine } from "../../api/homeChatCallsPure";
import { ChatMessageBody } from "../../components/ChatMessage";
import { MESSAGE_HOLD_ATTR } from "../stash/useMessageHold";
import { SENDING_OPACITY } from "../useDeliverBrighten";
import { DELETED_TEXT, mountainTime } from "../threadModel";
import { bubbleBodyStyle } from "../ThreadPane";
import { PhoneIcon } from "../icons";
import { zenTextPx } from "../zenFont";
import type { RunPos } from "../chatReceipt";
import { quoteText, type ReplyPreview } from "./homeChatModel";
import { ReactionChips } from "./HomeChatReactions";
import "../chatBubbles.css";
import "./homeChat.css";

const NO_SELECT: CSSProperties = { userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" };
const SELECTABLE: CSSProperties = { userSelect: "text", WebkitUserSelect: "text", WebkitTouchCallout: "default" };

export interface HomeChatRowActions {
  toggleReaction: (msgId: string, emoji: string) => void;
  whoReacted: (msgId: string, emoji: string) => Promise<string[] | null>;
  jump: (msgId: string) => void;
  retry: (nonce: string) => void;
  edit: (nonce: string) => void;
}

/** A send's state on its optimistic bubble. */
export type RowSend = { status: "sending" | "failed"; error: string | null; final?: boolean } | null;

function QuoteStrip({ preview, onJump }: { preview: ReplyPreview; onJump: () => void }) {
  const q = quoteText(preview);
  return (
    <button
      type="button"
      // The bubble's own word colour, faded (the Thread's quote line): no
      // color-mix on iOS 15, so the fade is opacity on currentColor.
      className="relative flex items-center gap-1.5 min-w-0 max-w-full mb-1 text-[13px] leading-snug text-left bg-transparent border-0 p-0"
      style={{ paddingLeft: 8, color: "inherit" }}
      data-testid="home-chat-quote"
      data-state={preview.state}
      aria-label={preview.state === "loaded" ? `Replying to ${q.from}: ${q.line}. Tap to see it` : q.line}
      onClick={(e) => {
        e.stopPropagation();
        onJump();
      }}
    >
      <span aria-hidden className="absolute left-0 top-0 bottom-0" style={{ width: 2, background: "currentColor", opacity: 0.35 }} />
      <span className="flex-1 min-w-0 truncate" style={{ opacity: 0.65, fontStyle: preview.state === "loaded" ? undefined : "italic" }}>
        {q.from ? <span className="font-semibold">{q.from}: </span> : null}
        {q.line}
      </span>
    </button>
  );
}

export const HomeChatMessageRow = memo(function HomeChatMessageRow({
  m,
  mine,
  name,
  run,
  reply,
  flash,
  held,
  send,
  readOnly,
  canEdit,
  actions,
}: {
  m: HomeChatMessage;
  mine: boolean;
  /** The name over this run (its first, someone else's); null: none. */
  name: string | null;
  run: RunPos;
  /** The original, when this is a reply. */
  reply: ReplyPreview | null;
  /** Just jumped to: the accent wash. */
  flash: boolean;
  /** Its hold menu is open: the ring that follows the bubble. */
  held: boolean;
  send: RowSend;
  /** No reactions or replies (an archived channel, a read-only DM). */
  readOnly: boolean;
  /** A "Not sent" bubble can go back into the (empty) box. */
  canEdit: boolean;
  actions: HomeChatRowActions;
}) {
  const optimistic = m.id.startsWith("~");
  const spaced = run.first;
  const side = mine ? "self-end items-end" : "self-start items-start";
  if (m.deleted) {
    return (
      <div
        data-home-chat-msg={m.id}
        data-testid="home-chat-msg-deleted"
        className={`relative flex flex-col max-w-[78%] min-w-0 ${side}${spaced ? " mt-1.5" : ""}`}
      >
        {flash ? <span aria-hidden className="k2-hc-wash" data-testid="home-chat-wash" /> : null}
        <span className="px-3 py-0.5 text-[13px] italic text-[var(--color-text-muted)] select-none">{DELETED_TEXT}</span>
      </div>
    );
  }
  const holdable = !optimistic && Boolean(m.body.trim());
  const tail = run.last ? (mine ? "mine" : "theirs") : null;
  const pending = send?.status === "sending";
  const failed = send?.status === "failed";
  const nonce = optimistic ? m.id.slice(1) : null;
  return (
    <div
      data-home-chat-msg={m.id}
      data-testid="home-chat-msg"
      data-mine={mine ? "" : undefined}
      data-run={run.first && run.last ? "solo" : run.first ? "first" : run.last ? "last" : "middle"}
      data-flash={flash ? "" : undefined}
      className={`relative flex flex-col max-w-[78%] min-w-0 ${side}${spaced ? " mt-1.5" : ""}`}
    >
      {flash ? <span aria-hidden className="k2-hc-wash" data-testid="home-chat-wash" /> : null}
      {name ? (
        <span
          className="relative flex items-baseline gap-1.5 text-[11px] text-[var(--color-text-muted)] px-3 mb-0.5 min-w-0 max-w-full"
          data-testid="home-chat-msg-meta"
        >
          <span className="truncate min-w-0" data-testid="home-chat-msg-name">
            {name}
          </span>
          <span className="shrink-0" aria-hidden>
            •
          </span>
          <span className="shrink-0">{mountainTime(m.createdAtMs)}</span>
        </span>
      ) : null}
      {/* The bubble and its chips: what the hold menu lifts above the dim
          (the name line stays on the page, as iOS lifts only the bubble). */}
      <div className={`flex flex-col min-w-0 max-w-full ${mine ? "items-end" : "items-start"}`} data-home-chat-lift={m.id}>
      <div
        className={`relative px-3 py-2 leading-snug break-words min-w-0 max-w-full${tail ? " zen-tail" : ""}${held ? " zen-outlined" : ""}`}
        data-testid="home-chat-bubble"
        data-tail={tail || undefined}
        {...{ [MESSAGE_HOLD_ATTR]: holdable ? m.id : undefined }}
        aria-haspopup={holdable ? "menu" : undefined}
        aria-description={holdable ? "Hold the bubble to react, reply or copy" : undefined}
        style={{
          ...(holdable ? NO_SELECT : null),
          fontSize: zenTextPx(17),
          borderRadius: 18,
          background: mine ? "var(--color-accent-fill)" : "var(--color-bubble-agent)",
          ["--k2-bubble" as string]: mine ? "var(--color-accent-fill)" : "var(--color-bubble-agent)",
          color: mine ? "var(--color-on-accent)" : "var(--color-text-primary)",
          opacity: pending ? SENDING_OPACITY : 1,
        }}
      >
        <div className="min-w-0 max-w-full overflow-hidden" data-bubble-body="" style={SELECTABLE}>
          {m.replyTo && reply ? <QuoteStrip preview={reply} onJump={() => actions.jump(m.replyTo!)} /> : null}
          <ChatMessageBody text={m.body} className="!p-0" style={bubbleBodyStyle()} />
        </div>
      </div>
      <ReactionChips
        reactions={m.reactions}
        mine={mine}
        disabled={readOnly || optimistic}
        onToggle={(emoji) => actions.toggleReaction(m.id, emoji)}
        whoFor={(emoji) => actions.whoReacted(m.id, emoji)}
      />
      </div>
      {mine && (run.last || send) ? (
        <span
          className="flex items-center gap-2 h-4 leading-4 whitespace-nowrap text-[11px] text-[var(--color-text-muted)] px-2 mt-0.5"
          data-testid="home-chat-msg-status"
          data-status={failed ? "failed" : pending ? "sending" : "sent"}
        >
          {failed && nonce && send?.final ? (
            // A retry can't fix it (an archived channel): no Retry.
            <span className="text-[var(--color-status-warn-text)]" data-testid="home-chat-not-sent" title={send.error || undefined}>
              Not sent
            </span>
          ) : failed && nonce ? (
            <>
              <button
                type="button"
                className="text-[var(--color-status-warn-text)] bg-transparent border-0 p-0"
                data-testid="home-chat-retry"
                aria-label="Not sent. Tap to retry"
                title={send?.error || undefined}
                onClick={() => actions.retry(nonce)}
              >
                Not sent · Retry
              </button>
              {canEdit ? (
                <button type="button" className="bg-transparent border-0 p-0" data-testid="home-chat-edit" onClick={() => actions.edit(nonce)}>
                  Edit
                </button>
              ) : null}
            </>
          ) : pending ? (
            "Sending…"
          ) : (
            mountainTime(m.createdAtMs)
          )}
        </span>
      ) : null}
    </div>
  );
});

/** A DM call's record: a quiet centred line ("Missed call", "Call · 4:12")
 *  with Call back once the call is over (desktop `HomeChatCallRecord`).
 *  `onCallBack` is the call builder's (absent: no button). */
export const HomeChatCallLine = memo(function HomeChatCallLine({
  m,
  me,
  flash,
  onCallBack,
}: {
  m: HomeChatMessage;
  me: string | null;
  flash: boolean;
  onCallBack?: () => void;
}) {
  if (!m.call) return null;
  const line = callRecordLine(m.call, me);
  const missed = line.kind === "missed";
  return (
    <div
      data-home-chat-msg={m.id}
      data-testid="home-chat-call"
      data-call={line.kind}
      className="relative self-center flex items-center justify-center gap-2 min-w-0 max-w-full my-1.5 px-3 text-[12px]"
      style={{ color: "var(--color-text-muted)" }}
    >
      {flash ? <span aria-hidden className="k2-hc-wash" /> : null}
      <span className="flex shrink-0" style={{ color: missed ? "var(--color-status-error)" : "var(--color-text-muted)" }}>
        <PhoneIcon size={13} strokeWidth={2} />
      </span>
      <span className="truncate" style={missed ? { color: "var(--color-status-error-text)" } : undefined} data-testid="home-chat-call-text">
        {line.text}
      </span>
      <span className="shrink-0" aria-hidden>
        ·
      </span>
      <span className="shrink-0">{mountainTime(m.createdAtMs)}</span>
      {line.callBack && onCallBack ? (
        <button
          type="button"
          className="shrink-0 zen-glass zen-glass-pill text-[12px] font-semibold"
          style={{ minHeight: 26, padding: "0 10px", color: "var(--color-accent-text)" }}
          data-testid="home-chat-call-back"
          onClick={onCallBack}
        >
          Call back
        </button>
      ) : null}
    </div>
  );
});
