import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { GlassComposer, composerPlaceholder } from "./GlassComposer";
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
import {
  outgoingBubble,
  sendInFlight,
  threadRoomKey,
  visibleOutgoing,
  type OutgoingMessage,
} from "./outbox";
import {
  fontPxOf,
  prefersReducedMotion,
  rectOf,
  runSendFly,
  type FlySource,
} from "./sendFly";
import "./sendFly.css";

export { COMPOSER_MAX_PX, composerHeight } from "./GlassComposer";

/** `.chat-markdown`'s 14px, scaled by Settings → Text Size. */
const BUBBLE_TEXT_PX = 14;

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
}) {
  const secret = m.kind === "secret";
  const choice = secret ? null : m.choice;
  const answered =
    choice != null && choice.answer != null && String(choice.answer) !== "";
  return (
    <div
      className={`px-3 py-2 leading-snug break-words min-w-0 max-w-full overflow-hidden${fadeIn ? " zen-bubble-fade" : ""}`}
      data-testid="thread-bubble"
      data-fly-target={flying ? "true" : undefined}
      style={{
        visibility: flying ? "hidden" : undefined,
        // Settings → Text Size; the markdown body below scales the same way.
        fontSize: zenTextPx(17),
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

/** Scroller bottom padding: its own, plus the working drawer's room. */
export function threadBottomPadding(drawerSpace: number): string | undefined {
  if (!Number.isFinite(drawerSpace) || drawerSpace <= 0) return undefined;
  return `${THREAD_BOTTOM_PAD + Math.ceil(drawerSpace)}px`;
}

export function ThreadPane({
  viewportHeight,
  topInset,
  covered = false,
  roomBanner = null,
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
  const sendError = useZenStore((s) => s.sendError);
  const openFileFromPath = useZenStore((s) => s.openFileFromPath);
  const roomBlocked = Boolean(roomBanner);
  const canSend =
    !roomBlocked &&
    (source === "live" ||
      (source === "error" && isSendableAddr(threadAddr))) &&
    (Boolean((threadGroupId || "").trim()) || isSendableAddr(threadAddr));
  const attachWorkspace = workspaceHandleOf(threadAddr);
  const agent = agents.find((a) => a.id === agentId);
  const attachDir = uploadDirOf(agent?.path);
  const placeholder = composerPlaceholder(
    (threadGroupId || "").trim()
      ? { name: agent?.name, kind: "group" }
      : { name: agent?.name, addr: threadAddr || agent?.addr }
  );
  const canAttach = canSend && Boolean(attachWorkspace) && Boolean(attachDir);
  // The room's server: the overlay socket redials only on its own server.
  const zenServer = useZenScope().id;
  const [draft, setDraft] = useState("");
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
  const [fly, setFly] = useState<{
    localId: string;
    /** The typed text, to find the bubble once the server's copy replaced it. */
    text: string;
    beforeIds: Set<string>;
    source: FlySource | null;
    /** Reduced motion / no Web Animations: fade instead of fly. */
    fade: boolean;
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
  // Our own scrolls: their scroll events must not read as the reader's.
  const ownTop = useRef<number | null>(null);
  const lastTop = useRef(0);
  const followRaf = useRef(0);
  const drawerRaf = useRef(0);
  // Room (px) the working drawer takes above the composer. It floats over
  // the scroller, so the scroller pads its bottom by it (same 200ms ease).
  const [drawerSpace, setDrawerSpace] = useState(0);
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
    setDraft("");
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

  // The working drawer opening, growing (tap), shrinking or closing
  // changes the scroller's bottom padding, not its content: the tail
  // moves by that much. Stick through the padding's ease.
  useLayoutEffect(() => {
    followFor(DRAWER_MS + 80);
  }, [drawerSpace]);

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

  /** Upload what is left of an outgoing message's files, then POST it.
   *  Any failure leaves its bubble "Not sent" (retry / put back). */
  async function deliver(localId: string) {
    const store = useZenStore.getState;
    const entry = store().outbox.find((o) => o.localId === localId);
    if (!entry) return;
    store().patchOutgoing(localId, { status: "sending", error: null });
    const failed = (error: string) =>
      store().patchOutgoing(localId, { status: "failed", error });
    const paths = [...entry.paths];
    if (entry.files.length) {
      if (!entry.attachWorkspace || !entry.attachDir) {
        failed("Files are per workspace, not per project chat.");
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
      setAttachError("Files are per workspace, not per project chat.");
      return;
    }
    onComposerInput?.();
    // Where the text sits now, before it is cleared (the FLIP "first").
    const field = text.trim() ? composerRef.current : chipsRef.current;
    const rect = rectOf(field);
    const fontPx = text.trim()
      ? fontPxOf(composerRef.current)
      : fontPxOf(chipsRef.current?.firstElementChild);
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    const localId = st.queueOutgoing({
      text: text.trim(),
      files,
      attachWorkspace: files.length ? attachWorkspace : null,
      attachDir: files.length ? attachDir : null,
    });
    const reduced = prefersReducedMotion();
    const canFly =
      !reduced &&
      rect != null &&
      typeof Element !== "undefined" &&
      typeof Element.prototype.animate === "function";
    setFly({
      localId,
      text: text.trim(),
      beforeIds: new Set(st.thread.map((m) => m.id)),
      source: canFly ? { rect, fontPx: Number.isFinite(fontPx) ? fontPx : 17 } : null,
      fade: !canFly,
    });
    // The reader just spoke: the agent's reply must come into view.
    setFollowing(true);
    composerRef.current?.focus({ preventScroll: true });
    void deliver(localId);
  }

  /** "New message ↓": glide to the newest and follow again. */
  function onNewBelow() {
    const el = scrollerRef.current;
    setFollowing(true);
    if (!el) return;
    if (typeof el.scrollTo === "function" && !prefersReducedMotion()) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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

  // The flying bubble: its optimistic copy, or the server's copy if that
  // already replaced it (fast echo) — never both on screen.
  const flyOutgoing = fly ? outgoing.find((o) => o.localId === fly.localId) : undefined;
  let flyThreadId: string | null = null;
  if (fly && !flyOutgoing) {
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i];
      if (m.mine && !fly.beforeIds.has(m.id) && (m.text || "").trim().startsWith(fly.text)) {
        flyThreadId = m.id;
        break;
      }
    }
  }
  const flyKey = fly ? fly.localId : "";

  // FLIP "last/invert/play": the bubble is laid out (hidden) at its final
  // spot; scroll it into view, then fly a clone there from the composer.
  useLayoutEffect(() => {
    if (!fly) return;
    const id = fly.localId;
    const clear = () => setFly((cur) => (cur?.localId === id ? null : cur));
    setFollowing(true);
    const el = scrollerRef.current;
    if (el) stick(el);
    if (fly.fade || !fly.source) {
      const t = setTimeout(clear, 220);
      return () => clearTimeout(t);
    }
    const root = rootRef.current;
    const bubble = root?.querySelector<HTMLElement>('[data-fly-target="true"]');
    if (!root || !bubble) {
      clear();
      return;
    }
    return runSendFly({ root, bubble, source: fly.source, done: clear });
    // Once per send: a re-render mid-flight must not restart it.
  }, [flyKey]);

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
        className="zen-thread-scroller flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-2.5 py-3 flex flex-col"
        style={{
          overflowAnchor: "none",
          paddingTop: threadTopPadding(topInset),
          paddingBottom: threadBottomPadding(drawerSpace),
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
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
                  data-highlight={highlightSeq != null && m.seq === highlightSeq ? "true" : undefined}
                  className={`flex flex-col max-w-[78%] min-w-0 ${m.mine ? "self-end items-end" : "self-start items-start"}`}
                  style={
                    highlightSeq != null && m.seq === highlightSeq
                      ? { borderRadius: 20, boxShadow: "0 0 0 2px rgba(10,132,255,.85)", transition: "box-shadow .4s" }
                      : undefined
                  }
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
                    flying={flyThreadId === m.id && !fly?.fade}
                    fadeIn={flyThreadId === m.id && fly?.fade}
                  />
                  <span className="text-[11px] text-[var(--text-muted)] px-2 mt-0.5">
                    {m.failed ? "Not sent" : m.pending ? "Sending…" : mountainTime(m.at)}
                  </span>
                </div>
              ))}
              {outgoing.map((o) => {
                const m = outgoingBubble(o);
                const flying = fly?.localId === o.localId;
                return (
                  <div
                    key={o.localId}
                    data-thread-msg=""
                    data-outgoing={o.status}
                    className="flex flex-col max-w-[78%] min-w-0 self-end items-end"
                  >
                    <Bubble
                      m={m}
                      onFileLink={openFileFromPath}
                      canAnswer={false}
                      answering={false}
                      answerError={null}
                      onAnswer={() => {}}
                      attachments={o.files.map(uploadFilename)}
                      flying={flying && !fly?.fade}
                      fadeIn={flying && fly?.fade}
                    />
                    {o.status === "failed" ? (
                      <span
                        className="flex items-center gap-2 text-[11px] px-2 mt-0.5"
                        data-testid="outgoing-failed"
                      >
                        <button
                          type="button"
                          className="text-[var(--warning)]"
                          data-testid="outgoing-retry"
                          aria-label="Not sent. Tap to retry"
                          title={o.error || undefined}
                          onClick={() => onRetry(o.localId)}
                        >
                          Not sent · Retry
                        </button>
                        {!draft.trim() && !attachments.length ? (
                          <button
                            type="button"
                            className="text-[var(--text-muted)]"
                            data-testid="outgoing-restore"
                            onClick={() => onRestore(o)}
                          >
                            Edit
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-[11px] text-[var(--text-muted)] px-2 mt-0.5">
                        Sending…
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
      {/* Zero-height row: the pill floats just above the composer (and
          above the working drawer while it shows). */}
      <div className="relative h-0 shrink-0">
        <div
          aria-live="polite"
          className="absolute left-0 right-0 flex justify-center pointer-events-none"
          style={{ bottom: 8 + drawerSpace }}
        >
          {newBelow ? (
            <button
              type="button"
              data-testid="thread-new-message"
              className="pointer-events-auto zen-glass zen-glass-pill text-[13px]"
              style={{ minHeight: 32, padding: "0 14px", color: "#fff" }}
              onClick={onNewBelow}
            >
              New message <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>
      </div>
      {/* Zero-height row: the working drawer docks on the composer's top
          edge and floats over the scroller's padded bottom. */}
      <div className="relative h-0 shrink-0" data-testid="thread-drawer-dock">
        {!threadGroupId ? (
          <ThreadWorkingStrip
            key={`${agentId}|${conversationId ?? ""}`}
            turn={turn}
            onSpace={setDrawerSpace}
          />
        ) : null}
      </div>
      <GlassComposer
        value={draft}
        onChange={setDraft}
        onAttach={queueFiles}
        onSubmit={onSend}
        placeholder={placeholder}
        disabled={!canSend}
        canSend={canSend}
        sendReady={sendReady}
        attachDisabled={!canAttach}
        textareaRef={composerRef}
        onFocus={() => {
          window.scrollTo(0, 0);
          follow();
        }}
      >
        {roomBanner}
        <p
          className="text-[11px] text-[var(--text-muted)] leading-snug break-words mb-1.5"
          data-testid="composer-label"
        >
          {source === "stub"
            ? "STUB — Cannot send — POST /cli/thread/post not proven"
            : attachError
              ? attachError
              : sendError
                ? sendError
                : canSend || roomBlocked
                  ? ""
                  : source === "live"
                    ? "Not chattable"
                    : ""}
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
  );
}