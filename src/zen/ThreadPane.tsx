import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDeliverBrighten } from "./useDeliverBrighten";
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
import { GlassComposer, composerPlaceholder, settledHeight } from "./GlassComposer";
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
import { DRAWER_MS, ThreadWorkingStrip } from "./ThreadWorkingStrip";
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
  type FlySource,
} from "./sendFly";
import { queueSend, requeueIfUnreachable, shouldQueueSend, useQueuedSendFlush } from "./sendQueue";
import "./sendFly.css";
import { newestSeenSeq, type RowRef } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { useMarkReadWhileViewing } from "./unreadRead";
import { MessageFiles, patchThreadFileState, useThreadFilesOn } from "./ThreadFiles";
import { AttachmentSheet, type OpenAttachment } from "./AttachmentSheet";
import type { ThreadAttachment } from "../api/threadAttachmentPure";

/** No workspace folder to upload into (no usable path / no PoC yet). */
const ATTACH_UNAVAILABLE = "Files need this chat's workspace folder.";

export { COMPOSER_MAX_PX, composerHeight } from "./GlassComposer";

/** `.chat-markdown`'s 14px, scaled by Settings → Text Size. */
const BUBBLE_TEXT_PX = 14;
/** How long the "New message ↓" glide gets before a jump finishes it. */
export const NEW_BELOW_SETTLE_MS = 450;

