// A DM or a channel on Home (K2 0.46.13 `home-chat-v1`; brief §2.9), in
// the Thread's look. Its DATA is not the Thread's: messages come from the
// chat's server (`/cli/home-chat/*`, `WS /cli/home-chat/events`), never the
// agent Thread store.
//
// What it reuses from the Thread: the bubbles and runs (chatRuns, the
// tails in chatBubbles.css), the floating header's glass, the composer
// (ThreadDraftComposer / GlassComposer, drafts kept per conversation), the
// message hold menu (useMessageHold + AgentMenu), the reply chip and quote
// line, the jump pill, and the mobile chat kit (keyboard FLIP, interactive
// dismiss, scroll room, focus gap, tap to dismiss).
//
// What differs:
//   - names over every run in a channel; in a DM only the other person's;
//   - the hold menu has the six quick emoji across its top (K2 Design),
//     then Reply, Copy and More emoji…; chips under bubbles;
//   - Reply sends Sew's reference (`replyTo`), and the quote strip jumps
//     to the original, paging back up to 20 pages;
//   - who is typing on the composer's edge; the box sends `typing` at most
//     every 8 s;
//   - read: `view {open}` while on screen, `ack` for the newest while the
//     app is in front;
//   - a call's record is a line with Call back (the calls part's hook);
//   - a channel's header opens its members sheet.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { scopeFor } from "../../api/scope";
import { ackHomeChat, homeChatGateNow, onHomeChatGate, viewHomeChat } from "../../api/homeChat";
import { subscribeHomeChat } from "../../api/homeChatEvents";
import { REPLY_JUMP_MAX_PAGES, isOptimistic, typingMembers } from "../../api/homeChatHelpers";
import type { HomeChatMessage } from "../../api/homeChatPure";
import { copyPlainText } from "../../lib/clipboard";
import { useViewport, useViewportPadRef } from "../../lib/useViewportHeight";
import { useKeyboardFlip } from "../../kit/mobileChat/useKeyboardFlip";
import { easeGapShift, useComposerFocusGap } from "../../kit/mobileChat/useComposerFocusGap";
import { CHAT_CONTENT_CLASS, useScrollRoom } from "../../kit/mobileChat/useScrollRoom";
import { useKeyboardDrag } from "../../kit/mobileChat/useKeyboardDrag";
import { useTapToDismiss } from "../../kit/mobileChat/useTapToDismiss";
import { settledHeight } from "../GlassComposer";
import { ThreadDraftComposer, threadBottomPadding, type DraftApi } from "../ThreadPane";
import { FOOTER_BLUR_FADE_PX, ZenFooterBlur, useMeasuredHeight, underHeaderPadding } from "../ZenHeaderBlur";
import { HeaderGlass } from "../HeaderGlass";
import { AgentMenu, type AgentMenuEntry } from "../AgentMenu";
import { JumpPill } from "../JumpPill";
import { ReplyIcon } from "../icons";
import { ServerChip } from "../room/ServerChip";
import { useMessageHold } from "../stash/useMessageHold";
import { captureTopMessage, nearNewest, restoreTopMessage, stickToNewest, type MessageAnchor } from "../threadScroll";
import { composerDraftOf, useComposerDrafts } from "../composerDrafts";
import { prefersReducedMotion } from "../sendFly";
import {
  ORIGINAL_DELETED,
  ORIGINAL_NOT_LOADED,
  authorName,
  convKey,
  firstLine,
  homeChatRows,
  memberNames,
  replyPreview,
  sendFailedLine,
  typingNames,
  type HomeChatTarget,
  type JumpMiss,
} from "./homeChatModel";
import {
  EMPTY_CONV,
  useHomeChatCallHooks,
  useHomeChatStore,
  type HomeChatConversation,
} from "./homeChatStore";
import {
  applyHomeChatFrame,
  dropHomeChatSend,
  ensureHomeChatPeople,
  homeChatReactorNames,
  loadHomeChatChannel,
  loadHomeChatNewest,
  loadHomeChatOlder,
  noteHomeChatDraft,
  resolveHomeChatConv,
  retryHomeChatSend,
  sendHomeChat,
  toggleHomeChatReaction,
} from "./homeChatActions";
import { HomeChatCallLine, HomeChatMessageRow, type HomeChatRowActions } from "./HomeChatMessageRow";
import { EmojiSheet, QUICK_ROW_PX, QuickReactionRow } from "./HomeChatReactions";
import { HomeChatTyping } from "./HomeChatTyping";
import { HomeChatMembersSheet } from "./HomeChatMembersSheet";
import { ChannelAvatar, PersonAvatar } from "./HomeChatGlyphs";
import "./homeChat.css";

