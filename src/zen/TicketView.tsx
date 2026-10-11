import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  assignFeedback,
  commentFeedback,
  deliveryMissLine,
  fetchTicketUsers,
  isClosedStatus,
  relativeAge,
  resolveFeedback,
  SETTABLE_STATUSES,
  statusColor,
  statusLabel,
  type FeedbackShow,
  type FeedbackStatus,
} from "../api/feedback";
import { briefRenderable, quickAnswerOptions, type QuickAnswerOption } from "../api/ticketBrief";
import { ChatMessageBody } from "../components/ChatMessage";
import { asErrorText } from "../lib/apiError";
import { isMyAuthor } from "../lib/sessionAuthor";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { useFeedbackStore } from "../stores/feedback";
import { BriefCard, BriefReader, useBriefDoc } from "./TicketBrief";
import { composerHeight, COMPOSER_MAX_PX } from "./ThreadPane";
import { zenTextPx } from "./zenFont";

// Zen open ticket — Layout A (Rosson, 2026-10-11). Full-screen inside the
// Chats column, below the notch, the ThreadPane look:
//
//   header   glass ‹ Tickets pill + ⋯ (Reassign); title (2 lines); meta:
//            status chip (a menu) · P# · agent → assignees · age
//   scroll   brief card (TicketBrief) → answer card (quick-answer pills)
//            → comments as iMessage bubbles
//   bottom   ThreadPane's composer (no attach) — or, for a ticket whose
//            workspace was removed, a Resolve / Dismiss footer
//
// Answering (0.43.2+): a pill sends `comment {id, body, optionPick:true}`
// (→ answered, the agent hears it); typed text sends `comment {id, body}`
// (→ needs_discussion). Never `author`. "Answered" from the status menu
// asks "What was agreed?" and sends `resolve answered+answer`, which the
// agent does NOT hear. The brief is loaded once (store cache); every
// refetch here is a plain `show`.

const PILL_H = 34;

function ago(atSec: number): string {
  const a = relativeAge(atSec);
  return a === "now" ? "now" : `${a} ago`;
}

function errText(e: unknown): string {
  return asErrorText(e instanceof Error ? e.message : String(e));
}

/** Refetch the open ticket and the list (badge, sections). */
function refetchAll(): Promise<void> {
  void useFeedbackStore.getState().refresh();
  return useFeedbackStore.getState().refetchOpen();
}

