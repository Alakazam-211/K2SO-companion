import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  type FeedbackComment,
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
import { GlassComposer } from "./GlassComposer";
import { NEW_BELOW_SETTLE_MS, threadBottomPadding } from "./ThreadPane";
import {
  FOOTER_BLUR_FADE_PX,
  underHeaderPadding,
  useMeasuredHeight,
  ZenFooterBlur,
  ZenHeaderBlur,
} from "./ZenHeaderBlur";
import { zenTextPx } from "./zenFont";
import { ticketsScope, useTicketsScope } from "./zenScope";
import { mountainTime } from "./threadModel";
import { nearNewest, stickToNewest, type MessageAnchor } from "./threadScroll";
import {
  fontPxOf,
  glideList,
  prefersReducedMotion,
  rectOf,
  runSendFly,
  type FlySource,
} from "./sendFly";
import "./sendFly.css";
import {
  commentInFlight,
  commentRowId,
  ticketRoomKey,
  ticketRows,
  type OutgoingComment,
} from "./ticketOutbox";
import { composerDraftOf, ticketDraftKey, useComposerDrafts } from "./composerDrafts";
import { useBackHandler } from "../lib/androidBack";
import { useSwipeBack } from "../lib/useSwipeBack";

// Zen open ticket — Layout A (Rosson, 2026-10-11). Full-screen inside the
// Chats column, below the notch, the ThreadPane look:
//
//   header   floats over the scroll with the chat header's progressive
//            blur (c39c0ac); glass ‹ Tickets pill + ⋯ (Reassign); title (2 lines); meta:
//            status chip (a menu) · P# · agent → assignees · age
//   scroll   brief card (TicketBrief) → answer card (quick-answer pills)
//            → comments as iMessage bubbles
//   bottom   ThreadPane's GlassComposer (no attach) — or, for a ticket
//            whose workspace was removed, a Resolve / Dismiss footer —
//            floating over the scroll on the footer blur (7cbf584): the
//            conversation passes under it and softens
//
// A typed comment is optimistic, the Thread's send (9e6694e): the bubble
// takes its final slot at once (dimmed, "Sending…"), the text flies into
// it from the composer (sendFly), the list glides up once, and the
// server's copy keeps the same row (ticketOutbox), which only brightens.
// A failed send stays as "Not sent · Retry / Edit". The draft is kept per
// ticket (composerDrafts `<server>|ticket:<id>`).
//
// Answering (0.43.2+): a pill sends `comment {id, body, optionPick:true}`
// (→ answered, the agent hears it); typed text sends `comment {id, body}`
// (→ needs_discussion). Never `author`. "Answered" from the status menu
// asks "What was agreed?" and sends `resolve answered+answer`, which the
// agent does NOT hear. The brief is loaded once (store cache); every
// refetch here is a plain `show`.

const PILL_H = 34;
/** Resting floating-header height below the safe area: pills, a two-line
 *  title and the meta line. Measured for real once mounted. */
export const TICKET_HEADER_PX = 140;
/** Air between the header's bottom edge and the first card. */
const TICKET_TOP_GAP = 4;

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
  useBackHandler(true, onClose);
  return (
    <div className="absolute inset-0 flex flex-col justify-end" style={{ zIndex: 14 }} data-testid={testId}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose} />
      <div
        className="relative k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderRadius: "16px 16px 0 0",
          maxHeight: "80%",
          paddingBottom: "max(12px, var(--safe-bottom))",
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
    void fetchTicketUsers(ticketsScope())
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
      await assignFeedback(ticketsScope(), item.id, picked);
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
      await resolveFeedback(ticketsScope(), item.id, "answered", answer);
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
  useBackHandler(true, onClose);
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

const NO_COMMENTS: FeedbackComment[] = [];

/** One row of the ticket's conversation: a server comment, or a send the
 *  server has not shown back yet (`out`). */