/** The header's resting height before it is measured. */
const HEADER_PX = 84;
const HEADER_AVATAR_PX = 42;
const HEADER_BTN = 36;
const HEADER_BTN_TOP = (HEADER_AVATAR_PX - HEADER_BTN) / 2;
/** Near the top: read the next older page this far before reaching it. */
const OLDER_AT_PX = 240;
/** Room kept under the newest message for the typing line. */
const TYPING_ROOM_PX = 20;
/** The wash on a jumped-to message lasts 1.2 s (plus a beat). */
const FLASH_MS = 1400;
const AVATAR_LIFT = "drop-shadow(0 3px 8px var(--color-shadow))";
const COMPOSER_PREFIX = "home-chat-composer";

/** The composer draft's key for a conversation. */
export function homeChatDraftKey(serverId: string, conv: string | null): string | null {
  return conv ? `${serverId}|homechat:${conv}` : null;
}

/** The dock's height above the bar's bottom gap (the scroller's
 *  `.mchat-gap` spacer adds that gap; TicketView's measure). */
function dockBlockPx(dock: HTMLElement): number {
  const h = settledHeight(dock);
  const bar = dock.querySelector<HTMLElement>(`[data-testid="${COMPOSER_PREFIX}-bar"]`);
  if (!bar) return h;
  let pad = 0;
  try {
    pad = parseFloat(getComputedStyle(bar).paddingBottom) || 0;
  } catch {
    pad = 0;
  }
  if (!(pad > 0)) return h;
  const base = dock.querySelector("[data-settled-height]") ? h : dock.getBoundingClientRect().height;
  return Math.max(0, Math.round(base - pad));
}

type PendingReply = { id: string; from: string; text: string };

