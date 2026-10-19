import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { SENDING_OPACITY, useDeliverBrighten } from "./useDeliverBrighten";
import { chatRuns, receiptFor, receiptRow } from "./chatReceipt";
import { getThreadActivity, uploadFsBinary } from "../api/client";
import { ChatMessageBody } from "../components/ChatMessage";
import { asErrorText } from "../lib/apiError";
import {
  MAX_UPLOAD_BYTES,
  attachmentSendBody,
  fileToBase64,
  uploadDirOf,
  uploadFilename,
  workspaceHandleOf,
} from "./composerAttach";
import { loadGroupPoc, type GroupPoc } from "./groupPoc";
import {
  GlassComposer,
  composerBlockHeight,
  composerPlaceholder,
  type GlassComposerProps,
} from "./GlassComposer";
import { keyboardMotionMs, useViewportPadRef, type ViewportMotion } from "../lib/useViewportHeight";
import { useKeyboardFlip } from "../kit/mobileChat/useKeyboardFlip";
import { COMPOSER_FOCUSED_ATTR, useComposerFocusGap } from "../kit/mobileChat/useComposerFocusGap";
import { CHAT_CONTENT_CLASS, useScrollRoom } from "../kit/mobileChat/useScrollRoom";
import { useKeyboardDrag } from "../kit/mobileChat/useKeyboardDrag";
import { useTapToDismiss } from "../kit/mobileChat/useTapToDismiss";
import { FOOTER_BLUR_FADE_PX, ZenFooterBlur } from "./ZenHeaderBlur";
import { StubMark } from "./StubMark";
import { mountainTime, type ThreadMessage } from "./threadModel";
import {
  captureTopMessage,
  nearNewest,
  restoreTopMessage,
  stickToNewest,
  type MessageAnchor,
} from "./threadScroll";
import { connectOverlayEvents, type OverlayLiveHandle } from "./overlayEvents";
import { useNotifyPrefsStore } from "../stores/notifyPrefs";
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
import { SESSION_UNAVAILABLE } from "./sessionReturn";
import { zenTextPx } from "./zenFont";
import { useZenScope, zenScope } from "./zenScope";
import { useThreadFocusSeq } from "./threadFocus";
import { recentSentKey, useRecentFirstStore } from "./recentFirst";
import { composerDraftKey, composerDraftOf, useComposerDrafts } from "./composerDrafts";
import {
  landedRowKeys,
  outgoingBubble,
  sendInFlight,
  threadRoomKey,
  visibleOutgoing,
  type OutgoingMessage,
} from "./outbox";
import {
  flySourceOfField,
  fontPxOf,
  prefersReducedMotion,
  rectOf,
  runSendFly,
  type FlyMotion,
  type FlySource,
} from "./sendFly";
import {
  ARRIVAL_RECENT_MS,
  REPLY_FOLD_MS,
  arrivedRows,
  createListGlider,
  drawerMotion,
  fadeInRows,
  incomingMotion,
  type ListGlider,
} from "./listGlide";
import { queueSend, requeueIfUnreachable, shouldQueueSend, useQueuedSendFlush } from "./sendQueue";
import "./sendFly.css";
import "./chatBubbles.css";
import { newestSeenSeq, type RowRef } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { useMarkReadWhileViewing } from "./unreadRead";
import { MessageFiles, patchThreadFileState, useThreadFilesOn } from "./ThreadFiles";
import { AttachmentSheet, type OpenAttachment } from "./AttachmentSheet";
import { sameMessage } from "./threadCacheMerge";
import {
  WINDOW_EXTEND,
  WINDOW_IDLE_MS,
  WINDOW_KEEP_SCREENS,
  WINDOW_RESPAWN_SCREENS,
  WINDOW_ROWS,
  WINDOW_TRIM_MIN,
  measureRows,
  pinWindow,
  resolveWindow,
  spacerAbove,
  spacerBelow,
  windowAround,
  type ThreadWindow,
  type WindowRange,
} from "./threadWindow";
import type { ThreadAttachment } from "../api/threadAttachmentPure";

/** No workspace folder to upload into (no usable path / no PoC yet). */
const ATTACH_UNAVAILABLE = "Files need this chat's workspace folder.";

export { COMPOSER_MAX_PX, composerHeight } from "./GlassComposer";

/** `.chat-markdown`'s 14px, scaled by Settings → Text Size. */
const BUBBLE_TEXT_PX = 14;
/** How long the "New message ↓" glide gets before a jump finishes it. */
export const NEW_BELOW_SETTLE_MS = 450;
/** Progressive first paint: a chat that opens with more than this many
 *  messages draws its newest `PROGRESSIVE_FIRST` first and the rest on the
 *  next idle frame (prepended above, the view pinned to the bottom). */
export const PROGRESSIVE_MIN = 30;
export const PROGRESSIVE_FIRST = 15;

/** Same message as far as a row draws it (the store may hand over a new
 *  object for an unchanged message: a re-read, a cache swap). */
function sameRowMessage(a: ThreadMessage, b: ThreadMessage): boolean {
  return a === b || sameMessage(a, b);
}

/** Props equal, `m` by content: a row re-renders only when it changed. */
function sameRowProps<P extends { m: ThreadMessage }>(a: P, b: P): boolean {
  for (const k in a) {
    if (k === "m") {
      if (!sameRowMessage(a.m, b.m)) return false;
    } else if (!Object.is(a[k], b[k])) return false;
  }
  for (const k in b) if (!(k in a)) return false;
  return true;
}

/** The markdown body's style for a text size: one object per size, so the
 *  memoized body is not re-rendered for a new-but-equal style. */
type BodyStyle = { color: string; fontSize: string };
const bodyStyles = new Map<string, BodyStyle>();
function bubbleBodyStyle(): BodyStyle {
  const px = zenTextPx(BUBBLE_TEXT_PX);
  let st = bodyStyles.get(px);
  if (!st) {
    st = { color: "#fff", fontSize: px };
    bodyStyles.set(px, st);
  }
  return st;
}