type CommentRow = {
  key: string;
  author: string;
  body: string;
  at: number;
  mine: boolean;
  out: OutgoingComment | null;
};

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
  const outbox = useFeedbackStore((s) => s.commentOutbox);
  const landedKeys = useFeedbackStore((s) => s.commentLandedKeys);
  const scope = useTicketsScope();
  const identity = useSessionIdentity(scope);
  const [menu, setMenu] = useState<"status" | "more" | null>(null);
  const [sheet, setSheet] = useState<"reassign" | "agreed" | null>(null);
  const [reader, setReader] = useState(false);
  // The comment composer's text, kept per ticket (composerDrafts): going
  // back to the list or relaunching and coming back puts it back.
  const draftKey = ticketDraftKey(scope.id, id);
  const [draft, setDraftText] = useState(() => composerDraftOf(draftKey));
  function setDraft(text: string) {
    setDraftText(text);
    useComposerDrafts.getState().setDraft(draftKey, text);
  }
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Delivery miss after the last comment, and where it came from. */
  const [receipt, setReceipt] = useState<{ from: "pick" | "text"; line: string } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [headerRef, headerPx] = useMeasuredHeight(TICKET_HEADER_PX);
  // At rest the brief card sits just under the header and stays sharp;
  // the heavy blur's strip below the header waits for a scroll.
  const [scrolled, setScrolled] = useState(false);
  // Android Back = the header's back chevron. Menus, sheets and the
  // brief reader open later and register on top.
  const onTop = useBackHandler(true, onBack);
  // The left-edge swipe is that chevron too, only while nothing (menu,
  // sheet, brief reader) sits over the ticket. The root is a clean
  // transform target; the Tickets list shows underneath during the drag.
  const swipeRef = useSwipeBack(onBack, { enabled: onTop });

  // The floating dock's height (composer block or the unlinked footer,
  // safe area / keyboard gap included): the scroller pads its bottom by
  // it, so the newest comment can rest right above the field.
  const [dockPx, setDockPx] = useState(0);
  const dockPxRef = useRef<number | null>(null);
  // FOLLOWING the newest comment: null until the reader scrolls (a fresh
  // ticket opens on the brief, not the tail); true at the bottom or after
  // Send; false once they scroll up.
  const following = useRef<boolean | null>(null);
  const lastTop = useRef(0);
  // Not following and someone else commented: the "New comment ↓" pill.
  const [newBelow, setNewBelow] = useState(false);
  // The send animation: which bubble is flying in, and from where (the
  // Thread's, 9e6694e). The row keeps this key once the server's copy
  // lands, so the same element flies, waits and brightens.
  const [fly, setFly] = useState<{
    localId: string;
    source: FlySource | null;
    /** Reduced motion / no Web Animations: fade instead of fly. */
    fade: boolean;
    /** The newest row and its top before Send: how far the list moves. */
    anchor: MessageAnchor | null;
  } | null>(null);
  const stopGlide = useRef<() => void>(() => {});

  const brief = entry?.state === "ready" ? entry.brief : null;
  const doc = useBriefDoc(brief);
  const hasBrief = item?.hasBrief === true;

  // A deep-linked or refetched ticket that turns out to have a brief:
  // load it once (never again on a later refetch — the cache holds it).
  useEffect(() => {
    if (item && item.hasBrief && !entry) void useFeedbackStore.getState().loadBrief(item.id);
  }, [item, entry]);

  useLayoutEffect(() => {
    setDraftText(composerDraftOf(draftKey));
  }, [draftKey]);

  // Typing is written to storage after a short quiet; leaving the ticket
  // or the app going to the background writes it now.
  useEffect(() => {
    const flush = () => useComposerDrafts.getState().flush();
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // One list, one key per comment: a send's row is keyed by its localId
  // from tap to delivered (the server's copy inherits it).
  const roomKey = ticketRoomKey(scope.id, id);
  const comments = item?.comments ?? NO_COMMENTS;
  const isMine = (author: string) => isMyAuthor(author, identity);
  const { keys: rowKeys, landedNow, visible: outgoing } = ticketRows(
    outbox,
    comments,
    roomKey,
    landedKeys,
    isMine
  );
  const rows: CommentRow[] = comments.map((c, i) => ({
    key: rowKeys.get(i) ?? `c:${commentRowId(c, i)}`,
    author: c.author,
    body: c.body,
    at: c.at,
    mine: rowKeys.has(i) || isMine(c.author),
    out: null,
  }));
  for (const o of outgoing) {
    rows.push({ key: o.localId, author: "", body: o.text, at: o.at, mine: true, out: o });
  }
  const inFlight = commentInFlight(outbox, roomKey);

  // A send that showed up in `show`: remember its row key, drop the entry.
  const landedSig = landedNow.map((l) => `${l.localId}>${l.rowId}`).join(",");
  useEffect(() => {
    for (const l of landedNow) useFeedbackStore.getState().settleComment(l.localId, l.rowId);
    // landedNow is derived from the store each render; its signature is enough.
  }, [landedSig]);

  function setFollowing(on: boolean) {
    following.current = on;
    if (on) setNewBelow(false);
  }

  // New comments: keep the newest in view while following (or, before the
  // reader has scrolled, when near the tail); otherwise offer the pill.
  const commentCount = comments.length;
  const prevCount = useRef<{ id: string; count: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !item) {
      prevCount.current = null;
      return;
    }
    const prev = prevCount.current;
    prevCount.current = { id, count: commentCount };
    if (!prev || prev.id !== id || commentCount <= prev.count) return;
    const follow =
      following.current ?? el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (follow) {
      following.current = true;
      stickToNewest(el);
      return;
    }
    const newestIdx = commentCount - 1;
    const newestMine = rowKeys.has(newestIdx) || isMine(comments[newestIdx].author);
    if (!newestMine) setNewBelow(true);
  }, [commentCount, id, item != null]);

  // The dock floats over the scroller's bottom: measure it (it grows with
  // the field's lines, the label line, the keyboard gap).
  const hasDock = item != null;
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const read = () => {
      const px = dock.offsetHeight;
      if (px === dockPxRef.current) return;
      dockPxRef.current = px;
      setDockPx(px);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [hasDock, linked]);

  // The new bottom padding is in the DOM: keep the newest above the field.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && following.current) stickToNewest(el);
  }, [dockPx]);

  // The keyboard opening/closing resizes the column (and the scroller):
  // re-stick when following.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === h) return;
      h = el.clientHeight;
      if (following.current) stickToNewest(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      const res = await commentFeedback(ticketsScope(), item.id, answer, { optionPick: true });
      const miss = deliveryMissLine(res);
      if (miss) setReceipt({ from: "pick", line: miss });
      await refetchAll();
    } catch (e) {
      setError(errText(e));
    } finally {
      setPicking(null);
    }
  };

  /** POST an outgoing comment. A failure leaves its bubble "Not sent". */
  async function deliver(localId: string) {
    const store = useFeedbackStore.getState;
    const o = store().commentOutbox.find((x) => x.localId === localId);
    if (!o) return;
    store().patchComment(localId, { status: "sending", error: null });
    setError(null);
    try {
      const res = await commentFeedback(ticketsScope(), id, o.text);
      store().patchComment(localId, { status: "sent", author: res.author || null });
      const miss = deliveryMissLine(res);
      if (miss) setReceipt({ from: "text", line: miss });
    } catch (e) {
      const msg = errText(e);
      store().patchComment(localId, { status: "failed", error: msg });
      setError(msg);
      return;
    }
    await refetchAll();
  }

  /** Send tap: clear the field at once (focus and keyboard stay), show the
   *  bubble "Sending…", fly the text into it, POST behind it. */
  function onSend() {
    if (!item || !linked) return;
    const body = draft.trim();
    if (!body) return;
    const st = useFeedbackStore.getState();
    if (commentInFlight(st.commentOutbox, roomKey)) return;
    // Where the text sits now, before it is cleared (the FLIP "first").
    const field = composerRef.current;
    const rect = rectOf(field);
    const fontPx = fontPxOf(field);
    // The newest row's top now: after the new row is in, how far it moved.
    const rowsNow = scrollerRef.current?.querySelectorAll<HTMLElement>("[data-ticket-msg]");
    const lastRow =
      rowsNow && rowsNow.length
        ? rowsNow[rowsNow.length - 1]
        : (contentRef.current?.lastElementChild as HTMLElement | null | undefined) ?? null;
    const anchorRect = rectOf(lastRow);
    const anchor = lastRow && anchorRect ? { el: lastRow, top: anchorRect.top } : null;
    setDraft("");
    setError(null);
    setReceipt(null);
    const localId = st.queueComment({ roomKey, text: body, beforeCount: comments.length });
    const canFly =
      !prefersReducedMotion() &&
      rect != null &&
      typeof Element !== "undefined" &&
      typeof Element.prototype.animate === "function";
    setFly({
      localId,
      source: canFly ? { rect, fontPx: Number.isFinite(fontPx) ? fontPx : 17 } : null,
      fade: !canFly,
      anchor: canFly ? anchor : null,
    });
    // The reader just spoke: the reply must come into view.
    setFollowing(true);
    composerRef.current?.focus({ preventScroll: true });
    void deliver(localId);
  }

  function onRetry(localId: string) {
    if (commentInFlight(useFeedbackStore.getState().commentOutbox, roomKey)) return;
    void deliver(localId);
  }

  /** "Not sent" → back into an empty composer (the bubble goes). */
  function onRestore(o: OutgoingComment) {
    if (draft.trim()) return;
    setDraft(o.text);
    setError(null);
    useFeedbackStore.getState().dropComment(o.localId);
    composerRef.current?.focus({ preventScroll: true });
  }

  /** "New comment ↓": glide to the newest and follow again (the Thread's
   *  pill); jump the rest if WKWebView dropped the smooth scroll. */
  function onNewBelow() {
    const el = scrollerRef.current;
    setFollowing(true);
    if (!el) return;
    if (typeof el.scrollTo === "function" && !prefersReducedMotion()) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => {
        const cur = scrollerRef.current;
        if (cur && following.current && !nearNewest(cur)) stickToNewest(cur);
      }, NEW_BELOW_SETTLE_MS);
    } else {
      stickToNewest(el);
    }
  }

  const flyKey = fly ? fly.localId : "";

  // FLIP "last/invert/play". The row is in its final slot (hidden while it
  // flies); the composer has already shrunk back to one empty line.
  useLayoutEffect(() => {
    if (!fly) return;
    const lid = fly.localId;
    const clear = () => setFly((cur) => (cur?.localId === lid ? null : cur));
    setFollowing(true);
    const el = scrollerRef.current;
    const root = swipeRef.current;
    // The cleared field shrank the dock in this commit, but its
    // ResizeObserver reports a frame later: take the new height now so the
    // slot is final before the bubble is aimed.
    const dock = dockRef.current;
    if (el && dock && dock.offsetHeight > 0 && dock.offsetHeight !== dockPxRef.current) {
      dockPxRef.current = dock.offsetHeight;
      el.style.paddingBottom = threadBottomPadding(dock.offsetHeight, 0);
      setDockPx(dock.offsetHeight);
    }
    if (el) stickToNewest(el);
    if (fly.fade || !fly.source) {
      const t = setTimeout(clear, 220);
      return () => clearTimeout(t);
    }
    const target = () => root?.querySelector<HTMLElement>('[data-fly-target="true"]') ?? null;
    const bubble = target();
    if (!root || !bubble) {
      clear();
      return;
    }
    // The list makes room as the bubble comes in, rather than jumping.
    const a = fly.anchor;
    const now = a && a.el.isConnected ? rectOf(a.el) : null;
    const dy = a && now ? a.top - now.top : 0;
    stopGlide.current();
    stopGlide.current =
      el && dy >= 1 && dy <= el.clientHeight ? glideList(contentRef.current, dy) : () => {};
    return runSendFly({ root, bubble, target, source: fly.source, done: clear });
    // Once per send: a re-render mid-flight must not restart it.
  }, [flyKey]);

  useEffect(() => () => stopGlide.current(), []);

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
      await resolveFeedback(ticketsScope(), item.id, next);
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
  const sendReady = Boolean(draft.trim()) && !inFlight;
  const composerLabel = error ?? (receipt?.from === "text" ? receipt.line : null);

  return (
    <div
      ref={swipeRef}
      className="absolute inset-0 flex flex-col min-w-0 overflow-x-hidden"
      style={{
        background: "#000",
        zIndex: 8,
        fontFamily: "var(--zen-font)",
      }}
      data-testid="ticket-view"
    >
      {/* Floats over the conversation from y=0. The blur and the header box
          pass touches through; only the pills, the status chip and their
          menus take them. Under the brief reader (12) and sheets (14). */}
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="ticket-header"
        style={{
          zIndex: 10,
          paddingTop: "env(safe-area-inset-top)",
          pointerEvents: "none",
        }}
        data-scrolled={scrolled ? "1" : undefined}
      >
      <ZenHeaderBlur testId="ticket-header-blur" variant="heavy" />
      <div
        ref={headerRef}
        className="relative w-full min-w-0"
        style={{ padding: "12px 12px 10px" }}
        data-testid="ticket-header-content"
      >
        <div className="flex items-center justify-between relative">
          <button
            type="button"
            data-testid="ticket-back"
            className="text-[17px] zen-glass zen-glass-pill"
            style={{ minHeight: PILL_H, padding: "0 14px 0 10px", color: "#fff", pointerEvents: "auto" }}
            onClick={onBack}
          >
            ‹ Tickets
          </button>
          <div className="relative" style={{ pointerEvents: "auto" }} data-testid="ticket-more-wrap">
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
          className="mt-3 text-[20px] font-semibold leading-tight line-clamp-2 break-words [overflow-wrap:anywhere] zen-header-text"
          data-testid="ticket-title"
        >
          {item?.title ?? "Ticket"}
        </h1>
        {item ? (
          <div
            className="mt-1.5 flex items-center flex-wrap gap-x-2 gap-y-1 text-[13px] min-w-0 zen-header-text"
            style={{ color: "#8e8e93" }}
          >
            <span className="relative" style={{ pointerEvents: "auto" }} data-testid="ticket-status-wrap">
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
      </div>
      </header>

      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3"
        data-testid="ticket-scroller"
        data-bottom-inset={dockPx}
        onScroll={(e) => {
          const el = e.currentTarget;
          const top = el.scrollTop;
          setScrolled(top > 0);
          const prev = lastTop.current;
          lastTop.current = top;
          if (nearNewest(el)) setFollowing(true);
          else if (top < prev - 1) following.current = false;
        }}
        style={{
          overflowAnchor: "none",
          // Starts under the floating header; the conversation scrolls up
          // behind it.
          paddingTop: underHeaderPadding(headerPx, TICKET_TOP_GAP),
          // And on under the floating composer: its block plus 12px of air,
          // so the newest comment rests right above the field.
          paddingBottom: threadBottomPadding(dockPx, 0),
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div ref={contentRef} className="min-w-0 flex flex-col gap-3" data-testid="ticket-content">
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

            {rows.length > 0 ? (
              <div className="flex flex-col gap-1 pt-1" data-testid="ticket-comments">
                {rows.map((r) => {
                  const out = r.out;
                  const flying = fly?.localId === r.key;
                  const hidden = flying && !fly?.fade;
                  return (
                    <div
                      key={r.key}
                      data-ticket-msg=""
                      data-testid="ticket-comment"
                      data-mine={r.mine ? "1" : "0"}
                      data-outgoing={out?.status}
                      className={`flex flex-col max-w-[82%] min-w-0 ${r.mine ? "self-end items-end" : "self-start items-start"}`}
                    >
                      {/* Theirs: name • time above the bubble (the Thread's
                          meta line). Mine: the status line below. */}
                      {!r.mine ? (
                        <span
                          className="flex items-baseline gap-1.5 text-[11px] px-3 mb-0.5 min-w-0 max-w-full"
                          style={{ color: "#8e8e93" }}
                          data-testid="ticket-comment-meta"
                        >
                          <span className="truncate min-w-0">{r.author}</span>
                          <span className="shrink-0" aria-hidden>
                            •
                          </span>
                          <span className="shrink-0" data-testid="ticket-comment-time">
                            {mountainTime(r.at)}
                          </span>
                        </span>
                      ) : null}
                      <div
                        className={`px-3 py-2 leading-snug break-words min-w-0 max-w-full overflow-hidden${flying && fly?.fade ? " zen-bubble-fade" : ""}`}
                        data-testid="ticket-bubble"
                        data-fly-target={hidden ? "true" : undefined}
                        style={{
                          visibility: hidden ? "hidden" : undefined,
                          // Settings → Text Size.
                          fontSize: zenTextPx(17),
                          borderRadius: 18,
                          background: r.mine ? "#0a84ff" : "#3a3a3c",
                          color: "#fff",
                          // Sending: dimmed. Delivered: it only brightens.
                          opacity: out?.status === "sending" ? 0.7 : 1,
                          transition: "opacity 240ms ease-out",
                        }}
                      >
                        <ChatMessageBody
                          text={r.body}
                          className="!p-0 text-white"
                          style={{ color: "#fff", fontSize: zenTextPx(14) }}
                        />
                      </div>
                      {r.mine ? (
                        // One box from Send to delivered: "Sending…", then the
                        // time (or "Not sent · Retry"). Fixed height, so the
                        // swap never moves the bubble or the rows around it.
                        <span
                          className="flex items-center gap-2 h-4 leading-4 whitespace-nowrap text-[11px] px-2 mt-0.5"
                          style={{ color: "#8e8e93" }}
                          data-testid="ticket-comment-status"
                          data-status={out?.status ?? "sent"}
                        >
                          {out?.status === "failed" ? (
                            <span className="contents" data-testid="comment-failed">
                              <button
                                type="button"
                                className="bg-transparent border-0 p-0"
                                style={{ color: "var(--warning)" }}
                                data-testid="comment-retry"
                                aria-label="Not sent. Tap to retry"
                                title={out.error || undefined}
                                onClick={() => onRetry(out.localId)}
                              >
                                Not sent · Retry
                              </button>
                              {!draft.trim() ? (
                                <button
                                  type="button"
                                  className="bg-transparent border-0 p-0"
                                  style={{ color: "#8e8e93" }}
                                  data-testid="comment-restore"
                                  onClick={() => onRestore(out)}
                                >
                                  Edit
                                </button>
                              ) : null}
                            </span>
                          ) : out?.status === "sending" ? (
                            "Sending…"
                          ) : (
                            mountainTime(r.at)
                          )}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
        </div>
      </div>

      {!item ? null : (
        // Floats over the scroller's bottom on the header's blur stack
        // flipped (the Thread's dock): comments pass under it and soften.
        // The column is sized to the visual viewport, so bottom 0 is the
        // keyboard's top while typing.
        <div
          ref={dockRef}
          className="absolute left-0 right-0 bottom-0"
          style={{ zIndex: 2 }}
          data-testid="ticket-footer-dock"
        >
          <ZenFooterBlur
            testId="ticket-footer-blur"
            style={{ left: 0, right: 0, bottom: 0, top: -FOOTER_BLUR_FADE_PX }}
          />
          {/* Zero-height row: the pill floats just above the composer. */}
          <div className="relative h-0 shrink-0" style={{ zIndex: 1 }}>
            <div
              aria-live="polite"
              className="absolute left-0 right-0 flex justify-center pointer-events-none"
              style={{ bottom: 8 }}
            >
              {newBelow ? (
                <button
                  type="button"
                  data-testid="ticket-new-comment"
                  className="pointer-events-auto zen-glass zen-glass-pill text-[13px]"
                  style={{ minHeight: 32, padding: "0 14px", color: "#fff" }}
                  // Keep the keyboard up (send button pattern).
                  onPointerDown={(e) => e.preventDefault()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onNewBelow}
                >
                  New comment <span aria-hidden="true">↓</span>
                </button>
              ) : null}
            </div>
          </div>
          {/* Above the blur (positioned, z 0): its own stacking layer. */}
          <div className="relative" style={{ zIndex: 1 }}>
            {linked ? (
              <GlassComposer
                value={draft}
                onChange={setDraft}
                onSubmit={onSend}
                placeholder="Pick an option to answer, or write a message to start a discussion"
                ariaLabel="Message"
                canSend
                attach={false}
                sendReady={sendReady}
                textareaRef={composerRef}
                testIdPrefix="ticket-composer"
                onFocus={() => {
                  const el = scrollerRef.current;
                  if (el && following.current) stickToNewest(el);
                }}
              >
                {composerLabel ? (
                  <p
                    className="text-[11px] leading-snug break-words mb-1.5"
                    style={{ color: "var(--warning)" }}
                    data-testid="ticket-composer-label"
                    role={error ? "alert" : undefined}
                  >
                    {composerLabel}
                  </p>
                ) : null}
              </GlassComposer>
            ) : (
              <div
                className="px-3 pt-3"
                style={{ paddingBottom: "max(10px, var(--safe-bottom))" }}
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