function Bubble({
  m,
  onFileLink,
  canAnswer,
  answering,
  answerError,
  onAnswer,
  attachments,
  flying,
  fadeIn,
  breathe,
}: {
  m: ThreadMessage;
  onFileLink?: (ref: string) => void;
  canAnswer: boolean;
  answering: boolean;
  answerError: string | null;
  onAnswer: (option: string) => void;
  /** An outgoing bubble's file names (uploads may still be running). */
  attachments?: string[];
  /** Laid out but hidden while its send animation flies in. */
  flying?: boolean;
  /** Reduced motion: just fade in. */
  fadeIn?: boolean;
  /** Sending (landed, not yet delivered): a gentle opacity breathe. */
  breathe?: boolean;
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
      className={`px-3 py-2 leading-snug break-words min-w-0 max-w-full overflow-hidden${fadeIn ? " zen-bubble-fade" : breathing ? " zen-bubble-breathe" : ""}`}
      data-testid="thread-bubble"
      data-fly-target={flying ? "true" : undefined}
      style={{
        visibility: flying ? "hidden" : undefined,
        // Settings → Text Size; the markdown body below scales the same way.
        fontSize: zenTextPx(17),
        borderRadius: 18,
        background: m.mine ? "#0a84ff" : "#3a3a3c",
        color: "#fff",
        // Sending: dimmed. Delivered: it only brightens, gradually
        // (useDeliverBrighten); nothing moves.
        opacity: m.pending ? 0.7 : 1,
      }}
    >
      {choice ? (
        <div>
          {choice.prompt ? (
            <ChatMessageBody
              text={choice.prompt}
              className="!p-0 text-white"
              style={{ color: "#fff", fontSize: zenTextPx(BUBBLE_TEXT_PX) }}
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
        <>
          {m.text.trim() ? (
            <ChatMessageBody
              text={m.text}
              className="!p-0 text-white"
              style={{ color: "#fff", fontSize: zenTextPx(BUBBLE_TEXT_PX) }}
              onFileLink={onFileLink}
            />
          ) : null}
          {attachments?.length ? (
            <div
              className={`flex flex-col gap-0.5 ${m.text.trim() ? "mt-1" : ""}`}
              data-testid="bubble-attachments"
            >
              {attachments.map((name, i) => (
                <span
                  key={`${name}-${i}`}
                  className="text-[13px] opacity-90 truncate"
                  data-testid="bubble-attachment"
                >
                  {name}
                </span>
              ))}
            </div>
          ) : null}
        </>
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

/** How far (px) the newest message rests above the pane's bottom: the
 *  composer block floating over the scroller's bottom (rows above the
 *  field, the field, the safe-area / keyboard gap) plus what the working
 *  drawer covers above the bar. */
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

export function ThreadPane({
  viewportHeight,
  topInset,
  covered = false,
  roomBanner = null,
  roomQueuesInput = false,
  onComposerInput,
}: {
  viewportHeight?: number;
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
  const draftKey = composerDraftKey(zenServer, threadGroupId, threadAddr);
  const [draft, setDraftText] = useState(() => composerDraftOf(draftKey));
  function setDraft(text: string) {
    setDraftText(text);
    useComposerDrafts.getState().setDraft(draftKey, text);
  }
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Optimistic sends (iMessage): this room's bubbles not yet confirmed.
  const roomKey = threadRoomKey(zenServer, threadGroupId, threadAddr);
  const outgoing = visibleOutgoing(outbox, thread, roomKey);
  // Double-send guard: one send in flight per room. Typing stays open.
  const inFlight = outgoing.some((o) => o.status === "sending");
  const sendReady = Boolean(draft.trim() || attachments.length) && !inFlight;
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
    if (!el || !following.current || pendingAnchor.current) return;
    stick(el);
    if (typeof requestAnimationFrame !== "function") return;
    cancelAnimationFrame(followRaf.current);
    followRaf.current = requestAnimationFrame(() => {
      const cur = scrollerRef.current;
      if (cur && following.current && !pendingAnchor.current) stick(cur);
    });
  }

  /** follow(), then keep sticking every frame for `ms`: the scroller's
   *  bottom padding is easing with the drawer. */
  function followFor(ms: number) {
    follow();
    if (typeof requestAnimationFrame !== "function") return;
    const until = Date.now() + ms;
    const tick = () => {
      const el = scrollerRef.current;
      if (!el || !following.current || pendingAnchor.current) return;
      stick(el);
      if (Date.now() < until) drawerRaf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(drawerRaf.current);
    drawerRaf.current = requestAnimationFrame(tick);
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
      setNewBelow(false);
      following.current = focusSeq == null;
      setAtNewest(true);
      stick(el);
      follow();
    } else if (following.current) {
      follow();
    } else if (lastMsg && last !== prevLast.current && !lastMsg.mine && !lastMsg.pending) {
      // Reading history: never yank. Offer the jump instead.
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

  // Push tap `?seq=`: land on that message (after the stick above).
  const highlightSeq = useThreadFocusSeq(scrollerRef);

  useLayoutEffect(() => {
    setDraftText(composerDraftOf(draftKey));
  }, [draftKey]);

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
    viewing: source === "live" && !covered && atNewest && focusSeq == null,
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

  // Keyboard open/close: Zen sizes the column to the visual viewport, so
  // the scroller shrinks with scrollTop unchanged and the newest message
  // would slide under the composer. Re-stick if the reader was there.
  useLayoutEffect(() => {
    if (viewportHeight == null) return;
    follow();
  }, [viewportHeight]);

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
  // changes the scroller's bottom padding, not its content: the tail
  // moves by that much. Stick through the padding's ease.
  useLayoutEffect(() => {
    followFor(DRAWER_MS + 80);
  }, [drawerSpace, drawerCover]);

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
    const text = draft;
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
    setDraft("");
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
    if (draft.trim() || attachments.length) return;
    setDraft(o.text);
    setAttachments(o.files);
    useZenStore.getState().dropOutgoing(o.localId);
    composerRef.current?.focus({ preventScroll: true });
  }

  const flyKey = fly ? fly.localId : "";

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
    // A multi-line field eases shut over the flight (smoothClear): pad for
    // where it ends, so the bubble is aimed at its final slot.
    const bar = root?.querySelector<HTMLElement>('[data-testid="composer-bar"]');
    const barPx = bar ? settledHeight(bar) : 0;
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
    const glide =
      el && Math.abs(dy) >= 1 && Math.abs(dy) <= el.clientHeight
        ? { content: contentRef.current, dy }
        : undefined;
    return runSendFly({ root, bubble, target, source: fly.source, done: clear, glide });
    // Once per send: a re-render mid-flight must not restart it.
  }, [flyKey]);

  // One list, one key per message: a send's row is keyed by its localId
  // from tap to delivered (the server's copy inherits it), so it is the
  // same element throughout — no remount, never two, never none.
  const rowKeys = landedRowKeys(outbox, thread, roomKey, landedKeys);
  const rows: { key: string; m: ThreadMessage; out: OutgoingMessage | null }[] = thread.map(
    (m, i) => ({ key: rowKeys.get(m.id) ?? (m.id || `seq-${m.seq ?? i}`), m, out: null })
  );
  for (const o of outgoing) rows.push({ key: o.localId, m: outgoingBubble(o), out: o });

  const empty =
    (source === "live" || source === "stub") &&
    !error &&
    thread.length === 0 &&
    outgoing.length === 0;

  return (
    <div
      ref={rootRef}
      className="relative flex flex-col flex-1 min-h-0 min-w-0 overflow-x-hidden"
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
          setAtNewest(nearNewest(el));
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
        <div
          ref={contentRef}
          data-testid="thread-content"
          className="shrink-0 min-w-0 flex flex-col gap-1"
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
              {rows.map(({ key, m, out }) => {
                // Files ride Thread messages only (not project chat lines,
                // not this phone's own optimistic sends).
                const files = filesOn && !out && !groupId && m.files?.length ? m.files : null;
                const wordless = !m.text.trim() && !m.choice;
                // Files-only, on a server without the feature: nothing to draw.
                if (wordless && !files && !out && m.files?.length) return null;
                const bubble = !(files && wordless);
                const flying = fly?.localId === key;
                const highlighted = highlightSeq != null && m.seq != null && m.seq === highlightSeq;
                return (
                  <div
                    key={key}
                    data-thread-msg=""
                    data-seq={m.seq ?? undefined}
                    data-outgoing={out?.status}
                    data-highlight={highlighted ? "true" : undefined}
                    className={`flex flex-col max-w-[78%] min-w-0 ${m.mine ? "self-end items-end" : "self-start items-start"}`}
                    style={
                      highlighted
                        ? { borderRadius: 20, boxShadow: "0 0 0 2px rgba(10,132,255,.85)", transition: "box-shadow .4s" }
                        : undefined
                    }
                  >
                    {/* Theirs: name and time on one line above the bubble.
                        Mine: no name; the time (or Sending… / Not sent) stays
                        below, where the outgoing status and its actions sit. */}
                    {!m.mine ? (
                      <span
                        className="flex items-baseline gap-1.5 text-[11px] text-[var(--text-muted)] px-3 mb-0.5 min-w-0 max-w-full"
                        data-testid="thread-msg-meta"
                      >
                        <span className="truncate min-w-0">
                          {source === "stub" ? <StubMark /> : null}
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
                        onFileLink={openFileFromPath}
                        canAnswer={
                          !out &&
                          canSend &&
                          !threadGroupId &&
                          (source === "live" || source === "error")
                        }
                        answering={!out && answeringId === m.id}
                        answerError={!out && answerErrorId === m.id ? answerError : null}
                        onAnswer={(option) => void answerChoice(m.id, option)}
                        attachments={out?.files.length ? out.files.map(uploadFilename) : undefined}
                        flying={flying && !fly?.fade}
                        fadeIn={flying && fly?.fade}
                        breathe={out?.status === "sending"}
                      />
                    ) : null}
                    {files ? (
                      <MessageFiles
                        files={files}
                        mine={m.mine}
                        hasBubble={bubble}
                        onOpen={(a) => openAttachment(m, a)}
                      />
                    ) : null}
                    {m.mine ? (
                      // One box from Send to delivered: "Sending…", then the
                      // time (or "Not sent · Retry"). Fixed height, so the
                      // swap never moves the bubble or the rows around it.
                      <span
                        className="flex items-center gap-2 h-4 leading-4 whitespace-nowrap text-[11px] text-[var(--text-muted)] px-2 mt-0.5"
                        data-testid="thread-msg-time"
                        data-status={out?.status ?? (m.failed ? "failed" : m.pending ? "sending" : "sent")}
                      >
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
                            {!draft.trim() && !attachments.length ? (
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
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
      {/* The composer floats over the scroller's bottom, on the header's
          blur stack flipped: messages pass under it and soften instead of
          stopping at its top edge. The pane is sized to the visual
          viewport, so bottom 0 is the keyboard's top while typing. */}
      <div
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
                className="pointer-events-auto zen-glass zen-glass-pill text-[13px]"
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
          <GlassComposer
            value={draft}
            onChange={setDraft}
            onAttach={queueFiles}
            onAttachError={setAttachError}
            onSubmit={onSend}
            placeholder={placeholder}
            disabled={!canSend}
            canSend={canSend}
            sendReady={sendReady}
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
          </GlassComposer>
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