const Bubble = memo(function Bubble({
  m,
  onFileLink,
  canAnswer,
  answerHeld,
  answering,
  answerError,
  onAnswer,
  attachments,
  flying,
  fadeIn,
  breathe,
  tail,
}: {
  m: ThreadMessage;
  onFileLink?: (ref: string) => void;
  canAnswer: boolean;
  /** A cached copy not yet confirmed: options look as usual but wait for
   *  the server's copy (the card may already be answered). */
  answerHeld?: boolean;
  answering: boolean;
  answerError: string | null;
  onAnswer: (id: string, option: string) => void;
  /** An outgoing bubble's files (uploads may still be running). */
  attachments?: readonly File[];
  /** Laid out but hidden while its send animation flies in. */
  flying?: boolean;
  /** Reduced motion: just fade in. */
  fadeIn?: boolean;
  /** Sending (landed, not yet delivered): a gentle opacity breathe. */
  breathe?: boolean;
  /** The last bubble of its run: an iMessage tail (chatBubbles.css). */
  tail?: "mine" | "theirs" | null;
}) {
  const secret = m.kind === "secret";
  const choice = secret ? null : m.choice;
  const answered =
    choice != null && choice.answer != null && String(choice.answer) !== "";
  const bubbleRef = useRef<HTMLDivElement>(null);
  const breathing = Boolean(breathe && m.pending && !flying && !fadeIn);
  useDeliverBrighten(bubbleRef, Boolean(m.pending), breathing, Boolean(flying));
  return (
    <div
      ref={bubbleRef}
      // Not overflow-hidden itself (the tail sits outside its box): the
      // content clips inside.
      className={`relative px-3 py-2 leading-snug break-words min-w-0 max-w-full${tail ? " zen-tail" : ""}${fadeIn ? " zen-bubble-fade" : breathing ? " zen-bubble-breathe" : ""}`}
      data-testid="thread-bubble"
      data-fly-target={flying ? "true" : undefined}
      data-tail={tail || undefined}
      style={{
        visibility: flying ? "hidden" : undefined,
        // Settings → Text Size; the markdown body below scales the same way.
        fontSize: zenTextPx(17),
        borderRadius: 18,
        background: m.mine ? "#0a84ff" : "#3a3a3c",
        ["--k2-bubble" as string]: m.mine ? "#0a84ff" : "#3a3a3c",
        color: "#fff",
        // Sending: dimmed. Delivered: it only brightens, gradually
        // (useDeliverBrighten); nothing moves.
        opacity: m.pending ? SENDING_OPACITY : 1,
      }}
    >
      <div className="min-w-0 max-w-full overflow-hidden" data-bubble-body="">
      {choice ? (
        <div>
          {choice.prompt ? (
            <ChatMessageBody
              text={choice.prompt}
              className="!p-0 text-white"
              style={bubbleBodyStyle()}
              onFileLink={onFileLink}
            />
          ) : null}
          {choice.options.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {choice.options.map((o) => {
                const picked = answered && choice.answer === o;
                const open = canAnswer && !answered && !answering && Boolean(m.id);
                const tappable = open && !answerHeld;
                return (
                  <button
                    key={o}
                    type="button"
                    disabled={!tappable}
                    aria-pressed={picked}
                    onClick={() => onAnswer(m.id, o)}
                    className="rounded-full px-3 py-1.5 text-[15px] leading-none border"
                    style={{
                      borderColor: picked ? "#fff" : "rgba(255,255,255,0.4)",
                      background: picked ? "#fff" : "transparent",
                      color: picked ? "#1c1c1e" : "#fff",
                      opacity: open || picked ? 1 : 0.55,
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
        <>
          {m.text.trim() ? (
            <ChatMessageBody
              text={m.text}
              className="!p-0 text-white"
              style={bubbleBodyStyle()}
              onFileLink={onFileLink}
            />
          ) : null}
          {attachments?.length ? (
            <div
              className={`flex flex-col gap-0.5 ${m.text.trim() ? "mt-1" : ""}`}
              data-testid="bubble-attachments"
            >
              {attachments.map((f, i) => (
                <span
                  key={`${uploadFilename(f)}-${i}`}
                  className="text-[13px] opacity-90 truncate"
                  data-testid="bubble-attachment"
                >
                  {uploadFilename(f)}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
      </div>
    </div>
  );
}, sameRowProps);

/** One message row: the meta line, the bubble, its files and the status
 *  / receipt line. Memoized: typing, the keyboard, activity frames and the
 *  drawer re-render the pane, not the rows that did not change. Every
 *  callback it gets is stable (ThreadPane's `stableHandler`). */
const ThreadRow = memo(function ThreadRow({
  rowKey,
  windowed,
  m,
  out,
  files,
  runFirst,
  runLast,
  spaced,
  stub,
  highlighted,
  receipt,
  canAnswer,
  answerHeld,
  answering,
  answerError,
  flying,
  fadeIn,
  canRestore,
  onFileLink,
  onAnswer,
  onRetry,
  onRestore,
  onOpenFile,
}: {
  rowKey: string;
  /** A thread message (in the render window), not an outgoing send. */
  windowed: boolean;
  m: ThreadMessage;
  out: OutgoingMessage | null;
  files: readonly ThreadAttachment[] | null;
  runFirst: boolean;
  runLast: boolean;
  /** First of a run, not the first row: a little space above. */
  spaced: boolean;
  stub: boolean;
  highlighted: boolean;
  /** The chat's one "Delivered" / "Read" receipt sits on this row. */
  receipt: string | undefined;
  canAnswer: boolean;
  answerHeld: boolean;
  answering: boolean;
  answerError: string | null;
  flying: boolean;
  fadeIn: boolean;
  /** A "Not sent" send can go back into the (empty) composer. */
  canRestore: boolean;
  onFileLink?: (ref: string) => void;
  onAnswer: (id: string, option: string) => void;
  onRetry: (localId: string) => void;
  onRestore: (o: OutgoingMessage) => void;
  onOpenFile: (m: ThreadMessage, a: ThreadAttachment) => void;
}) {
  const wordless = !m.text.trim() && !m.choice;
  const bubble = !(files && wordless);
  return (
    <div
      data-thread-msg=""
      data-row-key={rowKey}
      data-win-row={windowed ? "" : undefined}
      data-seq={m.seq ?? undefined}
      data-outgoing={out?.status}
      data-highlight={highlighted ? "true" : undefined}
      data-run={runFirst && runLast ? "solo" : runFirst ? "first" : runLast ? "last" : "middle"}
      className={`flex flex-col max-w-[78%] min-w-0 ${m.mine ? "self-end items-end" : "self-start items-start"}${spaced ? " mt-1.5" : ""}`}
      style={
        highlighted
          ? { borderRadius: 20, boxShadow: "0 0 0 2px rgba(10,132,255,.85)", transition: "box-shadow .4s" }
          : undefined
      }
    >
      {/* Theirs: name and time on one line above the first
          bubble of a run. Mine: no name; the time (or
          Sending… / Not sent, or the receipt) below the last
          of a run, where the outgoing status and its actions
          sit — and below any send still in progress. */}
      {!m.mine && runFirst ? (
        <span
          className="flex items-baseline gap-1.5 text-[11px] text-[var(--text-muted)] px-3 mb-0.5 min-w-0 max-w-full"
          data-testid="thread-msg-meta"
        >
          <span className="truncate min-w-0">
            {stub ? <StubMark /> : null}
            {m.from}
          </span>
          <span className="shrink-0" aria-hidden>
            •
          </span>
          <span className="shrink-0" data-testid="thread-msg-time">
            {m.failed ? "Not sent" : m.pending ? "Sending…" : mountainTime(m.at)}
          </span>
        </span>
      ) : null}
      {bubble ? (
        <Bubble
          m={m}
          onFileLink={onFileLink}
          canAnswer={canAnswer}
          answerHeld={answerHeld}
          answering={answering}
          answerError={answerError}
          onAnswer={onAnswer}
          attachments={out?.files.length ? out.files : undefined}
          flying={flying}
          fadeIn={fadeIn}
          breathe={out?.status === "sending"}
          tail={runLast ? (m.mine ? "mine" : "theirs") : null}
        />
      ) : null}
      {files ? (
        <MessageFiles
          files={files}
          mine={m.mine}
          hasBubble={bubble}
          onOpen={(a) => onOpenFile(m, a)}
        />
      ) : null}
      {m.mine && (runLast || out != null || m.pending || m.failed) ? (
        // One box from Send to delivered: "Sending…", then the
        // time (or "Not sent · Retry"), or the chat's one
        // receipt — "Delivered" / "Read", drawn over it by CSS
        // (chatBubbles.css). Fixed height, so no swap ever
        // moves the bubble or the rows around it.
        <span
          className="zen-receipt flex items-center gap-2 h-4 leading-4 whitespace-nowrap text-[11px] text-[var(--text-muted)] px-2 mt-0.5"
          data-testid="thread-msg-time"
          data-status={out?.status ?? (m.failed ? "failed" : m.pending ? "sending" : "sent")}
          data-receipt={receipt}
        >
          <span className="zen-receipt-status">
          {out?.status === "failed" ? (
            <span className="contents" data-testid="outgoing-failed">
              <button
                type="button"
                className="text-[var(--warning)]"
                data-testid="outgoing-retry"
                aria-label="Not sent. Tap to retry"
                title={out.error || undefined}
                onClick={() => onRetry(out.localId)}
              >
                Not sent · Retry
              </button>
              {canRestore ? (
                <button
                  type="button"
                  data-testid="outgoing-restore"
                  onClick={() => onRestore(out)}
                >
                  Edit
                </button>
              ) : null}
            </span>
          ) : out?.status === "queued" ? (
            "Waiting for connection…"
          ) : out ? (
            "Sending…"
          ) : m.failed ? (
            "Not sent"
          ) : m.pending ? (
            "Sending…"
          ) : (
            mountainTime(m.at)
          )}
          </span>
        </span>
      ) : null}
    </div>
  );
}, sameRowProps);

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

/** The scroller's own bottom padding (`py-3`). */
const THREAD_BOTTOM_PAD = 12;

/** The composer field's top inside its bar: the bar's `pt-2` plus the
 *  (empty) label row's `mb-1.5`. The drawer covers that much of the bar. */
export const COMPOSER_FIELD_TOP_PX = 8 + 6;

/** How far the working drawer (standing `drawerSpace` px on the field's
 *  top edge) reaches above the composer bar, into the scroller. With rows
 *  above the field (banner, label, chips) the bar keeps room for it
 *  instead, so it covers nothing. */
export function drawerOverScroller(drawerSpace: number, rowsAboveField: boolean): number {
  if (rowsAboveField || !Number.isFinite(drawerSpace)) return 0;
  return Math.max(0, drawerSpace - COMPOSER_FIELD_TOP_PX);
}

/** How far (px) the newest message rests above the pane's bottom, less
 *  the bar's safe-area / keyboard gap (the scroller's `.zen-composer-gap`
 *  spacer adds that, easing with the keyboard): the composer block
 *  floating over the scroller's bottom (rows above the field, the field)
 *  plus what the working drawer covers above the bar. */
export function threadBottomInset(composerPx: number, drawerCover: number): number {
  const block = Number.isFinite(composerPx) && composerPx > 0 ? Math.ceil(composerPx) : 0;
  const cover = Number.isFinite(drawerCover) && drawerCover > 0 ? Math.ceil(drawerCover) : 0;
  return block + cover;
}

/** Scroller bottom padding: its own, plus the floating composer block and
 *  what the working drawer covers. Messages scroll on under the composer's
 *  blur; at rest the newest sits right above the field. */
export function threadBottomPadding(composerPx: number, drawerCover: number): string {
  return `${THREAD_BOTTOM_PAD + threadBottomInset(composerPx, drawerCover)}px`;
}

export { COMPOSER_FOCUSED_ATTR };

/** The pane's handle on the composer's text (read on Send / Edit). */
type DraftApi = { get(): string; set(text: string): void };

/** GlassComposer holding the room's draft (kept per room, composerDrafts)
 *  in its own state: typing re-renders this, not the Thread around it.
 *  `onBlankChange` fires (in the same batch) only when the text turns
 *  blank or not blank. */
function ThreadDraftComposer({
  draftKey,
  apiRef,
  onBlankChange,
  hasAttachments,
  inFlight,
  ...props
}: Omit<GlassComposerProps, "value" | "onChange" | "sendReady"> & {
  draftKey: string | null;
  apiRef: RefObject<DraftApi | null>;
  onBlankChange: (blank: boolean) => void;
  hasAttachments: boolean;
  /** One send in flight per room: Send waits. */
  inFlight: boolean;
}) {
  const [draft, setDraftText] = useState(() => composerDraftOf(draftKey));
  const textRef = useRef(draft);
  const blankRef = useRef(!draft.trim());
  const keyRef = useRef(draftKey);
  keyRef.current = draftKey;
  const blankCb = useRef(onBlankChange);
  blankCb.current = onBlankChange;
  const show = useCallback((text: string) => {
    textRef.current = text;
    setDraftText(text);
    const blank = !text.trim();
    if (blank !== blankRef.current) {
      blankRef.current = blank;
      blankCb.current(blank);
    }
  }, []);
  const setDraft = useCallback(
    (text: string) => {
      show(text);
      useComposerDrafts.getState().setDraft(keyRef.current, text);
    },
    [show]
  );
  // Another room: its own draft.
  useLayoutEffect(() => {
    show(composerDraftOf(draftKey));
  }, [draftKey, show]);
  apiRef.current = { get: () => textRef.current, set: setDraft };
  const sendReady = (Boolean(draft.trim()) || hasAttachments) && !inFlight;
  return <GlassComposer {...props} value={draft} onChange={setDraft} sendReady={sendReady} />;
}

export function ThreadPane({
  viewportHeight,
  viewportMotion = null,
  viewportInteractive = false,
  topInset,
  covered = false,
  roomBanner = null,
  roomQueuesInput = false,
  onComposerInput,
}: {
  viewportHeight?: number;
  /** The keyboard is moving (iOS, useViewport().motion): the composer
   *  (and the list, if it moves) play it by a FLIP transform. */
  viewportMotion?: ViewportMotion | null;
  /** The keyboard follows a finger dragging the list (interactive
   *  dismiss): the column grows under it; never re-pin mid-drag. */
  viewportInteractive?: boolean;
  /** Height (px, below the safe area) of a header floating over the list. */
  topInset?: number;
  /** A full-screen overlay (file viewer) hides the Thread: not "viewing". */
  covered?: boolean;
  /** Multi-server room failure (MS36): shown above the composer; while
   *  set, input is off and the last messages stay. */
  roomBanner?: ReactNode;
  /** The banner is a server that is down (auto reconnect): input stays on
   *  and sends are queued until it is back. */
  roomQueuesInput?: boolean;
  /** A send in this room (the keep-alive's idle clock, MS24). */
  onComposerInput?: () => void;
} = {}) {
  const thread = useZenStore((s) => s.thread);
  const source = useZenStore((s) => s.threadSource);
  // A cached copy not yet confirmed by the server (stale-while-revalidate):
  // drawn as is, but nothing is marked read and no card is answered from it.
  const cachedOnly = useZenStore((s) => s.threadCached);
  // Opening a chat whose cache is known to be behind: the first paint
  // waits (briefly) for the read — nothing drawn meanwhile, no "Loading".
  const holding = useZenStore((s) => s.threadHolding);
  const error = useZenStore((s) => s.threadError);
  const agentId = useZenStore((s) => s.agentId);
  // Done mode (drawer-picked session): a Thread that won't open offers the main chat.
  const drawerOrigin = useZenStore((s) => s.drawerOrigin);
  const returnToDrawerOrigin = useZenStore((s) => s.returnToDrawerOrigin);
  const doneMode = Boolean(drawerOrigin) && drawerOrigin !== agentId;
  const hasMore = useZenStore((s) => s.threadHasMore);
  const loadingEarlier = useZenStore((s) => s.threadLoadingEarlier);
  const loadEarlier = useZenStore((s) => s.loadEarlier);
  const answerChoice = useZenStore((s) => s.answerChoice);
  const answeringId = useZenStore((s) => s.answeringId);
  const answerError = useZenStore((s) => s.answerError);
  const answerErrorId = useZenStore((s) => s.answerErrorId);
  const threadAddr = useZenStore((s) => s.threadAddr);
  const threadGroupId = useZenStore((s) => s.threadGroupId);
  const conversationId = useZenStore((s) => s.threadConversationId);
  const agents = useZenStore((s) => s.agents);
  const outbox = useZenStore((s) => s.outbox);
  const landedKeys = useZenStore((s) => s.landedKeys);
  const sendError = useZenStore((s) => s.sendError);
  const openFileFromPath = useZenStore((s) => s.openFileFromPath);
  const roomBlocked = Boolean(roomBanner) && !roomQueuesInput;
  const canSend =
    !roomBlocked &&
    (source === "live" ||
      (source === "error" && isSendableAddr(threadAddr))) &&
    (Boolean((threadGroupId || "").trim()) || isSendableAddr(threadAddr));
  const agent = agents.find((a) => a.id === agentId);
  // The room's server: the overlay socket redials only on its own server.
  const zenServer = useZenScope().id;
  // Uploads land in `<workspace>/.k2/downloads/` (desktop's compose bar).
  // A project chat has no workspace of its own: its PoC member's.
  const groupId = (threadGroupId || "").trim();
  const [groupPoc, setGroupPoc] = useState<{ key: string; poc: GroupPoc } | null>(null);
  const groupKey = groupId ? `${zenServer}\n${groupId}` : "";
  const poc = groupPoc && groupPoc.key === groupKey ? groupPoc.poc : null;
  useEffect(() => {
    if (!groupKey || source !== "live") return;
    let live = true;
    const scope = zenScope();
    void loadGroupPoc(scope, groupId).then((p) => {
      if (!live || zenScope().id !== scope.id) return;
      setGroupPoc({ key: groupKey, poc: p });
      if (p.path) useZenStore.getState().setGroupRoot(p.path);
    });
    return () => {
      live = false;
    };
  }, [groupKey, groupId, source]);
  const attachWorkspace = groupId ? poc?.handle ?? "" : workspaceHandleOf(threadAddr);
  const attachDir = groupId ? uploadDirOf(poc?.path) : uploadDirOf(agent?.path);
  const placeholder = composerPlaceholder(
    (threadGroupId || "").trim()
      ? { name: agent?.name, kind: "group" }
      : { name: agent?.name, addr: threadAddr || agent?.addr }
  );
  const canAttach = canSend && Boolean(attachWorkspace) && Boolean(attachDir);
  // The composer's text, kept per room (composerDrafts): leaving the chat
  // or relaunching the app and coming back puts an unsent draft back.
  // The text itself lives in the composer (ThreadDraftComposer): a
  // keystroke re-renders the field, not this pane and its rows. The pane
  // reads it on Send / Edit and only hears when it turns blank or not.
  const draftKey = composerDraftKey(zenServer, threadGroupId, threadAddr);
  const draftApi = useRef<DraftApi | null>(null);
  const [draftBlank, setDraftBlank] = useState(() => !composerDraftOf(draftKey).trim());
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Optimistic sends (iMessage): this room's bubbles not yet confirmed.
  const roomKey = threadRoomKey(zenServer, threadGroupId, threadAddr);
  const outgoing = visibleOutgoing(outbox, thread, roomKey);
  // Double-send guard: one send in flight per room. Typing stays open.
  const inFlight = outgoing.some((o) => o.status === "sending");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The send animation: which bubble is flying in, and from where.
  // The row keeps this key (the send's localId) once the server's copy
  // replaces the outbox entry, so the same element flies and lands.
  const [fly, setFly] = useState<{
    localId: string;
    source: FlySource | null;
    /** Reduced motion / no Web Animations: fade instead of fly. */
    fade: boolean;
    /** The newest message's row and its top before Send: how far the
     *  list moves to make room (the glide). */
    anchor: MessageAnchor | null;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // One owner for the list's transform (listGlide): sends, arrivals and
  // the working drawer all glide through it, so they fold into one motion.
  const gliderRef = useRef<ListGlider | null>(null);
  if (!gliderRef.current) gliderRef.current = createListGlider(() => contentRef.current);
  const glider = gliderRef.current;
  // The rows the last commit drew (this chat): what is new is an arrival.
  const committedRows = useRef<{ agent: string; keys: Set<string> } | null>(null);
  // When (Date.now()) an agent message last arrived while following.
  const lastArrivalAt = useRef(0);
  const pendingAnchor = useRef<MessageAnchor | null>(null);
  const prevAgent = useRef<string>("");
  const prevFirst = useRef<string | null>(null);
  const prevLast = useRef<string | null>(null);
  // FOLLOWING: pinned to the newest. Remembered intent, not a distance
  // measured at render time — the working drawer opening, growing,
  // closing, and the reply landing in one layout change must not unpin
  // the reader. On at
  // open, on Send, and whenever the reader scrolls back near the bottom;
  // off only when the reader scrolls up (or opens history / a push seq).
  const following = useRef(true);
  // Not following and the agent posted: the "New message" pill.
  const [newBelow, setNewBelow] = useState(false);
  // The reader sits at (or near) the newest message: what read marking
  // (K2 0.46.1) counts as "seen". Scrolled up into history = not.
  const [atNewest, setAtNewest] = useState(true);
  // Our own scrolls: their scroll events must not read as the reader's.
  const ownTop = useRef<number | null>(null);
  const lastTop = useRef(0);
  const followRaf = useRef(0);
  const drawerRaf = useRef(0);
  // Until when (Date.now()) followFor keeps sticking every frame.
  const followUntil = useRef(0);
  // Interactive keyboard dismiss (keyboardDragDock): a stand-in of the
  // dock rides the scrolled content (the drag layer) with the finger; the
  // pad keeps the list's scroll range while the column is full height;
  // the top room keeps real scroll range above while the keyboard is up.
  const dockRef = useRef<HTMLDivElement>(null);
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const topRoomRef = useRef<HTMLDivElement>(null);
  const kbPadRef = useViewportPadRef();
  // Last reader/native scroll (Date.now()): the top room waits for idle.
  const lastScrollAt = useRef(0);
  // Interactive keyboard dismiss in progress: the reader's finger owns
  // the scroll (iMessage) — no automatic sticking of any kind.
  const interactiveRef = useRef(viewportInteractive);
  interactiveRef.current = viewportInteractive;
  // Height (px) the working drawer stands on the composer field. The part
  // above the bar floats over the scroller, which pads its bottom by it
  // (same 200ms ease).
  const [drawerSpace, setDrawerSpace] = useState(0);
  // The whole composer block's height (GlassComposer's ResizeObserver).
  // It floats over the scroller's bottom: as the field grows a line, the
  // scroller's bottom padding grows by that much.
  const [composerPx, setComposerPx] = useState(0);
  const composerPxRef = useRef<number | null>(null);
  const composerLabel =
    source === "stub"
      ? "STUB — Cannot send — POST /cli/thread/post not proven"
      : attachError
        ? attachError
        : sendError
          ? sendError
          : canSend || roomBlocked
            ? ""
            : source === "live"
              ? "Not chattable"
              : "";
  // Rows between the bar's top and the field: the bar makes room for the
  // drawer under them rather than let it cover them.
  const rowsAboveField = roomBlocked || composerLabel !== "" || attachments.length > 0;
  const drawerCover = drawerOverScroller(drawerSpace, rowsAboveField);
  const focusSeq = useZenStore((s) => s.threadFocusSeq);
  // Progressive first paint (see PROGRESSIVE_MIN): decided on the render
  // where this chat first has messages; widened after that frame.
  const filledFor = useRef<string | null>(null);
  const limitedFor = useRef<string | null>(null);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  if (thread.length > 0 && filledFor.current !== agentId) {
    filledFor.current = agentId;
    limitedFor.current = thread.length > PROGRESSIVE_MIN && focusSeq == null ? agentId : null;
  }
  const limited =
    limitedFor.current === agentId && expandedFor !== agentId && focusSeq == null && thread.length > PROGRESSIVE_FIRST;
  const focusSeqRef = useRef(focusSeq);
  focusSeqRef.current = focusSeq;
  // The render window (threadWindow.ts): which messages are in the DOM,
  // pinned by key; the measured height of each row that left it (its
  // spacer); what the last commit drew; the row to hold still across a
  // window change; stick once it is in (back at the newest).
  const winRef = useRef<{ agent: string; win: ThreadWindow } | null>(null);
  const winHeights = useRef<{ agent: string; px: Map<string, number> }>({ agent: "", px: new Map() });
  if (winHeights.current.agent !== agentId) winHeights.current = { agent: agentId, px: new Map() };
  const winDrawn = useRef<(WindowRange & { keys: string[]; limited: boolean }) | null>(null);
  const winAnchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const winStick = useRef(false);
  const winTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const winRaf = useRef(0);
  const [, bumpWindow] = useReducer((n: number) => n + 1, 0);
  // The working strip's turn. The gate drops a catch-up answer that raced
  // an activity frame (the frame is newer) or a later catch-up (a late
  // `{turn:null}` must not clear a live strip).
  const [turn, setTurn] = useState<ThreadTurn | null>(null);
  const catchUps = useRef(createCatchUpGate());
  const addrRef = useRef(threadAddr);
  addrRef.current = threadAddr;
  const liveRef = useRef<OverlayLiveHandle | null>(null);
  // Viewing frames go to the ROOM's server (the overlay socket's own).
  const serverId = zenServer || null;
  const viewingAllowed = useNotifyPrefsStore(
    (s) => !!serverId && s.threadPush[serverId] === true
  );
  useEffect(() => {
    if (serverId) void useNotifyPrefsStore.getState().probe(serverId);
  }, [serverId]);
  // Files on Thread messages (K2 0.46.1 `thread-attachments-v1`): chips
  // only when the room's server lists the feature; a tap opens the file
  // through that server (the scope captured at the tap).
  const filesOn = useThreadFilesOn(useZenScope());
  const [openFile, setOpenFile] = useState<OpenAttachment | null>(null);
  useEffect(() => {
    setOpenFile(null);
  }, [agentId, zenServer]);
  function openAttachment(m: ThreadMessage, a: ThreadAttachment) {
    if (!m.id || groupId) return;
    const scope = zenScope();
    setOpenFile({ scope, ref: { addr: threadAddr, conversationId, id: m.id }, file: a });
  }

  function setFollowing(on: boolean) {
    following.current = on;
    if (on) setNewBelow(false);
  }

  /** Jump to the newest now (a scroll the reader did not make). */
  function stick(el: HTMLElement) {
    stickToNewest(el);
    ownTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
  }

  /** While following: stick now, and again next frame for late layout
   *  (markdown, code highlighting, images). Refs only — safe to call
   *  from the ResizeObserver set up on mount. */
  function follow() {
    const el = scrollerRef.current;
    if (!el || !following.current || pendingAnchor.current || interactiveRef.current) return;
    stick(el);
    if (typeof requestAnimationFrame !== "function") return;
    cancelAnimationFrame(followRaf.current);
    followRaf.current = requestAnimationFrame(() => {
      const cur = scrollerRef.current;
      if (cur && following.current && !pendingAnchor.current && !interactiveRef.current) {
        stick(cur);
      }
    });
  }

  /** follow(), then keep sticking every frame for `ms` (or longer, if a
   *  loop already running goes on past that): the scroller's bottom
   *  padding is easing with the drawer, or the column / composer gap with
   *  the keyboard. */
  function followFor(ms: number) {
    follow();
    if (typeof requestAnimationFrame !== "function") return;
    const until = Math.max(followUntil.current, Date.now() + ms);
    followUntil.current = until;
    const tick = () => {
      const el = scrollerRef.current;
      if (!el || !following.current || pendingAnchor.current || interactiveRef.current) return;
      stick(el);
      if (Date.now() < until) drawerRaf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(drawerRaf.current);
    drawerRaf.current = requestAnimationFrame(tick);
  }

  /** Agent messages arrived while following (a live frame, a read, a
   *  delta, a catch-up): rather than snap, the list stays where it was and
   *  glides up by what came in, as each new row fades in and rises
   *  (iMessage). Reduced motion: just the newest, in place. */
  function arrive(el: HTMLElement, keys: string[]) {
    lastArrivalAt.current = Date.now();
    const before = el.scrollTop;
    follow();
    if (prefersReducedMotion() || interactiveRef.current || pendingAnchor.current) return;
    const moved = el.scrollTop - before;
    // A big batch: at most a screenful of travel (still one smooth move).
    const cap = Math.max(el.clientHeight, 1);
    const dy = Math.max(-cap, Math.min(cap, moved));
    if (Math.abs(dy) >= 1) glider.shift(dy, { motion: incomingMotion() });
    const want = new Set(keys);
    const content = contentRef.current;
    if (!content) return;
    fadeInRows(
      Array.from(content.querySelectorAll<HTMLElement>("[data-thread-msg]")).filter((r) =>
        want.has(r.getAttribute("data-row-key") ?? "")
      )
    );
  }

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const keyOf = (m: ThreadMessage | undefined) =>
      m ? m.id || `seq-${m.seq ?? ""}` : null;
    const first = keyOf(thread[0]);
    const lastMsg = thread[thread.length - 1];
    const last = keyOf(lastMsg);
    const agentChanged = agentId !== prevAgent.current;
    const opened = agentChanged || prevFirst.current == null;
    if (pendingAnchor.current) {
      restoreTopMessage(el, pendingAnchor.current);
      ownTop.current = el.scrollTop;
      lastTop.current = el.scrollTop;
      pendingAnchor.current = null;
    } else if (opened) {
      // A push-tap seq lands after this (useThreadFocusSeq): no following
      // over it until the reader comes back to the bottom.
      glider.cancel();
      setNewBelow(false);
      following.current = focusSeq == null;
      setAtNewest(true);
      stick(el);
      follow();
    } else if (following.current) {
      const before = committedRows.current;
      const fresh =
        before && before.agent === agentId
          ? arrivedRows(
              rows.map((r) => ({ key: r.key, own: r.out != null })),
              before.keys
            )
          : [];
      if (fresh.length) arrive(el, fresh.map((r) => r.key));
      else follow();
    } else if (
      lastMsg &&
      last !== prevLast.current &&
      !lastMsg.mine &&
      !lastMsg.pending &&
      focusSeq == null
    ) {
      // Reading history: never yank. Offer the jump instead. (A push tap
      // still looking for its message: that arrival is where it lands.)
      setNewBelow(true);
    }
    prevAgent.current = agentId;
    prevFirst.current = first;
    prevLast.current = last;
  }, [thread, agentId, source]);

  /** The composer block resized (typing a line, chips, the label line,
   *  drawer room, keyboard gap): the scroller's bottom padding moves with it.
   *  Following: the newest stays right above the field. Reading history:
   *  the reader's viewport stays where it was (no jump). */
  function composerResized(px: number) {
    const prev = composerPxRef.current;
    composerPxRef.current = px;
    setComposerPx(px);
    if (prev == null || prev === px) return;
    const el = scrollerRef.current;
    if (!el || pendingAnchor.current) return;
    if (following.current) {
      follow();
      return;
    }
    const top = lastTop.current;
    if (Math.abs(el.scrollTop - top) > 1) {
      el.scrollTop = top;
      ownTop.current = el.scrollTop;
      lastTop.current = el.scrollTop;
    }
  }

  // A push-tap seq: hold off following while it lands. Once it has (or
  // was given up on) follow again only if the view sits at the bottom.
  useLayoutEffect(() => {
    if (focusSeq != null) {
      following.current = false;
      return;
    }
    const el = scrollerRef.current;
    if (el && !following.current && !pendingAnchor.current && nearNewest(el)) {
      setFollowing(true);
    }
  }, [focusSeq]);

  // Anything else that changes height while following — late
  // markdown/images in the last bubbles; the keyboard, composer or the
  // drawer's padding resizing the column — sticks.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => follow());
    ro.observe(content);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(followRaf.current);
        cancelAnimationFrame(drawerRaf.current);
      }
    };
  }, []);

  // Progressive first paint: the rest of the messages on the next idle
  // frame. Pinned to the bottom it stays there; a reader who already
  // scrolled keeps the message under their eye.
  useEffect(() => {
    if (!limited) return;
    const id = agentId;
    let t: ReturnType<typeof setTimeout> | null = null;
    const widen = () => {
      const el = scrollerRef.current;
      if (el && !following.current && !pendingAnchor.current) {
        pendingAnchor.current = captureTopMessage(
          el,
          Array.from(el.querySelectorAll<HTMLElement>("[data-thread-msg]"))
        );
      }
      setExpandedFor(id);
    };
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            t = setTimeout(widen, 0);
          })
        : null;
    if (raf == null) t = setTimeout(widen, 0);
    return () => {
      if (raf != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      if (t) clearTimeout(t);
    };
  }, [limited, agentId]);
  const wasLimited = useRef(false);
  useLayoutEffect(() => {
    const was = wasLimited.current;
    wasLimited.current = limited;
    if (!was || limited) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (pendingAnchor.current) {
      restoreTopMessage(el, pendingAnchor.current);
      ownTop.current = el.scrollTop;
      lastTop.current = el.scrollTop;
      pendingAnchor.current = null;
    } else if (following.current) {
      stick(el);
      follow();
    }
  }, [limited]);

  // Push tap `?seq=`: land on that message (after the stick above).
  // Not found (or never came): back to the newest, following again.
  const highlightSeq = useThreadFocusSeq(scrollerRef, () => {
    const el = scrollerRef.current;
    if (!el || pendingAnchor.current) return;
    setFollowing(true);
    stick(el);
  });

  // Typing is written to storage after a short quiet; leaving the chat or
  // the app going to the background writes it now.
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

  useLayoutEffect(() => {
    setAttachments([]);
    setAttachError(null);
    setFly(null);
    glider.cancel();
  }, [agentId]);

  useEffect(() => {
    setTurn(null);
  }, [agentId, conversationId, threadGroupId]);

  useEffect(() => {
    if (source !== "live" && source !== "error") return;
    let stopped = false;
    // The room's server for this socket and every catch-up (MS6/MS23).
    const scope = zenScope();
    // `GET /cli/thread/activity`: the live turn, or null. Pre-0.45 servers
    // 404 and the strip just never shows.
    const catchUpActivity = async () => {
      const addr = addrRef.current;
      if (!addr || threadGroupId) return;
      const current = catchUps.current.begin();
      try {
        const r = await getThreadActivity(scope, addr);
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
    const live = (liveRef.current = connectOverlayEvents({
      scope,
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
    }));
    return () => {
      stopped = true;
      if (liveRef.current === live) liveRef.current = null;
      live.stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [source, conversationId, threadGroupId, zenServer]);

  // Unread (K2 0.46.1 `thread-read-v1`): this Thread's addr ↔ conversation
  // for the lists, and its read cursor while the reader is at the newest.
  useEffect(() => {
    if (zenServer && !groupId) useUnreadStore.getState().noteAddr(zenServer, threadAddr, conversationId);
  }, [zenServer, groupId, threadAddr, conversationId]);
  const readRef: RowRef | null = groupId
    ? { kind: "project", groupId }
    : threadAddr || conversationId
      ? { kind: "thread", addr: threadAddr, conversationId }
      : null;
  useMarkReadWhileViewing({
    serverId: zenServer || null,
    rowRef: readRef,
    newestSeq: newestSeenSeq(thread, groupId ? "project" : "thread"),
    viewing: source === "live" && !cachedOnly && !covered && atNewest && focusSeq == null,
  });

  // Viewing frames (K2 0.45.5 `thread-push-v1` only): while this Thread is
  // on screen the daemon holds its pushes. Older servers never get them.
  useEffect(() => {
    const apply = () =>
      liveRef.current?.setViewing(
        viewingAllowed && !covered && document.visibilityState === "visible"
      );
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
      liveRef.current?.setViewing(false);
    };
  }, [viewingAllowed, covered, source, conversationId, threadGroupId, zenServer]);

  const scrollRoom = useRef<{ dropNow(): void } | null>(null);
  // Keyboard open/close on the compositor (FLIP; mobile chat kit). After
  // an interactive drag the finger owns the scroll: only the composer
  // plays, the list is never moved or re-stuck.
  useKeyboardFlip({
    viewportHeight,
    motion: viewportMotion,
    interactive: viewportInteractive,
    scroller: () => scrollerRef.current,
    docks: () => [dockRef.current],
    list: {
      isFollowing: () => following.current,
      lastScrollTop: () => lastTop.current,
      stick: () => follow(),
      held: () => !!pendingAnchor.current,
      content: () => contentRef.current,
      beforeHide: () => scrollRoom.current?.dropNow(),
    },
  });

  // Keyboard up: real scroll range above the view (kit useScrollRoom).
  scrollRoom.current = useScrollRoom({
    viewportHeight,
    scroller: () => scrollerRef.current,
    room: () => topRoomRef.current,
    content: () => contentRef.current,
    lastScrollAt: () => lastScrollAt.current,
    onScrollWrite: (top) => {
      ownTop.current = top;
      lastTop.current = top;
    },
  });

  // Interactive dismiss: the composer copy rides the scrolled content;
  // iOS 17+ starts the drag at the composer's top (iMessage).
  useKeyboardDrag({
    scroller: () => scrollerRef.current,
    dock: () => dockRef.current,
    layer: () => dragLayerRef.current,
    composerPx: composerPx > 0 ? composerPx + 8 : 0,
  });

  // The composer's bottom gap (home indicator ↔ 8px) eases with the
  // keyboard; stick through the ease. Blur when the keyboard hides on its
  // own.
  useComposerFocusGap({
    root: () => rootRef.current,
    bar: () => rootRef.current?.querySelector<HTMLElement>('[data-testid="composer-bar"]') ?? null,
    onChange: () => followFor(keyboardMotionMs() + 80),
  });

  // A tap on the conversation (not on a link / button / chip, not a
  // scroll, not a selection) closes the keyboard (iMessage).
  useTapToDismiss({
    area: () => scrollerRef.current,
    composer: () => rootRef.current?.querySelector<HTMLElement>('[data-testid="composer-bar"]') ?? null,
  });

  // The floating header growing (sidecar line, banner) adds top padding,
  // which pushes the tail down by the same amount. Keep the newest in view.
  useLayoutEffect(() => {
    if (topInset == null) return;
    follow();
  }, [topInset]);

  // Outgoing bubbles keep the newest in view while following —
  // synchronously, before the ResizeObserver gets a say.
  const outgoingKey = outgoing.map((o) => `${o.localId}:${o.status}`).join(",");
  useLayoutEffect(() => {
    follow();
  }, [outgoingKey]);

  // The new composer padding is in the DOM now: stick to it before paint.
  useLayoutEffect(() => {
    follow();
  }, [composerPx]);

  // The working drawer opening, growing (tap), shrinking or closing
  // changes the scroller's bottom padding (at once, not eased), not its
  // content: following, the tail sticks and the list glides the
  // difference (listGlide). Folding away with no reply yet, the list
  // holds still briefly for it, so the reply's glide takes both in one
  // motion (no jump up, drift down); a glide already running takes it in.
  const coverRef = useRef(drawerCover);
  useLayoutEffect(() => {
    const prev = coverRef.current;
    coverRef.current = drawerCover;
    const el = scrollerRef.current;
    if (!el || prev === drawerCover) return;
    if (!following.current || pendingAnchor.current || interactiveRef.current) return;
    const before = lastTop.current;
    follow();
    const dy = el.scrollTop - before;
    if (prefersReducedMotion() || !(Math.abs(dy) >= 1)) return;
    if (glider.moving()) {
      glider.shift(dy, { motion: incomingMotion() });
    } else if (dy < 0 && Date.now() - lastArrivalAt.current > ARRIVAL_RECENT_MS) {
      glider.shift(dy, { motion: drawerMotion(), holdMs: REPLY_FOLD_MS });
    } else {
      glider.shift(dy, { motion: drawerMotion() });
    }
  }, [drawerCover]);

  function queueFiles(files: File[]) {
    if (!files.length) return;
    if (!canAttach) {
      setAttachError(ATTACH_UNAVAILABLE);
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
    // Opening history is reading it: stop following the tail.
    following.current = false;
    // Still in memory (above the render window): draw it, no fetch.
    const view = winDrawn.current;
    if (view && !view.limited && view.lo > 0) {
      setWindow(pinWindow(view.keys, { lo: Math.max(0, view.lo - WINDOW_EXTEND), hi: view.hi }), true);
      return;
    }
    if (el) {
      const msgs = Array.from(
        el.querySelectorAll<HTMLElement>("[data-thread-msg]")
      );
      pendingAnchor.current = captureTopMessage(el, msgs);
    }
    await loadEarlier();
  }

  /** Deliver, or queue while the room's server is down (auto reconnect):
   *  a send that failed because the server did not answer waits too. */
  async function deliver(localId: string) {
    const server = zenScope().id;
    if (shouldQueueSend(server)) {
      queueSend(localId);
      return;
    }
    await deliverNow(localId);
    requeueIfUnreachable(server, localId);
  }

  /** Upload what is left of an outgoing message's files, then POST it.
   *  Any failure leaves its bubble "Not sent" (retry / put back). */
  async function deliverNow(localId: string) {
    const store = useZenStore.getState;
    const entry = store().outbox.find((o) => o.localId === localId);
    if (!entry) return;
    store().patchOutgoing(localId, { status: "sending", error: null });
    const failed = (error: string) =>
      store().patchOutgoing(localId, { status: "failed", error });
    const paths = [...entry.paths];
    if (entry.files.length) {
      if (!entry.attachWorkspace || !entry.attachDir) {
        failed(ATTACH_UNAVAILABLE);
        return;
      }
      for (let i = 0; i < entry.files.length; i++) {
        if (paths[i]) continue;
        // Uploads outlived the room: never upload to another server.
        const s = store();
        if (threadRoomKey(zenScope().id, s.threadGroupId, s.threadAddr) !== entry.roomKey) {
          failed("Not sent");
          return;
        }
        const f = entry.files[i];
        const filename = uploadFilename(f);
        try {
          const r = await uploadFsBinary(
            zenScope(),
            entry.attachWorkspace,
            entry.attachDir,
            filename,
            await fileToBase64(f)
          );
          if (!r.ok || !r.data?.path) {
            failed(r.error || `Could not upload ${filename}`);
            return;
          }
          paths[i] = r.data.path;
        } catch (e) {
          failed(e instanceof Error ? e.message : `Could not upload ${filename}`);
          return;
        }
        store().patchOutgoing(localId, { paths: [...paths] });
      }
    }
    await store().sendThread(
      attachmentSendBody(entry.text, paths.filter((p): p is string => !!p)),
      { localId }
    );
  }

  // Sends queued while the server was down go out once it is back.
  useQueuedSendFlush(zenServer, roomKey, deliver);

  /** Send tap: clear the field at once (focus and keyboard stay), show
   *  the bubble "Sending…", fly the text into it, deliver behind it. */
  function onSend() {
    if (!canSend) return;
    const text = draftApi.current?.get() ?? "";
    const files = attachments;
    if (!text.trim() && !files.length) return;
    const st = useZenStore.getState();
    if (sendInFlight(st.outbox, st.thread, roomKey)) return;
    if (files.length && (!canAttach || !attachWorkspace || !attachDir)) {
      setAttachError(ATTACH_UNAVAILABLE);
      return;
    }
    onComposerInput?.();
    // Where the text sits now, before it is cleared (the FLIP "first"):
    // the field's text box and the text as drawn there; or the chips.
    const chipsFont = fontPxOf(chipsRef.current?.firstElementChild);
    const chipsRect = text.trim() ? null : rectOf(chipsRef.current);
    const flySource: FlySource | null = text.trim()
      ? flySourceOfField(composerRef.current)
      : chipsRect
        ? { rect: chipsRect, fontPx: Number.isFinite(chipsFont) ? chipsFont : 17 }
        : null;
    // The newest row's top now: after the new row is in, how far it moved.
    const rowsNow = scrollerRef.current?.querySelectorAll<HTMLElement>("[data-thread-msg]");
    const lastRow = rowsNow && rowsNow.length ? rowsNow[rowsNow.length - 1] : null;
    const anchorRect = rectOf(lastRow);
    const anchor = lastRow && anchorRect ? { el: lastRow, top: anchorRect.top } : null;
    draftApi.current?.set("");
    setAttachments([]);
    setAttachError(null);
    const localId = st.queueOutgoing({
      text: text.trim(),
      files,
      attachWorkspace: files.length ? attachWorkspace : null,
      attachDir: files.length ? attachDir : null,
    });
    // "Recent agents first": this phone spoke to this agent just now.
    // Project chats are not rows in the Agents or Home lists.
    if (!groupId) useRecentFirstStore.getState().markSent(recentSentKey(zenServer, { addr: threadAddr }));
    const reduced = prefersReducedMotion();
    const canFly =
      !reduced &&
      flySource != null &&
      typeof Element !== "undefined" &&
      typeof Element.prototype.animate === "function";
    setFly({
      localId,
      source: canFly ? flySource : null,
      fade: !canFly,
      anchor: canFly ? anchor : null,
    });
    // The reader just spoke: the agent's reply must come into view.
    setFollowing(true);
    const view = winDrawn.current;
    if (view && view.hi < view.keys.length) setWindow(null, false);
    composerRef.current?.focus({ preventScroll: true });
    void deliver(localId);
  }

  /** "New message ↓": glide to the newest and follow again. WKWebView can
   *  drop a smooth scroll that a layout change interrupts, so if it has
   *  not reached the newest after the glide, jump the rest. */
  function onNewBelow() {
    const el = scrollerRef.current;
    setFollowing(true);
    if (!el) return;
    // The newest are not drawn (the reader went far up): the window moves
    // back to them and the view jumps there.
    const view = winDrawn.current;
    if (view && view.hi < view.keys.length) {
      winStick.current = true;
      setWindow(null, false);
      return;
    }
    if (typeof el.scrollTo === "function" && !prefersReducedMotion()) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => {
        const cur = scrollerRef.current;
        if (cur && following.current && !nearNewest(cur)) stick(cur);
      }, NEW_BELOW_SETTLE_MS);
    } else {
      stick(el);
    }
  }

  function onRetry(localId: string) {
    const st = useZenStore.getState();
    if (sendInFlight(st.outbox, st.thread, roomKey)) return;
    void deliver(localId);
  }

  /** "Not sent" → back into an empty composer (the bubble goes). */
  function onRestore(o: OutgoingMessage) {
    if ((draftApi.current?.get() ?? "").trim() || attachments.length) return;
    draftApi.current?.set(o.text);
    setAttachments(o.files);
    useZenStore.getState().dropOutgoing(o.localId);
    composerRef.current?.focus({ preventScroll: true });
  }

  const flyKey = fly ? fly.localId : "";
  const flyBusy = useRef(false);
  flyBusy.current = fly != null;

  /** Draw another window (null: the newest WINDOW_ROWS). `hold`: keep the
   *  row under the reader's eye where it is. */
  function setWindow(win: ThreadWindow | null, hold: boolean) {
    winRef.current = win ? { agent: agentId, win } : null;
    winAnchor.current = hold ? captureWindowAnchor() : null;
    bumpWindow();
  }

  function windowRows(): HTMLElement[] {
    const content = contentRef.current;
    return content ? Array.from(content.querySelectorAll<HTMLElement>("[data-win-row]")) : [];
  }

  /** The first drawn row still (partly) on screen, by layout offset. */
  function captureWindowAnchor(): { el: HTMLElement; top: number } | null {
    const el = scrollerRef.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    for (const r of windowRows()) {
      if (r.getBoundingClientRect().bottom > top + 1) return { el: r, top: r.offsetTop };
    }
    return null;
  }

  /** Rows leaving the window: remember what each adds to the list. */
  function rememberHeights(leaving: HTMLElement[]) {
    const px = measureRows(leaving);
    leaving.forEach((r, i) => {
      const key = r.getAttribute("data-row-key");
      if (key) winHeights.current.px.set(key, px[i]);
    });
  }

  /** Grow or shrink the window to what the reader is near. `idle`: no
   *  scroll for a while — rows may also leave. "busy": try again later. */
  function reconcileWindow(idle: boolean): "busy" | "done" {
    const el = scrollerRef.current;
    const view = winDrawn.current;
    if (!el || !view || view.limited || !view.keys.length) return "done";
    if (
      pendingAnchor.current ||
      interactiveRef.current ||
      flyBusy.current ||
      focusSeqRef.current != null ||
      glider.moving() ||
      glider.holding()
    ) {
      return "busy";
    }
    const { keys, lo, hi } = view;
    const len = keys.length;
    const drawn = windowRows();
    if (!drawn.length) return "done";
    const indexOf = (r: HTMLElement) => keys.indexOf(r.getAttribute("data-row-key") ?? "");
    if (following.current) {
      if (hi < len) {
        // Back at the newest: draw through it.
        winStick.current = true;
        setWindow(pinWindow(keys, { lo, hi: len }), false);
        return "done";
      }
      if (hi - lo <= WINDOW_ROWS) return "done";
      if (!idle) return "busy";
      // The oldest drawn drop off, far above the view.
      const start = Math.max(0, len - WINDOW_ROWS);
      const leaving = drawn.filter((r) => {
        const at = indexOf(r);
        return at >= 0 && at < start;
      });
      rememberHeights(leaving);
      // Held, not re-stuck: a reader resting a little above the newest
      // (still following) must not be moved.
      setWindow(pinWindow(keys, { lo: start, hi: len }), true);
      return "done";
    }
    const ch = el.clientHeight;
    if (!(ch > 0)) return "done";
    const st = el.scrollTop;
    const scTop = el.getBoundingClientRect().top;
    const y = (r: HTMLElement) => r.getBoundingClientRect().top - scTop + st;
    const first = drawn[0];
    const last = drawn[drawn.length - 1];
    // Near a drawn edge with more in memory: bring rows back first.
    if (lo > 0 && y(first) > st - WINDOW_RESPAWN_SCREENS * ch) {
      setWindow(pinWindow(keys, { lo: Math.max(0, lo - WINDOW_EXTEND), hi }), true);
      return "done";
    }
    if (hi < len && y(last) + last.offsetHeight < st + ch + WINDOW_RESPAWN_SCREENS * ch) {
      setWindow(pinWindow(keys, { lo, hi: Math.min(len, hi + WINDOW_EXTEND) }), true);
      return "done";
    }
    if (!idle) return "done";
    // Far past the view (and enough of them): they leave.
    const keepFrom = st - WINDOW_KEEP_SCREENS * ch;
    const keepTo = st + ch + WINDOW_KEEP_SCREENS * ch;
    let above = 0;
    while (above < drawn.length - 1 && y(drawn[above]) + drawn[above].offsetHeight < keepFrom) above++;
    let below = 0;
    while (below < drawn.length - 1 - above && y(drawn[drawn.length - 1 - below]) > keepTo) below++;
    if (above < WINDOW_TRIM_MIN) above = 0;
    if (below < WINDOW_TRIM_MIN) below = 0;
    if (!above && !below) return "done";
    const leaving = [...drawn.slice(0, above), ...drawn.slice(drawn.length - below)];
    rememberHeights(leaving);
    const nextLo = above ? indexOf(drawn[above]) : lo;
    const nextHi = below ? indexOf(drawn[drawn.length - 1 - below]) + 1 : hi;
    if (nextLo < 0 || nextHi <= nextLo) return "done";
    setWindow(pinWindow(keys, { lo: nextLo, hi: nextHi }), true);
    return "done";
  }
  const reconcileRef = useRef(reconcileWindow);
  reconcileRef.current = reconcileWindow;

  /** Rows leave only once scrolling has been quiet a while. */
  function scheduleWindowIdle(delay = WINDOW_IDLE_MS) {
    if (winTimer.current) clearTimeout(winTimer.current);
    winTimer.current = setTimeout(() => {
      winTimer.current = null;
      const quiet = Date.now() - lastScrollAt.current;
      if (quiet < WINDOW_IDLE_MS) {
        scheduleWindowIdle(WINDOW_IDLE_MS - quiet + 10);
        return;
      }
      if (reconcileRef.current(true) === "busy") scheduleWindowIdle();
    }, delay);
  }

  useEffect(
    () => () => {
      if (winTimer.current) clearTimeout(winTimer.current);
      if (winRaf.current && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(winRaf.current);
      }
    },
    []
  );

  // The rows' callbacks: stable, so a re-render of the pane leaves
  // unchanged rows alone (ThreadRow is memoized).
  const handlers = useRef({ onRetry, onRestore, openAttachment });
  handlers.current = { onRetry, onRestore, openAttachment };
  const onAnswerRow = useCallback(
    (id: string, option: string) => void answerChoice(id, option),
    [answerChoice]
  );
  const onRetryRow = useCallback((id: string) => handlers.current.onRetry(id), []);
  const onRestoreRow = useCallback((o: OutgoingMessage) => handlers.current.onRestore(o), []);
  const onOpenFileRow = useCallback(
    (m: ThreadMessage, a: ThreadAttachment) => handlers.current.openAttachment(m, a),
    []
  );

  // FLIP "last/invert/play". The row is in its final slot (hidden while it
  // flies); the composer has already shrunk back to one empty line.
  useLayoutEffect(() => {
    if (!fly) return;
    const id = fly.localId;
    const clear = () => setFly((cur) => (cur?.localId === id ? null : cur));
    setFollowing(true);
    const el = scrollerRef.current;
    const root = rootRef.current;
    // The cleared field (and gone chips / label) shrank the composer in
    // this same commit, but its ResizeObserver reports a frame later and
    // the padding would then ease down under a bubble already aimed. Take
    // the new height now, unanimated, so the slot is final before paint.
    // (The field snaps to one empty line in the Send commit, iMessage; with
    // the DEV `collapse` override it eases shut instead and this pads for
    // where it ends, so the bubble is aimed at its final slot either way.)
    const bar = root?.querySelector<HTMLElement>('[data-testid="composer-bar"]');
    const barPx = bar ? composerBlockHeight(bar) : 0;
    if (el && bar && barPx > 0 && barPx !== composerPxRef.current) {
      const px = barPx;
      el.style.transition = "none";
      el.style.paddingBottom = threadBottomPadding(px, drawerCover);
      void el.offsetHeight;
      el.style.transition = "";
      composerResized(px);
    }
    if (el) stick(el);
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
    // The list makes room as the bubble comes in, rather than jumping:
    // it glides on the bubble's curve, started once the bubble's resting
    // rect is read (glide-free).
    const a = fly.anchor;
    const now = a && a.el.isConnected ? rectOf(a.el) : null;
    const dy = a && now ? a.top - now.top : 0;
    // Through the list's glide controller: an agent message arriving
    // mid-flight folds into this glide instead of fighting it.
    const glide =
      el && Math.abs(dy) >= 1 && Math.abs(dy) <= el.clientHeight
        ? {
            content: contentRef.current,
            dy,
            run: (d: number, motion: FlyMotion) => {
              glider.shift(d, { motion });
              return () => {};
            },
          }
        : undefined;
    return runSendFly({ root, bubble, target, source: fly.source, done: clear, glide });
    // Once per send: a re-render mid-flight must not restart it.
  }, [flyKey]);

  // One list, one key per message: a send's row is keyed by its localId
  // from tap to delivered (the server's copy inherits it), so it is the
  // same element throughout — no remount, never two, never none.
  const rowKeys = landedRowKeys(outbox, thread, roomKey, landedKeys);
  // Every message in memory (runs, the receipt and arrivals look at all of
  // them); only the render window's are drawn (threadWindow.ts).
  const rows: { key: string; m: ThreadMessage; out: OutgoingMessage | null }[] = [];
  const threadKeys: string[] = [];
  for (let i = 0; i < thread.length; i++) {
    const m = thread[i];
    const key = rowKeys.get(m.id) ?? (m.id || `seq-${m.seq ?? i}`);
    threadKeys.push(key);
    rows.push({ key, m, out: null });
  }
  for (const o of outgoing) rows.push({ key: o.localId, m: outgoingBubble(o), out: o });

  // The render window. A push-tap target outside it: drawn around it.
  if (winRef.current && winRef.current.agent !== agentId) winRef.current = null;
  let winSpec = winRef.current?.win ?? null;
  let range = resolveWindow(threadKeys, winSpec);
  if (focusSeq != null) {
    const at = thread.findIndex((m) => m.seq === focusSeq);
    if (at >= 0 && (at < range.lo || at >= range.hi)) {
      winSpec = windowAround(threadKeys, at);
      winRef.current = { agent: agentId, win: winSpec };
      range = resolveWindow(threadKeys, winSpec);
    }
  }
  // Progressive first paint: just the newest few on the first frame.
  const firstShown = limited ? Math.max(range.lo, thread.length - PROGRESSIVE_FIRST) : range.lo;
  const lastShown = limited ? thread.length : range.hi;
  const topSpacer = spacerAbove(threadKeys, firstShown, winHeights.current.px);
  const bottomSpacer = spacerBelow(threadKeys, lastShown, winHeights.current.px);
  const winView = { keys: threadKeys, lo: firstShown, hi: lastShown, limited };
  // iMessage runs (tails, tighter spacing, one meta line per run) and the
  // one "Delivered" / "Read" receipt (chatReceipt.ts). A send still flying
  // in (or fading in) is not confirmed yet: the label moves once it lands.
  const runs = chatRuns(rows.map(({ m }) => ({ mine: m.mine, from: m.from, at: m.at })));
  const receiptRows = rows.map(({ key, m, out }) => ({
    mine: m.mine,
    confirmed: !out && !m.pending && !m.failed && key !== fly?.localId,
    at: m.at,
  }));
  const receiptIdx = receiptRow(receiptRows);
  // Agent Threads only: a project chat has no one reader to say "Read".
  const receipt = receiptFor(receiptRows, receiptIdx, { readSignals: !groupId, turn });

  // Last of the layout effects: what this commit drew, for the next one's
  // arrival check.
  useLayoutEffect(() => {
    committedRows.current = { agent: agentId, keys: new Set(rows.map((r) => r.key)) };
    // The window this commit drew, pinned by key (arrivals and earlier
    // pages do not move it). The first frame of a progressive paint is not
    // the window.
    winDrawn.current = winView;
    if (!winView.limited) {
      winRef.current = thread.length
        ? { agent: agentId, win: pinWindow(winView.keys, winView) }
        : null;
    }
    // A window change keeps the row under the reader's eye where it was
    // (a no-op when the spacer it replaced was exact).
    const a = winAnchor.current;
    winAnchor.current = null;
    const el = scrollerRef.current;
    if (a && el && a.el.isConnected) {
      const dy = a.el.offsetTop - a.top;
      if (Math.abs(dy) >= 1) {
        el.scrollTop += dy;
        ownTop.current = el.scrollTop;
        lastTop.current = el.scrollTop;
      }
    }
    if (winStick.current) {
      winStick.current = false;
      if (el && following.current) stick(el);
    }
    scheduleWindowIdle();
  });

  const empty =
    (source === "live" || source === "stub") &&
    !error &&
    thread.length === 0 &&
    outgoing.length === 0;

  return (
    <div
      ref={rootRef}
      className="zen-thread-pane mchat-pane relative flex flex-col flex-1 min-h-0 min-w-0 overflow-x-hidden"
      style={{ fontFamily: "var(--zen-font)" }}
    >
      <div
        ref={scrollerRef}
        data-testid="thread-scroller"
        data-drawer-space={drawerSpace}
        data-drawer-cover={drawerCover}
        data-composer-height={composerPx}
        data-bottom-inset={threadBottomInset(composerPx, drawerCover)}
        className="zen-thread-scroller flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-2.5 py-3 flex flex-col"
        style={{
          overflowAnchor: "none",
          paddingTop: threadTopPadding(topInset),
          paddingBottom: threadBottomPadding(composerPx, drawerCover),
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          lastScrollAt.current = Date.now();
          // The render window: rows come back before the reader gets to
          // them (next frame); rows far away leave once it is quiet.
          if (!winRaf.current && typeof requestAnimationFrame === "function") {
            winRaf.current = requestAnimationFrame(() => {
              winRaf.current = 0;
              reconcileRef.current(false);
            });
          }
          scheduleWindowIdle();
          // Mid interactive dismiss the finger scrolls every frame: no
          // state churn (it catches up on the next scroll after).
          if (!interactiveRef.current) setAtNewest(nearNewest(el));
          const top = el.scrollTop;
          const prev = lastTop.current;
          lastTop.current = top;
          // Our own stick/restore landing: not the reader.
          if (ownTop.current != null && Math.abs(top - ownTop.current) <= 1) return;
          ownTop.current = null;
          if (nearNewest(el)) {
            if (focusSeq == null) setFollowing(true);
          } else if (top < prev - 1) {
            // The reader scrolled up past the threshold.
            following.current = false;
          }
        }}
      >
        {/* Scroll range above the view while the keyboard is up (empty,
            0 otherwise). */}
        <div
          ref={topRoomRef}
          aria-hidden="true"
          className="shrink-0"
          data-testid="thread-kb-top-room"
        />
        {/* The composer's stand-in rides here during an interactive
            dismiss (keyboardDragDock): in the scrolled content, so native
            scrolling moves it with the finger and the keyboard. */}
        <div
          ref={dragLayerRef}
          aria-hidden="true"
          className="relative h-0 shrink-0"
          style={{ zIndex: 3 }}
          data-testid="thread-kb-drag-layer"
        />
        <div
          ref={contentRef}
          data-testid="thread-content"
          // Always fills the view (mobile chat kit): the keyboard's scroll
          // room coming and going never moves a short chat; it rests
          // top-aligned and glides there with the keyboard (FLIP).
          className={`${CHAT_CONTENT_CLASS} shrink-0 min-w-0 flex flex-col gap-1`}
        >
          {source === "loading" && holding ? null : source === "loading" ? (
            <span
              className="text-[11px] text-[var(--text-muted)] tracking-widest uppercase px-2"
              data-testid="thread-loading"
            >
              {sourceWord(source)} thread
            </span>
          ) : (
            <>
              {source === "error" && error && (doneMode || error === SESSION_UNAVAILABLE) ? (
                <div
                  className="flex flex-col items-start gap-2 px-2"
                  data-testid="thread-unavailable"
                >
                  <span className="text-[13px] text-[var(--text-muted)] leading-snug">
                    {SESSION_UNAVAILABLE}
                  </span>
                  {doneMode ? (
                    <button
                      type="button"
                      className="text-[13px] zen-glass zen-glass-pill"
                      style={{ minHeight: 32, padding: "0 12px", color: "#fff" }}
                      onClick={() => returnToDrawerOrigin()}
                    >
                      Open main chat
                    </button>
                  ) : null}
                </div>
              ) : source === "error" && error ? (
                <span className="text-[11px] text-[var(--warning)] px-2">
                  {asErrorText(error)}
                </span>
              ) : null}
              {empty ? (
                <span
                  className="text-[11px] text-[var(--text-muted)] px-2"
                  data-testid="thread-empty"
                >
                  No messages yet
                </span>
              ) : null}
              {!limited && ((hasMore && source === "live") || firstShown > 0) ? (
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
              {topSpacer > 0 ? (
                <div
                  key="__win-above"
                  aria-hidden="true"
                  className="shrink-0"
                  data-testid="thread-window-above"
                  // Exactly its height in the flow: the gap after it is
                  // taken back (the rows it stands for had theirs).
                  style={{ height: topSpacer, marginBottom: "calc(var(--spacing, 0.25rem) * -1)" }}
                />
              ) : null}
              {rows.map(({ key, m, out }, i) => {
                // Outside the render window: not drawn (a spacer stands in).
                if (!out && (i < firstShown || i >= lastShown)) {
                  return i === thread.length - 1 && bottomSpacer > 0 ? (
                    <div
                      key="__win-below"
                      aria-hidden="true"
                      className="shrink-0"
                      data-testid="thread-window-below"
                      style={{ height: bottomSpacer, marginTop: "calc(var(--spacing, 0.25rem) * -1)" }}
                    />
                  ) : null;
                }
                const run = runs[i];
                // Files ride Thread messages only (not project chat lines,
                // not this phone's own optimistic sends).
                const files = filesOn && !out && !groupId && m.files?.length ? m.files : null;
                const wordless = !m.text.trim() && !m.choice;
                // Files-only, on a server without the feature: nothing to draw.
                if (wordless && !files && !out && m.files?.length) return null;
                const flying = fly?.localId === key;
                return (
                  <ThreadRow
                    key={key}
                    rowKey={key}
                    windowed={!out}
                    m={m}
                    out={out}
                    files={files}
                    runFirst={run.first}
                    runLast={run.last}
                    spaced={run.first && i > 0}
                    stub={source === "stub"}
                    highlighted={highlightSeq != null && m.seq != null && m.seq === highlightSeq}
                    receipt={i === receiptIdx && receipt ? receipt : undefined}
                    canAnswer={
                      !out &&
                      canSend &&
                      !threadGroupId &&
                      (source === "live" || source === "error")
                    }
                    answerHeld={cachedOnly}
                    answering={!out && answeringId === m.id}
                    answerError={!out && answerErrorId === m.id ? answerError : null}
                    flying={flying && !fly?.fade}
                    fadeIn={flying && Boolean(fly?.fade)}
                    canRestore={out?.status === "failed" && draftBlank && !attachments.length}
                    onFileLink={openFileFromPath}
                    onAnswer={onAnswerRow}
                    onRetry={onRetryRow}
                    onRestore={onRestoreRow}
                    onOpenFile={onOpenFileRow}
                  />
                );
              })}
            </>
          )}
        </div>
        {/* Room for the composer bar's bottom gap (home indicator at
            rest, 8px over the keyboard): eases with the bar's padding on
            the keyboard's timing (index.css). Outside the content, so the
            content ResizeObserver does not fire through the ease. */}
        <div
          aria-hidden="true"
          className="zen-composer-gap mchat-gap shrink-0"
          data-testid="thread-composer-gap"
        />
        {/* The keyboard's height while a finger drags it down (else empty):
            the column is full height then, and this keeps the list's
            scroll range — and so what is on screen — where it was. */}
        <div
          ref={kbPadRef}
          aria-hidden="true"
          className="shrink-0"
          data-testid="thread-kb-drag-pad"
        />
      </div>
      {/* The composer floats over the scroller's bottom, on the header's
          blur stack flipped: messages pass under it and soften instead of
          stopping at its top edge. The pane is sized to the visual
          viewport, so bottom 0 is the keyboard's top while typing. */}
      <div
        ref={dockRef}
        className="absolute left-0 right-0 bottom-0"
        style={{ zIndex: 2 }}
        data-testid="thread-composer-dock"
      >
        <ZenFooterBlur
          testId="thread-footer-blur"
          style={{ left: 0, right: 0, bottom: 0, top: -(FOOTER_BLUR_FADE_PX + drawerCover) }}
        />
        {/* Zero-height row: the pill floats just above the composer (and
            above the working drawer while it shows). */}
        <div className="relative h-0 shrink-0" style={{ zIndex: 1 }}>
          <div
            aria-live="polite"
            className="absolute left-0 right-0 flex justify-center pointer-events-none"
            style={{ bottom: 8 + drawerCover }}
          >
            {newBelow ? (
              <button
                type="button"
                data-testid="thread-new-message"
                className="pointer-events-auto zen-glass zen-glass-pill zen-pill-in text-[13px]"
                style={{ minHeight: 32, padding: "0 14px", color: "#fff" }}
                // Keep focus in the textarea so the iOS keyboard stays up:
                // a blur drops the keyboard, the pill moves with the
                // composer, and the tap misses it (send button pattern).
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onNewBelow}
              >
                New message <span aria-hidden="true">↓</span>
              </button>
            ) : null}
          </div>
        </div>
        {/* Above the blur (positioned, z 0): its own stacking layer. */}
        <div className="relative" style={{ zIndex: 1 }}>
          <ThreadDraftComposer
            draftKey={draftKey}
            apiRef={draftApi}
            onBlankChange={setDraftBlank}
            hasAttachments={attachments.length > 0}
            inFlight={inFlight}
            onAttach={queueFiles}
            onAttachError={setAttachError}
            onSubmit={onSend}
            placeholder={placeholder}
            disabled={!canSend}
            canSend={canSend}
            attachDisabled={!canAttach}
            textareaRef={composerRef}
            smoothClear
            onFocus={() => {
              window.scrollTo(0, 0);
              follow();
            }}
            drawer={
              // The working drawer, pulled out of the field's top edge.
              !threadGroupId ? (
                <ThreadWorkingStrip
                  key={`${agentId}|${conversationId ?? ""}`}
                  turn={turn}
                  onSpace={setDrawerSpace}
                />
              ) : undefined
            }
            drawerRoom={rowsAboveField ? drawerSpace : 0}
            onBlockHeight={composerResized}
          >
            {roomBanner}
            <p
              className="text-[11px] text-[var(--text-muted)] leading-snug break-words mb-1.5"
              data-testid="composer-label"
            >
              {composerLabel}
            </p>
            {attachments.length ? (
              <div
                ref={chipsRef}
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
          </ThreadDraftComposer>
        </div>
      </div>
      {openFile ? (
        <AttachmentSheet
          key={`${openFile.scope.id}|${openFile.ref.id}|${openFile.file.n}`}
          open={openFile}
          onClose={() => setOpenFile(null)}
          onState={(state) =>
            patchThreadFileState(openFile.scope.id, openFile.ref.id, openFile.file.n, state)
          }
        />
      ) : null}
    </div>
  );
}