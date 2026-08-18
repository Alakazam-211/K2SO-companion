import type { FeedbackShow } from "../api/feedback";
import { relativeAge } from "../api/feedback";
import { KindTag, PriorityTag, StatusTag } from "../pages/Feedback";
import { ChatMessageBody } from "./ChatMessage";
import { AssigneePicker } from "./AssigneePicker";

// Full-ticket review sheet. Title, body, chips, times, options
// (read-only — answering stays in the thread), and assignees (editable).
//
// Deliberately hook-free/presentational so the headless render check can
// walk the element tree directly (the feedbackPure zero-import spirit).

interface Props {
  item: FeedbackShow;
  nowSec: number;
  onClose: () => void;
  onAssigneesChanged?: () => void;
}

/** "Jul 5, 3:42 PM" (local) — the sheet pairs this with the relative age. */
function absoluteTime(sec: number): string {
  return new Date(sec * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[var(--text-muted)] text-[10px] uppercase tracking-wide">
        {label}
      </span>
      <span className="text-[var(--text-secondary)] text-[10px] break-words min-w-0">
        {value}
      </span>
    </div>
  );
}

export function TicketSheet({ item, nowSec, onClose, onAssigneesChanged }: Props) {
  const timeLine = (sec: number) => `${relativeAge(sec, nowSec)} ago · ${absoluteTime(sec)}`;
  const closed = item.status === "resolved" || item.status === "dismissed";

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50" onClick={onClose} />

      <div
        className="fixed bottom-0 left-0 right-0 z-50 bg-[var(--background)] border-t border-[var(--border)] max-h-[85vh] flex flex-col"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + var(--android-nav-lift, 0px))" }}
      >
        <div className="flex items-center justify-center py-2 shrink-0">
          <div className="w-10 h-1 bg-[var(--border)] rounded-full" />
        </div>

        <div className="px-4 pb-2 flex items-center justify-between shrink-0">
          <span className="text-[var(--text-muted)] text-[10px] font-semibold tracking-widest uppercase">
            Ticket
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 -mr-2 flex items-center justify-center text-[var(--text-muted)]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div
          className="flex-1 min-h-0 overflow-y-auto px-4 pb-8 flex flex-col gap-4"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {/* Full title — the whole point: no truncation. */}
          <div className="flex flex-col gap-2">
            <h2 className="text-[var(--text)] text-[11px] font-medium leading-4 whitespace-pre-wrap break-words">
              {item.title}
            </h2>
            <div className="flex items-center gap-1.5">
              <PriorityTag priority={item.priority} />
              <KindTag kind={item.kind} />
              <StatusTag status={item.status} />
            </div>
          </div>

          {onAssigneesChanged && (
            <AssigneePicker
              ticketId={item.id}
              assignees={item.assignees ?? []}
              menuInFlow
              onChanged={onAssigneesChanged}
            />
          )}

          <div className="flex flex-col gap-1.5">
            {item.workspace && <MetaRow label="Workspace" value={item.workspace} />}
            <MetaRow label="Agent" value={item.agentName} />
            <MetaRow label="Asked" value={timeLine(item.createdAt)} />
            {item.answeredAt !== null && (
              <MetaRow label="Answered" value={timeLine(item.answeredAt)} />
            )}
            {closed && (
              <MetaRow
                label={item.status === "resolved" ? "Resolved" : "Dismissed"}
                value={timeLine(item.updatedAt)}
              />
            )}
            <MetaRow
              label="Comments"
              value={`${item.comments.length}`}
            />
          </div>

          {item.body && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[var(--text-muted)] text-[10px] uppercase tracking-wide">
                Body
              </span>
              <div
                className="bg-[var(--surface)] border border-[var(--border)]"
                style={{ padding: "10px 12px" }}
              >
                <ChatMessageBody text={item.body} style={{ fontSize: 12 }} />
              </div>
            </div>
          )}

          {/* Options as read-only labels — answering stays in the thread. */}
          {item.options && item.options.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[var(--text-muted)] text-[10px] uppercase tracking-wide">
                Options · answer from the thread
              </span>
              <div className="flex flex-wrap gap-2">
                {item.options.map((opt) => {
                  const accepted = item.answer === opt;
                  return (
                    <span
                      key={opt}
                      className={`px-2 py-1 text-[10px] border break-words ${
                        accepted
                          ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]/20"
                          : "border-[var(--border)] text-[var(--text-muted)]"
                      }`}
                    >
                      {opt}
                      {accepted ? " ✓" : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