export function HomeChatView({
  target,
  onBack,
  onCallBack,
  headerActions,
}: {
  target: HomeChatTarget;
  onBack: () => void;
  /** A call record's Call back (the calls part). Absent: the registered
   *  hook (`setHomeChatCallHooks`), else no button. */
  onCallBack?: (conversation: HomeChatConversation) => void;
  /** A DM header's right-hand buttons (the Call button). Absent: the
   *  registered hook. */
  headerActions?: ReactNode;
}) {
  const scope = scopeFor(target.serverId);
  const serverId = target.serverId;
  const dm = target.kind === "dm";

  // ── The conversation (a DM known by person is opened / made first) ──
  const [conv, setConv] = useState<string | null>(target.conversationId);
  const [convError, setConvError] = useState<string | null>(null);
  useEffect(() => {
    setConv(target.conversationId);
    setConvError(null);
    if (target.conversationId) return;
    let alive = true;
    void resolveHomeChatConv(scope, target).then((r) => {
      if (!alive) return;
      if ("conv" in r) setConv(r.conv);
      else setConvError(r.error);
    });
    return () => {
      alive = false;
    };
    // The target's identity, not its object.
  }, [serverId, target.kind, target.conversationId, target.ext]);
  const key = conv ? convKey(serverId, conv) : "";

  const state = useHomeChatStore((s) => (key ? (s.convs[key] ?? EMPTY_CONV) : EMPTY_CONV));
  const sends = useHomeChatStore((s) => (key ? s.sends[key] : undefined));
  const roster = useHomeChatStore((s) => (key ? s.typing[key] : undefined));
  const people = useHomeChatStore((s) => s.people[serverId]?.people ?? null);
  const channel = useHomeChatStore((s) => (key && !dm ? (s.channels[key] ?? null) : null));
  const me = people?.me.memberId ?? null;
  const names = useMemo(() => memberNames(people), [people]);
  const messages = state.messages;

  // ── The gate: chat switched off on this server ──
  const [gateOff, setGateOff] = useState(() => {
    const g = homeChatGateNow(scope);
    return g.feature && g.on === false;
  });
  useEffect(
    () =>
      onHomeChatGate((id, g) => {
        if (id === serverId) setGateOff(g.feature && g.on === false);
      }),
    [serverId]
  );

  // ── Reads, live frames, view / ack ──
  useEffect(() => {
    void ensureHomeChatPeople(scope);
  }, [scope]);
  useEffect(() => {
    if (!conv || dm) return;
    void loadHomeChatChannel(scope, conv);
  }, [scope, conv, dm]);
  useEffect(() => {
    if (!conv) return;
    void loadHomeChatNewest(scope, conv);
    void viewHomeChat(scope, conv, true);
    const unsub = subscribeHomeChat(
      scope,
      (f) => {
        applyHomeChatFrame(serverId, f);
        if (f.type === "member_removed" && f.conv === conv && !dm) void loadHomeChatChannel(scope, conv);
      },
      {
        // Back after a drop: frames may be missing. Read what came after.
        onLink: (info) => {
          if (info.up && info.reopened) {
            void loadHomeChatNewest(scope, conv);
            void viewHomeChat(scope, conv, true);
          }
        },
      }
    );
    // Typing names clear 10 s after their last frame.
    const prune = setInterval(() => useHomeChatStore.getState().pruneTyping(Date.now()), 1000);
    return () => {
      unsub();
      clearInterval(prune);
      void viewHomeChat(scope, conv, false);
    };
  }, [scope, serverId, conv, dm]);

  const real = useMemo(() => messages.filter((m) => !isOptimistic(m)), [messages]);
  const newestId = real.length ? real[real.length - 1].id : null;
  // Read up to the newest while the chat is on screen and the app in front.
  useEffect(() => {
    if (!conv || !newestId) return;
    const ack = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void ackHomeChat(scope, conv);
    };
    ack();
    const onVis = () => {
      if (document.visibilityState === "visible") ack();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [scope, conv, newestId]);

  // ── Who it is ──
  const person = dm && target.ext ? (people?.people.find((p) => p.ext === target.ext) ?? null) : null;
  const title = dm ? (person?.displayName || target.title) : channel?.name || target.title;
  const inviteOnly = channel ? !channel.open : (target.inviteOnly ?? null);
  const archived = channel?.state === "archived";
  // A DM whose other side left this server's list (disabled or removed)
  // is read-only; the daemon refuses its sends too.
  const personGone = dm && !!target.ext && people !== null && person === null && target.ext !== people.me.ext;
  const readOnly = archived || personGone;
  const conversation: HomeChatConversation | null = conv
    ? { serverId, kind: target.kind, conversationId: conv, title, ext: target.ext ?? null }
    : null;
  const hooks = useHomeChatCallHooks();
  const callBack = onCallBack ?? hooks.onCallBack;
  const HeaderActions = hooks.HeaderActions;

  // ── The list and the mobile chat kit (TicketView's wiring) ──
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragLayerRef = useRef<HTMLDivElement>(null);
  const topRoomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const kbPadRef = useViewportPadRef();
  const viewport = useViewport();
  const interactiveRef = useRef(viewport.interactive);
  interactiveRef.current = viewport.interactive;
  const lastScrollAt = useRef(0);
  const lastTop = useRef(0);
  const following = useRef(true);
  const [atNewest, setAtNewest] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [headerRef, headerPx] = useMeasuredHeight(HEADER_PX);
  const [dockPx, setDockPx] = useState(0);
  const dockPxRef = useRef<number | null>(null);

  const setFollowing = (on: boolean) => {
    following.current = on;
    setAtNewest(on);
    if (on) setNewCount(0);
  };

  // The dock floats over the scroller's bottom: measure it.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const read = () => {
      const px = dockBlockPx(dock);
      if (px === dockPxRef.current) return;
      dockPxRef.current = px;
      setDockPx(px);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(dock);
    return () => ro.disconnect();
  }, [readOnly]);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && following.current && !interactiveRef.current) stickToNewest(el);
  }, [dockPx]);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === h) return;
      h = el.clientHeight;
      if (following.current && !interactiveRef.current) stickToNewest(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stickIfFollowing = (): boolean => {
    const el = scrollerRef.current;
    if (!el || interactiveRef.current || !following.current) return false;
    stickToNewest(el);
    lastTop.current = el.scrollTop;
    return true;
  };
  const scrollRoom = useRef<{ dropNow(): void } | null>(null);
  useKeyboardFlip({
    viewportHeight: viewport.height,
    motion: viewport.motion,
    interactive: viewport.interactive,
    scroller: () => scrollerRef.current,
    docks: () => [dockRef.current],
    list: {
      isFollowing: () => following.current,
      lastScrollTop: () => lastTop.current,
      stick: stickIfFollowing,
      content: () => contentRef.current,
      beforeHide: () => scrollRoom.current?.dropNow(),
    },
  });
  scrollRoom.current = useScrollRoom({
    viewportHeight: viewport.height,
    scroller: () => scrollerRef.current,
    room: () => topRoomRef.current,
    content: () => contentRef.current,
    lastScrollAt: () => lastScrollAt.current,
    onScrollWrite: (top) => {
      lastTop.current = top;
    },
  });
  useKeyboardDrag({
    scroller: () => scrollerRef.current,
    dock: () => dockRef.current,
    layer: () => dragLayerRef.current,
    composerPx: dockPx > 0 ? dockPx + 8 : 0,
    enabled: !readOnly,
  });
  const barOf = () => rootRef.current?.querySelector<HTMLElement>(`[data-testid="${COMPOSER_PREFIX}-bar"]`) ?? null;
  useComposerFocusGap({
    root: () => rootRef.current,
    bar: barOf,
    onChange: () => {
      const before = lastTop.current;
      const el = scrollerRef.current;
      if (el && stickIfFollowing()) easeGapShift(contentRef.current, el.scrollTop - before);
    },
  });
  useTapToDismiss({ area: () => scrollerRef.current, composer: barOf });

  // New messages: keep the newest in view while following; else count
  // them for the pill. Your own send always comes into view.
  const prevNewest = useRef<{ key: string; id: string | null; len: number }>({ key: "", id: null, len: 0 });
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const prev = prevNewest.current;
    const last = messages.length ? messages[messages.length - 1] : null;
    const lastId = last?.id ?? null;
    prevNewest.current = { key, id: lastId, len: messages.length };
    if (!el) return;
    if (prev.key !== key || prev.id === null) {
      // Opened (or its first page came): land on the newest.
      stickToNewest(el);
      lastTop.current = el.scrollTop;
      return;
    }
    if (lastId === prev.id) return;
    const mineNow = !!last && (isOptimistic(last) || (!!me && last.authorId === me));
    if (following.current || mineNow) {
      if (mineNow) setFollowing(true);
      if (!interactiveRef.current) stickToNewest(el);
      lastTop.current = el.scrollTop;
      return;
    }
    setNewCount((n) => n + 1);
  }, [key, messages, me]);

  // ── Older pages: keep the message being read where it is ──
  const olderAnchor = useRef<MessageAnchor | null>(null);
  const rowsNow = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-home-chat-msg]") ?? []);
  const loadOlder = useCallback(async (): Promise<HomeChatMessage[] | null> => {
    if (!conv) return null;
    const el = scrollerRef.current;
    olderAnchor.current = el ? captureTopMessage(el, rowsNow()) : null;
    return loadHomeChatOlder(scope, conv);
  }, [scope, conv]);
  const firstId = messages.length ? messages[0].id : null;
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const a = olderAnchor.current;
    if (!el || !a) return;
    olderAnchor.current = null;
    restoreTopMessage(el, a);
    lastTop.current = el.scrollTop;
  }, [firstId]);
  const maybeOlder = () => {
    const el = scrollerRef.current;
    if (!el || !conv || !state.hasMore || state.loadingOlder || !state.loaded) return;
    if (el.scrollTop < OLDER_AT_PX) void loadOlder();
  };

  // ── Jump to a reply's original ──
  const [flashId, setFlashId] = useState<string | null>(null);
  const [jumpMiss, setJumpMiss] = useState<JumpMiss | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);
  const jump = useCallback(
    async (id: string) => {
      if (!conv) return;
      setJumpMiss(null);
      const cur = () => useHomeChatStore.getState().convs[convKey(serverId, conv)] ?? EMPTY_CONV;
      let read = 0;
      while (!cur().messages.some((m) => m.id === id) && cur().hasMore && read < REPLY_JUMP_MAX_PAGES) {
        const got = await loadOlder();
        if (!got) break;
        read += 1;
      }
      if (!cur().messages.some((m) => m.id === id)) {
        // Read back to the first message without it: it is gone.
        setJumpMiss({ id, gone: !cur().hasMore });
        return;
      }
      following.current = false;
      setAtNewest(false);
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-home-chat-msg="${id}"]`);
        row?.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        setFlashId(id);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashId((f) => (f === id ? null : f)), FLASH_MS);
      });
    },
    [conv, serverId, loadOlder]
  );

  // ── Reply, react ──
  const [reply, setReply] = useState<PendingReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emojiFor, setEmojiFor] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const react = useCallback(
    (msgId: string, emoji: string) => {
      if (!conv || readOnly) return;
      void toggleHomeChatReaction(scope, conv, msgId, emoji).then((err) => err && setError(err));
    },
    [scope, conv, readOnly]
  );

  // ── The composer ──
  const draftKey = homeChatDraftKey(serverId, conv);
  const draftApi = useRef<DraftApi | null>(null);
  const [draftBlank, setDraftBlank] = useState(() => !composerDraftOf(draftKey).trim());
  // Typing: the box's input, at most one `typing` per 8 s.
  useEffect(() => {
    const field = composerRef.current;
    if (!field || !conv) return;
    const onInput = () => noteHomeChatDraft(scope, conv, field.value);
    field.addEventListener("input", onInput);
    return () => field.removeEventListener("input", onInput);
  }, [scope, conv, readOnly]);
  useEffect(() => {
    const flush = () => useComposerDrafts.getState().flush();
    return () => flush();
  }, []);

  const onSend = () => {
    if (!conv || readOnly) return;
    const text = (draftApi.current?.get() ?? "").trim();
    if (!text) return;
    const replyTo = reply?.id ?? null;
    draftApi.current?.set("");
    setReply(null);
    setError(null);
    setJumpMiss(null);
    setFollowing(true);
    composerRef.current?.focus({ preventScroll: true });
    void sendHomeChat(scope, conv, { text, replyTo }).then((ok) => {
      if (ok) return;
      const failed = Object.values(useHomeChatStore.getState().sends[convKey(serverId, conv)] ?? {}).find(
        (s) => s.status === "failed" && s.pending.text === text
      );
      setError(sendFailedLine(failed?.error ?? ""));
    });
  };

  const actions = useMemo<HomeChatRowActions>(
    () => ({
      toggleReaction: react,
      whoReacted: (msgId, emoji) => homeChatReactorNames(scope, msgId, emoji),
      jump: (id) => void jump(id),
      retry: (nonce) => {
        if (!conv) return;
        setError(null);
        void retryHomeChatSend(scope, conv, nonce).then((ok) => !ok && setError(sendFailedLine("")));
      },
      edit: (nonce) => {
        if (!conv || (draftApi.current?.get() ?? "").trim()) return;
        const p = dropHomeChatSend(serverId, conv, nonce);
        if (!p) return;
        draftApi.current?.set(p.text);
        setError(null);
        composerRef.current?.focus({ preventScroll: true });
      },
    }),
    [react, scope, jump, conv, serverId]
  );

  // ── The hold menu: quick emoji, Reply, Copy, More emoji… ──
  const msgHold = useMessageHold(scrollerRef, true);
  const held = msgHold.menu ? (messages.find((m) => m.id === msgHold.menu?.id) ?? null) : null;
  const heldMine = useMemo(() => new Set(held?.reactions.filter((r) => r.me).map((r) => r.emoji) ?? []), [held]);
  const holdEntries: AgentMenuEntry[] = held
    ? [
        ...(!readOnly
          ? [
              {
                key: "reply",
                label: "Reply",
                icon: <ReplyIcon size={18} strokeWidth={1.75} />,
                onSelect: () => {
                  setReply({ id: held.id, from: authorName(held.authorId, me, names), text: held.body });
                  composerRef.current?.focus({ preventScroll: true });
                },
              },
            ]
          : []),
        { key: "copy", label: "Copy", onSelect: () => void copyPlainText(held.body) },
        ...(!readOnly
          ? [
              {
                key: "more-emoji",
                label: "More emoji…",
                icon: (
                  <span aria-hidden style={{ fontSize: 17, lineHeight: 1 }}>
                    ☺︎
                  </span>
                ),
                onSelect: () => setEmojiFor(held.id),
              },
            ]
          : []),
      ]
    : [];

  // ── Rows ──
  const rows = useMemo(() => homeChatRows(messages, me, names, target.kind), [messages, me, names, target.kind]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const typingNow = useMemo(
    () => typingNames(roster ? typingMembers(roster, Date.now(), me) : [], me, names),
    [roster, me, names]
  );

  const loading = !state.loaded && messages.length === 0 && !state.error && !convError;
  const failedToOpen: string | null =
    convError ?? (state.error && !state.loaded && messages.length === 0 ? state.error : null);
  const placeholder = dm ? `Message ${title}` : `Message ${inviteOnly ? "" : "#"}${title}`;
  const composerNote = error ?? (state.error && state.loaded ? state.error : null);

  return (
    <div
      ref={rootRef}
      className="mchat-pane absolute inset-0 flex flex-col min-w-0 overflow-x-hidden"
      style={{ background: "var(--color-bg)", fontFamily: "var(--zen-font)" }}
      data-testid="home-chat-view"
      data-kind={target.kind}
    >
      {/* The Thread's floating header: Back, the picture over the name
          bubble, and the right-hand slot (a DM's Call button). A channel's
          name opens its members sheet. */}
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="home-chat-header"
        style={{ zIndex: 10, paddingTop: "env(safe-area-inset-top)", pointerEvents: "none" }}
      >
        <div className="zen-header-blur" aria-hidden>
          <span className="zen-header-blur-1" />
          <span className="zen-header-blur-2" />
          <span className="zen-header-blur-3" />
          <span className="zen-header-blur-4" />
          <span className="zen-header-tint" />
        </div>
        <div
          ref={headerRef}
          className="relative grid items-start w-full min-w-0 px-3"
          style={{ gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", minHeight: HEADER_PX, paddingTop: 6, paddingBottom: 12 }}
        >
          <HeaderGlass />
          <div className="flex items-start justify-self-start" style={{ gridColumn: 1 }}>
            <button
              type="button"
              onClick={onBack}
              data-testid="home-chat-back"
              data-glass-shape="button"
              aria-label="Back"
              className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
              style={{ width: HEADER_BTN, height: HEADER_BTN, color: "var(--color-text-primary)", position: "relative", zIndex: 1, marginTop: HEADER_BTN_TOP, pointerEvents: "auto" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="relative min-w-0 flex flex-col items-center justify-center zen-header-text bg-transparent border-0 p-0"
            style={{ zIndex: 1, gridColumn: 2, pointerEvents: dm ? "none" : "auto", color: "inherit" }}
            data-testid="home-chat-title-button"
            aria-label={dm ? title : `${title}: members`}
            disabled={dm || !conv}
            onClick={() => setMembersOpen(true)}
          >
            <span className="relative flex" style={{ zIndex: 2, filter: AVATAR_LIFT }} data-testid="home-chat-header-avatar">
              {dm ? (
                <PersonAvatar username={person?.username || target.ext || title} name={title} picture={person?.picture ?? null} size={HEADER_AVATAR_PX} />
              ) : (
                <ChannelAvatar inviteOnly={inviteOnly} size={HEADER_AVATAR_PX} />
              )}
            </span>
            <span
              data-glass-shape="pill"
              className="flex flex-col items-center min-w-0 max-w-full zen-glass zen-glass-pill"
              style={{ position: "relative", zIndex: 1, marginTop: -8, padding: "10px 16px 7px" }}
            >
              <span className="block min-w-0 max-w-full text-[15px] font-bold truncate text-center" style={{ color: "var(--color-text-primary)" }} data-testid="home-chat-title">
                {!dm && !inviteOnly ? "#" : ""}
                {title}
              </span>
              {!dm && channel ? (
                <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-member-count">
                  {channel.people.length === 1 ? "1 person" : `${channel.people.length} people`}
                </span>
              ) : (
                <ServerChip serverId={serverId} testId="home-chat-server" />
              )}
            </span>
          </button>
          <div className="flex items-start justify-self-end" style={{ gridColumn: 3, gap: 8, marginTop: HEADER_BTN_TOP, pointerEvents: "auto" }} data-testid="home-chat-header-actions">
            {dm ? (headerActions ?? (HeaderActions ? <HeaderActions conversation={conversation} target={target} /> : null)) : null}
          </div>
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3"
        data-testid="home-chat-scroller"
        onScroll={(e) => {
          const el = e.currentTarget;
          lastScrollAt.current = Date.now();
          const prev = lastTop.current;
          lastTop.current = el.scrollTop;
          if (nearNewest(el)) {
            if (!following.current || !atNewest) setFollowing(true);
          } else if (el.scrollTop < prev - 1 && following.current) {
            following.current = false;
            setAtNewest(false);
          }
          maybeOlder();
        }}
        style={{
          overflowAnchor: "none",
          paddingTop: underHeaderPadding(headerPx, 8),
          // Plus the typing line's room, always kept (it never moves the list).
          paddingBottom: threadBottomPadding(dockPx, TYPING_ROOM_PX),
          WebkitOverflowScrolling: "touch",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        <div ref={topRoomRef} aria-hidden="true" />
        <div ref={dragLayerRef} aria-hidden="true" className="relative h-0" style={{ zIndex: 3 }} />
        <div ref={contentRef} className={`${CHAT_CONTENT_CLASS} min-w-0 flex flex-col`}>
          {gateOff ? (
            <p className="py-10 text-center text-[14px]" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-off">
              No chat on this server.
            </p>
          ) : failedToOpen ? (
            <div className="flex flex-col items-center gap-3 py-10" data-testid="home-chat-error">
              <p className="text-[15px]" style={{ color: "var(--color-text-primary)" }}>
                Couldn't open this chat.
              </p>
              <p className="text-[13px] text-center" style={{ color: "var(--color-text-muted)" }}>
                {failedToOpen}
              </p>
              {conv ? (
                <button
                  type="button"
                  className="text-[15px] zen-glass zen-glass-pill"
                  style={{ minHeight: 36, padding: "0 16px", color: "var(--color-text-primary)" }}
                  onClick={() => void loadHomeChatNewest(scope, conv)}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : loading ? (
            <p className="py-10 text-center text-[14px]" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-loading">
              Loading…
            </p>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-1 py-10 text-center" data-testid="home-chat-empty">
              <p className="text-[15px]" style={{ color: "var(--color-text-primary)" }}>
                No messages yet
              </p>
              <p className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>
                {dm ? `Send ${title} a message.` : `Messages here go to everyone in ${inviteOnly ? "" : "#"}${title}.`}
              </p>
            </div>
          ) : (
            <div ref={listRef} className="relative flex flex-col gap-1" data-testid="home-chat-list">
              {state.hasMore && state.loaded ? (
                <div className="flex justify-center py-1" style={{ minHeight: 32 }}>
                  {state.loadingOlder ? (
                    <span className="text-[12px]" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-older-loading">
                      Loading earlier messages…
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-[12px] bg-transparent border-0"
                      style={{ color: "var(--color-accent-text)" }}
                      data-testid="home-chat-older"
                      onClick={() => void loadOlder()}
                    >
                      Earlier messages
                    </button>
                  )}
                </div>
              ) : null}
              {rows.map((r) =>
                r.kind === "call" ? (
                  <HomeChatCallLine
                    key={r.m.id}
                    m={r.m}
                    me={me}
                    flash={flashId === r.m.id}
                    onCallBack={dm && callBack && conversation && !readOnly ? () => callBack(conversation) : undefined}
                  />
                ) : (
                  <HomeChatMessageRow
                    // By nonce when it has one: the server's copy takes over
                    // its optimistic bubble's element (no remount, no flash).
                    key={r.m.nonce ? `n:${r.m.nonce}` : r.m.id}
                    m={r.m}
                    mine={r.mine}
                    name={r.name}
                    run={r.run}
                    reply={r.m.replyTo ? replyPreview(byId.get(r.m.replyTo), me, names) : null}
                    flash={flashId === r.m.id}
                    held={msgHold.menu?.id === r.m.id}
                    send={isOptimistic(r.m) && r.m.nonce ? (sends?.[r.m.nonce] ?? null) : null}
                    readOnly={readOnly}
                    canEdit={draftBlank}
                    actions={actions}
                  />
                )
              )}
            </div>
          )}
        </div>
        {!readOnly ? <div aria-hidden="true" className="mchat-gap" /> : null}
        <div ref={kbPadRef} aria-hidden="true" />
      </div>

      <div ref={dockRef} className="absolute left-0 right-0 bottom-0" style={{ zIndex: 2 }} data-testid="home-chat-dock">
        <ZenFooterBlur style={{ left: 0, right: 0, bottom: 0, top: -FOOTER_BLUR_FADE_PX }} />
        {/* Zero-height row: who is typing on the box's edge, and the jump
            pill above it. Neither ever moves the box. */}
        <div className="relative h-0 shrink-0" style={{ zIndex: 1 }}>
          <HomeChatTyping names={typingNow} />
          <div
            aria-live="polite"
            className="absolute left-0 right-0 flex justify-center pointer-events-none"
            style={{ bottom: typingNow.length ? 30 : 8 }}
          >
            {!atNewest && messages.length > 0 ? (
              <JumpPill
                words={newCount > 0 ? "message" : "jump"}
                count={newCount}
                leaving={false}
                onJump={() => {
                  const el = scrollerRef.current;
                  setFollowing(true);
                  if (el) stickToNewest(el);
                }}
              />
            ) : null}
          </div>
        </div>
        <div className="relative" style={{ zIndex: 1 }}>
          {readOnly ? (
            <p
              className="px-4 pt-3 text-[13px] text-center"
              style={{ color: "var(--color-text-muted)", paddingBottom: "max(12px, var(--safe-bottom))" }}
              data-testid="home-chat-readonly"
            >
              {archived ? "This channel is archived: it is read-only." : "This person is no longer on this server: the conversation is read-only."}
            </p>
          ) : (
            <ThreadDraftComposer
              draftKey={draftKey}
              apiRef={draftApi}
              onBlankChange={setDraftBlank}
              hasAttachments={false}
              inFlight={false}
              onSubmit={onSend}
              placeholder={placeholder}
              ariaLabel={placeholder}
              canSend={!!conv && !gateOff}
              disabled={!conv || gateOff}
              attach={false}
              textareaRef={composerRef}
              smoothClear
              testIdPrefix={COMPOSER_PREFIX}
              onFocus={() => {
                const el = scrollerRef.current;
                if (el && following.current) stickToNewest(el);
              }}
            >
              {jumpMiss ? (
                <p className="text-[12px] leading-snug mb-1.5" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-jump-miss">
                  {jumpMiss.gone ? (
                    `${ORIGINAL_DELETED}.`
                  ) : (
                    <>
                      {ORIGINAL_NOT_LOADED}{" "}
                      <button
                        type="button"
                        className="underline bg-transparent border-0 p-0"
                        style={{ color: "var(--color-accent-text)" }}
                        data-testid="home-chat-jump-more"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => void jump(jumpMiss.id)}
                      >
                        Load it
                      </button>
                    </>
                  )}
                </p>
              ) : null}
              {composerNote ? (
                <p className="text-[11px] leading-snug break-words mb-1.5" style={{ color: "var(--color-status-warn-text)" }} role="alert" data-testid="home-chat-note">
                  {composerNote}
                </p>
              ) : null}
              {reply ? (
                <div className="flex items-center gap-1.5 mb-1.5 text-[12px] min-w-0" style={{ color: "var(--color-text-muted)" }} data-testid="home-chat-reply-chip">
                  <ReplyIcon size={14} strokeWidth={1.75} />
                  <span className="flex-1 min-w-0 truncate">
                    Replying to <span style={{ color: "var(--color-text-primary)" }}>{reply.from}</span>
                    {": "}
                    {firstLine(reply.text) || reply.text}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 px-1.5 bg-transparent border-0"
                    style={{ color: "var(--color-text-muted)" }}
                    aria-label="Cancel reply"
                    data-testid="home-chat-reply-cancel"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setReply(null)}
                  >
                    ✕
                  </button>
                </div>
              ) : null}
            </ThreadDraftComposer>
          )}
        </div>
      </div>

      {msgHold.menu && held ? (
        <AgentMenu
          label={`Message from ${authorName(held.authorId, me, names)}`}
          menu={msgHold.menu}
          entries={holdEntries}
          onClose={msgHold.close}
          align="center"
          testId="home-chat-menu"
          headPx={readOnly ? 0 : QUICK_ROW_PX}
          head={
            readOnly
              ? undefined
              : (take) => (
                  <QuickReactionRow
                    mine={heldMine}
                    onPick={(emoji) => {
                      if (!take()) return;
                      msgHold.close();
                      react(held.id, emoji);
                    }}
                  />
                )
          }
        />
      ) : null}
      {emojiFor ? (
        <EmojiSheet
          onClose={() => setEmojiFor(null)}
          onPick={(emoji) => {
            const id = emojiFor;
            setEmojiFor(null);
            react(id, emoji);
          }}
        />
      ) : null}
      {membersOpen && conv && !dm ? (
        <HomeChatMembersSheet
          scope={scope}
          conv={conv}
          onClose={() => setMembersOpen(false)}
          onLeft={() => {
            setMembersOpen(false);
            onBack();
          }}
        />
      ) : null}
    </div>
  );
}