/** Bottom sheet over the ticket (Reassign, What was agreed?). */
function Sheet({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 14 }} data-testid={testId}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose} />
      <div
        className="relative k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderRadius: "16px 16px 0 0",
          maxHeight: "80%",
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex items-center shrink-0" style={{ padding: "14px 16px 8px" }}>
          <span className="text-[17px] font-semibold flex-1">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-[15px] bg-transparent border-0"
            style={{ color: "#8e8e93" }}
          >
            Cancel
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ReassignSheet({
  item,
  onClose,
}: {
  item: FeedbackShow;
  onClose: () => void;
}) {
  const current = item.assignees ?? [];
  const [people, setPeople] = useState<string[]>(["owner"]);
  const [picked, setPicked] = useState<string[]>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchTicketUsers()
      .catch(() => ["owner"])
      .then((names) => {
        if (!cancelled) setPeople(names);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Current assignees always show, even a deleted user (snapshots).
  const lower = new Set(people.map((p) => p.toLowerCase()));
  const options = [...people, ...current.filter((a) => !lower.has(a.toLowerCase()))];

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await assignFeedback(item.id, picked);
      await refetchAll();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="Assign to" onClose={onClose} testId="ticket-reassign">
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "0 8px" }}>
        {options.map((name) => {
          const on = picked.some((p) => p.toLowerCase() === name.toLowerCase());
          return (
            <button
              key={name}
              type="button"
              data-testid="reassign-person"
              onClick={() =>
                setPicked((prev) =>
                  on
                    ? prev.filter((p) => p.toLowerCase() !== name.toLowerCase())
                    : [...prev, name]
                )
              }
              className="flex w-full items-center gap-3 text-left text-[17px] bg-transparent border-0"
              style={{ padding: "11px 8px", color: "#fff" }}
            >
              <span style={{ width: 18, color: on ? "var(--accent)" : "transparent" }}>✓</span>
              {name}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="text-[13px] px-4 pt-1" style={{ color: "var(--warning)" }} role="alert">
          {error}
        </p>
      ) : null}
      <div className="px-4 pt-2 shrink-0">
        <button
          type="button"
          data-testid="reassign-save"
          disabled={saving}
          onClick={() => void save()}
          className="w-full text-[17px] font-semibold border-0 disabled:opacity-50"
          style={{ height: 44, borderRadius: 22, background: "#0a84ff", color: "#fff" }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Sheet>
  );
}

function AgreedSheet({
  item,
  onClose,
}: {
  item: FeedbackShow;
  onClose: () => void;
}) {
  const [text, setText] = useState(item.answer ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const answer = text.trim();
    if (!answer) return;
    setSaving(true);
    setError(null);
    try {
      await resolveFeedback(item.id, "answered", answer);
      await refetchAll();
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet title="What was agreed?" onClose={onClose} testId="ticket-agreed">
      <div className="px-4">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          data-testid="agreed-input"
          placeholder="The outcome, in a line"
          className="w-full resize-none text-[17px] outline-none k2-tile k2-tile-raised"
          style={{ borderRadius: 14, padding: "10px 12px", color: "var(--text)" }}
        />
        <p className="text-[12px] mt-1" style={{ color: "#8e8e93" }}>
          Recorded on the ticket. The agent isn't told — pick an option to tell it.
        </p>
        {error ? (
          <p className="text-[13px] mt-1" style={{ color: "var(--warning)" }} role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          data-testid="agreed-save"
          disabled={saving || !text.trim()}
          onClick={() => void save()}
          className="w-full mt-3 text-[17px] font-semibold border-0 disabled:opacity-50"
          style={{ height: 44, borderRadius: 22, background: "#0a84ff", color: "#fff" }}
        >
          {saving ? "Saving…" : "Mark answered"}
        </button>
      </div>
    </Sheet>
  );
}

/** Small anchored menu (status chip, ⋯). Closes on any outside tap. */
function Menu({
  onClose,
  align,
  children,
  testId,
}: {
  onClose: () => void;
  align: "left" | "right";
  children: ReactNode;
  testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      className="absolute k2-tile k2-tile-raised flex flex-col overflow-hidden"
      style={{
        top: "calc(100% + 6px)",
        [align]: 0,
        zIndex: 13,
        borderRadius: 14,
        minWidth: 200,
      }}
    >
      {children}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  checked,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  checked?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      className="flex items-center gap-2 text-left text-[16px] bg-transparent border-0"
      style={{ padding: "11px 14px", color: "#fff", borderBottom: "0.5px solid rgba(255,255,255,0.08)" }}
    >
      <span style={{ width: 16, color: "var(--accent)" }}>{checked ? "✓" : ""}</span>
      {children}
    </button>
  );
}

export function StatusChip({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[13px] font-medium"
      style={{ color }}
      data-testid="status-chip"
      data-status={status}
    >
      <span
        aria-hidden
        className="inline-block shrink-0"
        style={{ width: 7, height: 7, borderRadius: 4, background: color }}
      />
      {statusLabel(status)}
    </span>
  );
}

/** Quick-answer pills. The pill equal to `answer` is filled with a ✓. */
function AnswerPills({
  options,
  answer,
  active,
  sending,
  onPick,
}: {
  options: QuickAnswerOption[];
  answer: string | null;
  active: boolean;
  sending: string | null;
  onPick: (answer: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-testid="answer-pills">
      {options.map((o) => {
        const picked = answer != null && answer === o.answer;
        const tappable = active && sending === null;
        return (
          <button
            key={o.answer}
            type="button"
            data-testid="answer-pill"
            aria-pressed={picked}
            title={o.detail}
            disabled={!tappable}
            onClick={() => onPick(o.answer)}
            className="rounded-full px-3.5 py-2 text-[15px] leading-tight border text-left"
            style={{
              borderColor: picked ? "#fff" : "rgba(255,255,255,0.35)",
              background: picked ? "#fff" : "transparent",
              color: picked ? "#1c1c1e" : "#fff",
              opacity: tappable || picked ? 1 : 0.5,
            }}
          >
            {picked ? "✓ " : ""}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function TicketView({
  id,
  linked,
  onBack,
}: {
  id: string;
  /** False when the list row says the workspace was removed. */
  linked: boolean;
  onBack: () => void;
}) {
  const item = useFeedbackStore((s) => (s.openId === id ? s.openItem : null));
  const openError = useFeedbackStore((s) => (s.openId === id ? s.openError : null));
  const entry = useFeedbackStore((s) => s.briefs[id]);
  const identity = useSessionIdentity();
  const [menu, setMenu] = useState<"status" | "more" | null>(null);
  const [sheet, setSheet] = useState<"reassign" | "agreed" | null>(null);
  const [reader, setReader] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Delivery miss after the last comment, and where it came from. */
  const [receipt, setReceipt] = useState<{ from: "pick" | "text"; line: string } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const brief = entry?.state === "ready" ? entry.brief : null;
  const doc = useBriefDoc(brief);
  const hasBrief = item?.hasBrief === true;

  // A deep-linked or refetched ticket that turns out to have a brief:
  // load it once (never again on a later refetch — the cache holds it).
  useEffect(() => {
    if (item && item.hasBrief && !entry) void useFeedbackStore.getState().loadBrief(item.id);
  }, [item, entry]);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${composerHeight(el.scrollHeight)}px`;
  }, [draft]);

  // New comments keep the newest in view when the reader is at the tail.
  const commentCount = item?.comments.length ?? 0;
  const prevCount = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || prevCount.current === null) {
      prevCount.current = commentCount;
      return;
    }
    if (commentCount > prevCount.current) {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      if (near) el.scrollTop = el.scrollHeight;
    }
    prevCount.current = commentCount;
  }, [commentCount]);

  const status = item?.status ?? "waiting";
  const closed = isClosedStatus(status);
  const options = item
    ? quickAnswerOptions(item, briefRenderable(brief) ? brief.html : null)
    : [];
  const pillsActive = linked && !closed;

  const pick = async (answer: string) => {
    if (!item || picking !== null) return;
    setPicking(answer);
    setError(null);
    setReceipt(null);
    try {
      const res = await commentFeedback(item.id, answer, { optionPick: true });
      const miss = deliveryMissLine(res);
      if (miss) setReceipt({ from: "pick", line: miss });
      await refetchAll();
    } catch (e) {
      setError(errText(e));
    } finally {
      setPicking(null);
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!item || !body || sending) return;
    setSending(true);
    setError(null);
    setReceipt(null);
    try {
      const res = await commentFeedback(item.id, body);
      setDraft("");
      const miss = deliveryMissLine(res);
      if (miss) setReceipt({ from: "text", line: miss });
      await refetchAll();
    } catch (e) {
      setError(errText(e));
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (next: FeedbackStatus) => {
    setMenu(null);
    if (!item || busy) return;
    if (next === "answered") {
      setSheet("agreed");
      return;
    }
    if (next === status) return;
    setBusy(true);
    setError(null);
    try {
      await resolveFeedback(item.id, next);
      await refetchAll();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const assignees = item?.assignees ?? [];
  const menuStatuses: readonly FeedbackStatus[] = linked
    ? SETTABLE_STATUSES
    : ["resolved", "dismissed"];
  const sendReady = Boolean(draft.trim()) && !sending;

  return (
    <div
      className="absolute inset-0 flex flex-col min-w-0 overflow-x-hidden"
      style={{
        background: "#000",
        zIndex: 8,
        paddingTop: "env(safe-area-inset-top)",
        fontFamily: "var(--zen-font)",
      }}
      data-testid="ticket-view"
    >
      <header className="shrink-0 relative" style={{ padding: "12px 12px 10px" }}>
        <div className="flex items-center justify-between relative">
          <button
            type="button"
            data-testid="ticket-back"
            className="text-[17px] zen-glass zen-glass-pill"
            style={{ minHeight: PILL_H, padding: "0 14px 0 10px", color: "#fff" }}
            onClick={onBack}
          >
            ‹ Tickets
          </button>
          <div className="relative">
            <button
              type="button"
              data-testid="ticket-more"
              aria-label="More"
              disabled={!item || (!linked && !doc)}
              className="flex items-center justify-center zen-glass zen-glass-pill text-[18px] disabled:opacity-40"
              style={{ width: PILL_H, height: PILL_H, color: "#fff" }}
              onClick={() => setMenu(menu === "more" ? null : "more")}
            >
              ⋯
            </button>
            {menu === "more" && item ? (
              <Menu align="right" onClose={() => setMenu(null)} testId="ticket-more-menu">
                {linked ? (
                  <MenuItem
                    testId="ticket-reassign-item"
                    onClick={() => {
                      setMenu(null);
                      setSheet("reassign");
                    }}
                  >
                    Reassign
                  </MenuItem>
                ) : null}
                {doc ? (
                  <MenuItem
                    onClick={() => {
                      setMenu(null);
                      setReader(true);
                    }}
                  >
                    Read full brief
                  </MenuItem>
                ) : null}
              </Menu>
            ) : null}
          </div>
        </div>
        <h1
          className="mt-3 text-[20px] font-semibold leading-tight line-clamp-2 break-words [overflow-wrap:anywhere]"
          data-testid="ticket-title"
        >
          {item?.title ?? "Ticket"}
        </h1>
        {item ? (
          <div
            className="mt-1.5 flex items-center flex-wrap gap-x-2 gap-y-1 text-[13px] min-w-0"
            style={{ color: "#8e8e93" }}
          >
            <span className="relative">
              <button
                type="button"
                data-testid="ticket-status"
                disabled={busy}
                onClick={() => setMenu(menu === "status" ? null : "status")}
                className="bg-transparent border-0 p-0 inline-flex items-center gap-1"
              >
                <StatusChip status={status} />
                <span aria-hidden style={{ color: statusColor(status), fontSize: 10 }}>
                  ▾
                </span>
              </button>
              {menu === "status" ? (
                <Menu align="left" onClose={() => setMenu(null)} testId="ticket-status-menu">
                  {menuStatuses.map((s) => (
                    <MenuItem
                      key={s}
                      testId={`status-${s}`}
                      checked={s === status}
                      onClick={() => void setStatus(s)}
                    >
                      <StatusChip status={s} />
                    </MenuItem>
                  ))}
                </Menu>
              ) : null}
            </span>
            <span>·</span>
            <span className="tabular-nums">P{item.priority || 3}</span>
            <span>·</span>
            <span className="min-w-0 truncate" data-testid="ticket-people">
              <b className="font-semibold" style={{ color: "#d1d1d6" }}>
                {item.agentName}
              </b>{" "}
              → {assignees.length ? assignees.join(", ") : "unassigned"}
            </span>
            <span>·</span>
            <span>{ago(item.createdAt)}</span>
          </div>
        ) : null}
      </header>

      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 pb-3 flex flex-col gap-3"
        data-testid="ticket-scroller"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {openError && !item ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <p className="text-[14px] text-center" style={{ color: "var(--warning)" }}>
              {asErrorText(openError)}
            </p>
            <button
              type="button"
              className="text-[15px] zen-glass zen-glass-pill"
              style={{ minHeight: PILL_H, padding: "0 16px", color: "#fff" }}
              onClick={() => void useFeedbackStore.getState().openThread(id, { withBrief: true })}
            >
              Retry
            </button>
          </div>
        ) : !item ? (
          <p className="py-10 text-center text-[14px]" style={{ color: "#8e8e93" }}>
            Loading ticket…
          </p>
        ) : (
          <>
            <BriefCard
              hasBrief={hasBrief}
              entry={entry}
              body={item.body}
              title={item.title}
              onRead={() => setReader(true)}
            />

            {options.length > 0 && linked ? (
              <section
                className="k2-tile"
                style={{ borderRadius: 16, padding: "12px 14px 14px" }}
                data-testid="answer-card"
              >
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider mb-2"
                  style={{ color: "#8e8e93" }}
                >
                  {closed ? "Options" : "Answer"}
                </div>
                <AnswerPills
                  options={options}
                  answer={item.answer}
                  active={pillsActive}
                  sending={picking}
                  onPick={(a) => void pick(a)}
                />
                {picking !== null ? (
                  <p className="mt-2 text-[13px]" style={{ color: "#8e8e93" }}>
                    Sending…
                  </p>
                ) : receipt?.from === "pick" ? (
                  <p className="mt-2 text-[13px]" style={{ color: "var(--warning)" }} data-testid="delivery-miss">
                    {receipt.line}
                  </p>
                ) : null}
              </section>
            ) : null}

            {item.comments.length > 0 ? (
              <div className="flex flex-col gap-1 pt-1" data-testid="ticket-comments">
                {item.comments.map((c, i) => {
                  const mine = isMyAuthor(c.author, identity);
                  return (
                    <div
                      key={`${c.at}-${i}`}
                      data-testid="ticket-comment"
                      data-mine={mine ? "1" : "0"}
                      className={`flex flex-col max-w-[82%] min-w-0 ${mine ? "self-end items-end" : "self-start items-start"}`}
                    >
                      {!mine ? (
                        <span className="text-[11px] px-3 mb-0.5" style={{ color: "#8e8e93" }}>
                          {c.author}
                        </span>
                      ) : null}
                      <div
                        className="px-3 py-2 leading-snug break-words min-w-0 max-w-full overflow-hidden"
                        style={{
                          // Settings → Text Size.
                          fontSize: zenTextPx(17),
                          borderRadius: 18,
                          background: mine ? "#0a84ff" : "#3a3a3c",
                          color: "#fff",
                        }}
                      >
                        <ChatMessageBody
                          text={c.body}
                          className="!p-0 text-white"
                          style={{ color: "#fff", fontSize: zenTextPx(14) }}
                        />
                      </div>
                      <span className="text-[11px] px-2 mt-0.5" style={{ color: "#8e8e93" }}>
                        {mine ? "You · " : ""}
                        {ago(c.at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>

      {!item ? null : linked ? (
        // .zen-composer-bar: the home-indicator inset collapses while typing
        // (the Chats column is already sized to the visual viewport).
        <div className="shrink-0 min-w-0 w-full overflow-hidden px-3 pt-2 zen-composer-bar">
          {error || sending || receipt?.from === "text" ? (
            <p
              className="text-[11px] leading-snug break-words mb-1.5"
              style={{ color: error || receipt ? "var(--warning)" : "var(--text-muted)" }}
              data-testid="ticket-composer-label"
              role={error ? "alert" : undefined}
            >
              {error ? error : sending ? "Sending…" : receipt?.line}
            </p>
          ) : null}
          <form
            className="flex items-end min-w-0"
            data-testid="ticket-composer"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void send();
            }}
          >
            <div
              className="flex-1 min-w-0 overflow-hidden flex items-end gap-1 rounded-[20px] pl-3 pr-1 py-1 k2-tile"
            >
              <textarea
                ref={composerRef}
                value={draft}
                rows={1}
                disabled={sending}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Pick an option to answer, or write a message to start a discussion"
                aria-label="Message"
                data-testid="ticket-composer-input"
                className="flex-1 min-w-0 w-full resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-transparent border-0 text-[var(--text)] outline-none py-1"
                style={{
                  maxHeight: COMPOSER_MAX_PX,
                  fontSize: zenTextPx(17),
                  lineHeight: zenTextPx(22),
                }}
              />
              <button
                type="submit"
                aria-label="Send"
                data-testid="ticket-composer-send"
                disabled={!sendReady}
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                className={`shrink-0 flex items-center justify-center k2-tile ${
                  sendReady ? "text-white" : "k2-tile-raised text-[var(--text-muted)] opacity-60"
                }`}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  ...(sendReady ? { background: "#0a84ff", borderColor: "#0a84ff" } : {}),
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
            </div>
          </form>
        </div>
      ) : (
        <div
          className="shrink-0 px-3 pt-3"
          style={{
            paddingBottom: "max(10px, env(safe-area-inset-bottom))",
            borderTop: "0.5px solid rgba(255,255,255,0.12)",
          }}
          data-testid="ticket-unlinked-footer"
        >
          <p className="text-[13px] mb-2" style={{ color: "#8e8e93" }}>
            This ticket's workspace was removed. It's read-only.
          </p>
          {error ? (
            <p className="text-[12px] mb-2" style={{ color: "var(--warning)" }} role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="ticket-resolve"
              disabled={busy || status === "resolved"}
              onClick={() => void setStatus("resolved")}
              className="flex-1 text-[16px] k2-tile disabled:opacity-50"
              style={{ height: 40, borderRadius: 20, color: "#fff" }}
            >
              Resolve
            </button>
            <button
              type="button"
              data-testid="ticket-dismiss"
              disabled={busy || status === "dismissed"}
              onClick={() => void setStatus("dismissed")}
              className="flex-1 text-[16px] k2-tile disabled:opacity-50"
              style={{ height: 40, borderRadius: 20, color: "#8e8e93" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {reader && doc && item ? (
        <BriefReader
          doc={doc}
          title={item.title}
          onClose={() => setReader(false)}
          footer={
            options.length > 0 && linked ? (
              <div>
                <AnswerPills
                  options={options}
                  answer={item.answer}
                  active={pillsActive}
                  sending={picking}
                  onPick={(a) => void pick(a)}
                />
                {picking !== null ? (
                  <p className="mt-1.5 text-[13px]" style={{ color: "#8e8e93" }}>
                    Sending…
                  </p>
                ) : receipt?.from === "pick" ? (
                  <p className="mt-1.5 text-[13px]" style={{ color: "var(--warning)" }}>
                    {receipt.line}
                  </p>
                ) : null}
              </div>
            ) : null
          }
        />
      ) : null}
      {sheet === "reassign" && item ? (
        <ReassignSheet item={item} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "agreed" && item ? <AgreedSheet item={item} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
