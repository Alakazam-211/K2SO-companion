import type { ReactNode } from "react";
import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { activityColor, activityForRow, activityPinText } from "./agentActivity";
import { AgentRowContent } from "./AgentRowContent";
import { RowDivider, ZEN_ROW_RIGHT_INSET } from "./RowDivider";
import { skinInitials } from "./agentRow";
import { parseHomeAddress, type HomeRow } from "./homes";
import { findAgentForRow, type HomeRowView } from "./homeView";
import { FailureAction, FailureText } from "./multi/MergedRows";
import type { FailureAction as FailureActionKind, RowFailure } from "./multi/rowStatus";
import { roomBelowFloor } from "./multi/useMultiServerList";
import type { RowActivity } from "./agentActivity";
import { lastAtKeyFor } from "./lastAtFetch";
import type { StubAgent } from "./stubData";
import { mountainListWhen } from "./threadModel";
import { useListField, useZenStore } from "./zenStore";
import { useZenScope } from "./zenScope";
import { rowUnreadFor, type RowRef } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { AgentMenu, OpenGlyph, PinGlyph, RearrangeGlyph, RemoveGlyph, type AgentMenuEntry } from "./AgentMenu";
import { PINS_FULL_TEXT } from "./groups/homeRowOrder";
import { GripHandle, rearrangePadLeft } from "./RearrangeBits";
import { useHoldMenu } from "./useHoldMenu";
import { useRearrange } from "./useRearrange";
import {
  ZEN_LIST_EDGE_INSET,
  ZEN_LIST_EDGE_PAD,
  ZEN_PIN_AVATAR_PX,
  ZEN_PIN_COL_GAP,
  ZEN_PIN_GRID_BOTTOM_PX,
  ZEN_PIN_ROW_GAP,
  zenPinGridColumns,
} from "./pinGrid";
import { UnreadDot } from "./UnreadMarks";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { chatRowLook, type ChatHomeView, type ChatRowLook } from "./homeChat/chatRowLook";
import { useHomeChatRowsStore, openHomeChatRow } from "./homeChat/homeChatRowsStore";
import { ChannelAvatar, CallGlyph, PersonAvatar } from "./homeChat/HomeChatGlyphs";
import { confirmRemoveChatRow } from "./homeChat/HomeConfirmSheet";
import { callPersonFromRow } from "./homeChat/openHomeChat";

/** The first agents of a Home sit in the Agents page's grid (Riley
 *  2026-11-09); the rest are rows. */
export const HOME_GRID_MAX = 9;

/** A Home row's server and Thread (unread marks, Mute). */
export function homeRowTarget(
  v: HomeRowView,
  zenId: string
): { serverId: string; addr: string } | null {
  if (v.kind === "here") return v.agent.addr ? { serverId: zenId, addr: v.agent.addr } : null;
  if (v.kind !== "remote" || !v.server) return null;
  const addr = v.resolved?.agent?.addr || parseHomeAddress(v.row.address)?.handle || "";
  return addr ? { serverId: v.server.id, addr } : null;
}

export const HOME_EMPTY_TITLE = "Your Home is empty";
export const HOME_EMPTY_BODY = "Tap + to add agents from your servers.";

/**
 * Open a Home row that lives on another saved server.
 *
 *   - `room` given (multi-server flag on, S3b / HM3): open a ROOM on that
 *     server (`zenStore.openRoom`, MS21) — the active server never
 *     changes; Back and Done return to Home. `localId` is the row's id in
 *     that server's list when known, else the handle (the room's hydrate
 *     finds it by address). A server known to be below the phone floor
 *     (MS30, Q9) opens the old way instead.
 *   - No `room`: make that server active the way the Servers sheet does,
 *     then open the agent's chat. (Flag off, Home shows the active
 *     server's rows only, so other-server rows never reach here.)
 *
 * False when it needs a sign-in or cannot be reached.
 */
export async function openHomeRowOnServer(
  serverId: string,
  handle: string,
  room?: { localId?: string | null; seed?: StubAgent[] }
): Promise<boolean> {
  if (room && !roomBelowFloor(serverId)) {
    await useZenStore.getState().openRoom(serverId, { id: room.localId || handle, seed: room.seed });
    return true;
  }
  const store = useServersStore.getState();
  if (store.activeServerId !== serverId) {
    const outcome = await connectServer(serverId);
    if (outcome !== "still-valid" && outcome !== "revived") return false;
    useServersStore.getState().setActive(serverId);
  }
  await useZenStore.getState().hydrateAgents({ resumeId: handle });
  return true;
}

/** A Home row tapped before the active server's list loaded: open it once
 *  the list is in (gives up after 10 s or if the agent isn't there). */
function openWhenListed(row: HomeRow): void {
  let done = false;
  const finish = () => {
    done = true;
    unsub();
    clearTimeout(timer);
  };
  const check = (s: ReturnType<typeof useZenStore.getState>) => {
    if (done || s.agentSource === "loading") return;
    finish();
    if (s.agentSource !== "live") return;
    const agent = findAgentForRow(row, s.agents, s.serverProjects);
    if (agent) s.setAgent(agent.id);
  };
  const unsub = useZenStore.subscribe(check);
  const timer = setTimeout(() => !done && finish(), 10_000);
  check(useZenStore.getState());
}

/** What a row from another server shows with the multi-server flag on
 *  (HM3): its server's state from the S2 pool, its activity, picture and
 *  snippet. */
export interface RemoteRowLook {
  failure: RowFailure | null;
  busy: RowActivity | null;
  iconUrl: string | null;
  /** Line two when healthy and idle. */
  preview: ReactNode;
  when: string;
  /** The pool's next check (offline countdown). */
  nextAt: number | null;
  /** Greyed without a failure (not on its server's list right now). */
  dim: boolean;
}

/**
 * The Home tab's list (HM3/HM6/HM7): the current Home's rows with the
 * Agents row look, its first nine in the pin grid's layout (rows while
 * searching or rearranging). Press and hold one for its menu (Open,
 * Mute, Rearrange, Remove from Home); rows carry no `data-pin-id`, so the
 * pin grid's gestures never see them. Rearrange mode puts a grip left of
 * each avatar; a drag reorders the Home (`onReorder`, synced by Homes
 * sync like any Home edit).
 */
export function HomeList({
  views,
  homeName,
  searching,
  canRearrange = true,
  rearranging = false,
  onRearrange,
  onReorder,
  scrollRef,
  onRemove,
  onOpenRemote,
  previewFor,
  remoteLook,
  onRemoteAction,
  hereChip = null,
  activeDown = false,
  inset = "16px",
  otherHomeOf,
  gridMax = HOME_GRID_MAX,
  pins,
}: {
  /** Home groups (K2 0.46.13): Pin / Unpin on the hold menu (at most 9
   *  per group; at the limit Pin shows turned off, with the reason). Rows
   *  from another group (a search across groups) have no Pin here. */
  pins?: {
    isPinned: (address: string) => boolean;
    full: boolean;
    onPin: (address: string) => void;
    onUnpin: (address: string) => void;
  };
  views: HomeRowView[];
  homeName: string;
  /** How many of the Home's first rows sit in the grid (this Home's "Top
   *  grid" choice: 0, 3, 6 or 9). */
  gridMax?: number;
  searching: boolean;
  /** Menu Rearrange shown (off while "Recent agents first" orders the
   *  list, and while searching). */
  canRearrange?: boolean;
  /** Rearrange mode: grips on, taps and the hold menu off. */
  rearranging?: boolean;
  onRearrange?: () => void;
  /** A Rearrange drop: the shown rows' addresses in their new order, and
   *  the row that moved. */
  onReorder?: (order: string[], moved: string) => void;
  /** The scrolling list (Rearrange measures rows and auto-scrolls it). */
  scrollRef?: { current: HTMLElement | null };
  onRemove: (address: string) => void;
  onOpenRemote: (view: Extract<HomeRowView, { kind: "remote" }>) => void;
  /** Line two of an active-server row: the Agents list's own preview. */
  previewFor: (agent: StubAgent) => ReactNode;
  /** Multi-server flag on (S3b): how a row from another server looks.
   *  Absent (flag off): today's greyed "On <server>" row. */
  remoteLook?: (view: Extract<HomeRowView, { kind: "remote" }>) => RemoteRowLook;
  /** A failure row's one action, scoped to its server. */
  onRemoteAction?: (view: Extract<HomeRowView, { kind: "remote" }>, action: FailureActionKind) => void;
  /** The active server's chip on its own rows (flag on, several servers). */
  hereChip?: string | null;
  /** The active server is down (auto reconnect): its rows say so. */
  activeDown?: boolean;
  /** Row side padding: the Agents list's content inset. */
  inset?: string;
  /** A search across every Home: the name of the other Home a hit is
   *  on (null for the shown Home's own rows). Labels the hit and its
   *  menu. */
  otherHomeOf?: (address: string) => string | null;
}) {
  const source = useListField("agentSource");
  const activity = useListField("activity");
  const chatSessions = useListField("chatSessions");
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const zenId = useZenScope().id;
  const setAgent = useZenStore((s) => s.setAgent);
  const unreadServers = useUnreadStore((s) => s.servers);
  const unreadAddrs = useUnreadStore((s) => s.addrs);
  // People and channels (K2 0.46.13): their servers' Home chat state.
  const chatByServer = useHomeChatRowsStore((s) => s.byServer);
  const chatNotes = useHomeChatRowsStore((s) => s.rowNotes);
  const chatDeleted = useHomeChatRowsStore((s) => s.deleted);
  const tokens = useServersStore((s) => s.tokens);

  const hold = useHoldMenu();
  const noScroll = { current: null as HTMLElement | null };
  const rearrange = useRearrange({
    keys: views.map((v) => v.row.address),
    scrollRef: scrollRef ?? noScroll,
    enabled: rearranging,
    onCommit: (order, moved) => onReorder?.(order, moved),
  });

  if (views.length === 0) {
    return searching ? (
      <p className="py-6 text-[14px] text-center" style={{ color: "var(--color-text-muted)" }} data-testid="home-no-match">
        {otherHomeOf ? "No matches on any Home." : `No matches on ${homeName}.`}
      </p>
    ) : (
      <div
        className="zen-glass flex flex-col items-center text-center"
        style={{ margin: "24px 20px 0", padding: "24px 18px", borderRadius: 20, gap: 6, color: "var(--color-text-primary)" }}
        data-testid="home-empty"
      >
        <span className="text-[17px] font-semibold">{HOME_EMPTY_TITLE}</span>
        <span className="text-[14px]" style={{ color: "var(--color-text-muted)" }}>
          {HOME_EMPTY_BODY}
        </span>
      </div>
    );
  }

  const menu = hold.menu && !rearranging ? hold.menu : null;
  const menuView = menu ? views.find((v) => v.row.address === menu.id) ?? null : null;
  const menuTarget = menuView ? homeRowTarget(menuView, zenId) : null;
  const menuRef: RowRef | null = menuTarget ? { kind: "thread", addr: menuTarget.addr } : null;

  /** What a row's tap does (and the menu's Open). */
  const openRow = (v: HomeRowView, failure: RowFailure | null, action: (() => void) | null) => {
    if (v.kind === "here") setAgent(v.agent.id);
    else if (v.kind === "missing" && v.pending) openWhenListed(v.row);
    else if (v.kind === "remote") {
      // Flag on: a server in trouble runs its one fix instead — except one
      // that is down: the chat opens with what is cached and reconnects
      // (auto reconnect, its banner).
      if (failure && failure.state !== "offline" && failure.state !== "restarting") action?.();
      else onOpenRemote(v);
    }
  };

  const rowState = (v: HomeRowView) => {
    const look = v.kind === "remote" && remoteLook ? remoteLook(v) : null;
    const failure = look?.failure ?? null;
    const remoteView = v.kind === "remote" ? v : null;
    const action =
      remoteView && failure?.action && onRemoteAction
        ? () => onRemoteAction(remoteView, failure.action as FailureActionKind)
        : null;
    return { look, failure, action };
  };

  const lookOf = (v: ChatHomeView): ChatRowLook =>
    chatRowLook(v, { byServer: chatByServer, tokens, rowNotes: chatNotes, deleted: chatDeleted, hereChip });

  /** A person or channel row's tap: the DM (opened or made first) or the
   *  channel, in the chat view. A server with no chat opens nothing. */
  const openChat = (v: ChatHomeView, look: ChatRowLook) => {
    if (look.noChat || !look.serverId) return;
    void openHomeChatRow(look.serverId, {
      kind: v.chat,
      handle: v.handle,
      title: look.name,
      address: v.row.address,
      inviteOnly: look.inviteOnly,
    });
  };

  const pinEntries = (v: HomeRowView): AgentMenuEntry[] =>
    pins && !otherHomeOf?.(v.row.address)
      ? [
          pins.isPinned(v.row.address)
            ? { key: "unpin", label: "Unpin", icon: <PinGlyph off />, onSelect: () => pins.onUnpin(v.row.address) }
            : {
                key: "pin",
                label: "Pin",
                icon: <PinGlyph off={false} />,
                disabled: pins.full,
                note: pins.full ? PINS_FULL_TEXT : undefined,
                onSelect: () => pins.onPin(v.row.address),
              },
        ]
      : [];

  /** A person's or channel's menu (desktop: Pin / Unpin, Remove from
   *  <group>; Call on a person, Riley: calls live in the long press). */
  const chatMenuEntries = (v: ChatHomeView): AgentMenuEntry[] => {
    const look = lookOf(v);
    const group = otherHomeOf?.(v.row.address) ?? homeName;
    const sid = look.serverId;
    return [
      ...(!look.noChat && sid ? [{ key: "open", label: "Open", icon: <OpenGlyph />, onSelect: () => openChat(v, look) }] : []),
      ...(v.chat === "person" && look.offered && sid
        ? [
            {
              key: "call",
              label: "Call",
              icon: <CallGlyph />,
              onSelect: () =>
                callPersonFromRow(sid, {
                  ext: v.handle,
                  displayName: look.name,
                  username: look.username,
                  conversationId: chatByServer[sid]?.dms[v.handle] ?? null,
                  address: v.row.address,
                }),
            },
          ]
        : []),
      ...pinEntries(v),
      ...(canRearrange && !searching && views.length > 1 && onRearrange
        ? [{ key: "rearrange", label: "Rearrange", icon: <RearrangeGlyph />, onSelect: onRearrange }]
        : []),
      {
        key: "remove",
        label: `Remove from ${group}`,
        icon: <RemoveGlyph />,
        danger: true,
        onSelect: () => {
          void confirmRemoveChatRow(look.name, group, v.chat).then((yes) => {
            if (yes) onRemove(v.row.address);
          });
        },
      },
    ];
  };

  const menuEntries = (v: HomeRowView): AgentMenuEntry[] => {
    if (v.kind === "chat") return chatMenuEntries(v);
    const { failure, action } = rowState(v);
    const canOpen = v.kind === "here" || v.kind === "remote";
    return [
      ...(canOpen
        ? [{ key: "open", label: "Open", icon: <OpenGlyph />, onSelect: () => openRow(v, failure, action) }]
        : []),
      ...pinEntries(v),
      { key: "mute" as const, mute: { serverId: menuTarget?.serverId, rowRef: menuRef } },
      ...(canRearrange && !searching && views.length > 1 && onRearrange
        ? [{ key: "rearrange", label: "Rearrange", icon: <RearrangeGlyph />, onSelect: onRearrange }]
        : []),
      {
        key: "remove",
        label: `Remove from ${otherHomeOf?.(v.row.address) ?? "Home"}`,
        icon: <RemoveGlyph />,
        danger: true,
        onSelect: () => onRemove(v.row.address),
      },
    ];
  };

  /** What a row or tile shows. */
  const modelOf = (v: HomeRowView) => {
    const address = v.row.address;
    const handle = parseHomeAddress(address)?.handle ?? "";
    const here = v.kind === "here" ? v.agent : null;
    const { look, failure, action } = rowState(v);
    // Not listed yet (the list is loading): assumed fine, shown as
    // normal with what this phone remembers of it.
    const pending = v.kind === "missing" && !!v.pending;
    const pendingKey = pending ? lastAtKeyFor(zenId, { addr: handle }) : null;
    const there = v.kind === "remote" ? v.resolved?.agent ?? null : null;
    const busy = look
      ? look.busy
      : here && source === "live"
        ? activityForRow(here, activity, false, chatSessions)
        : null;
    const lastKey = here && source === "live" ? lastAtKeyFor(zenId, here) ?? undefined : undefined;
    const whenKey = lastKey ?? pendingKey ?? undefined;
    const when = look
      ? look.when
      : whenKey && lastAtByKey[whenKey] != null
        ? mountainListWhen(lastAtByKey[whenKey] as number)
        : "";
    const name = here?.name ?? there?.name ?? v.row.label ?? handle;
    const preview = failure ? (
      <span data-testid="row-failure" data-state={failure.state} title={failure.detail ?? undefined}>
        <FailureText failure={failure} nextAt={look?.nextAt ?? null} />
      </span>
    ) : look ? (
      look.preview
    ) : activeDown && v.kind !== "remote" ? (
      <span className="inline-flex items-center" style={{ gap: 6 }} data-testid="row-reconnecting">
        <span aria-hidden className="k2-reconnect-dot" />
        Reconnecting…
      </span>
    ) : v.kind === "here" ? (
      previewFor(v.agent)
    ) : pending ? (
      previewFor({ id: handle, addr: handle, name, kind: "agent" } as StubAgent)
    ) : v.kind === "remote" ? (
      `On ${v.serverLabel}`
    ) : (
      "Not on this server's list right now"
    );
    const dim = look ? !!failure || look.dim : v.kind !== "here" && !pending;
    const target = source === "live" || v.kind === "remote" ? homeRowTarget(v, zenId) : null;
    const unread =
      target && !failure
        ? rowUnreadFor(unreadServers, unreadAddrs, target.serverId, { addr: target.addr })
        : null;
    const opacity = look ? (dim ? 0.6 : 1) : dim ? 0.55 : 1;
    const elsewhere = otherHomeOf?.(address) ?? null;
    const remoteView = v.kind === "remote" ? v : null;
    return { address, handle, here, look, failure, action, there, busy, when, name, preview, unread, opacity, elsewhere, dim, remoteView };
  };

  const gridded = rearranging || searching ? [] : views.slice(0, gridMax);
  const listed = views.slice(gridded.length);

  const chatAvatar = (v: ChatHomeView, look: ChatRowLook, size: number, fontSize: number) =>
    v.chat === "person" ? (
      <PersonAvatar username={look.username} name={look.name} picture={look.person?.picture ?? null} size={size} fontSize={fontSize} glass testId="person-avatar" />
    ) : (
      <ChannelAvatar inviteOnly={look.inviteOnly} size={size} glass testId="channel-avatar" />
    );

  const chatLabel = (v: ChatHomeView, look: ChatRowLook) =>
    `${look.name}${v.chat === "channel" ? (look.inviteOnly ? ", invite-only channel" : ", channel") : ""}` +
    `${look.chip ? `, on ${look.chip}` : ""}${look.quiet ? `, ${look.line}` : ""}`;

  const chatTile = (v: ChatHomeView) => {
    const look = lookOf(v);
    const address = v.row.address;
    return (
      <div
        key={address}
        className="relative"
        data-home-row={address}
        data-home-kind="chat"
        data-chat-kind={v.chat}
        data-server-id={look.serverId ?? undefined}
        data-greyed={look.quiet ? "1" : undefined}
      >
        <button
          type="button"
          className="w-full text-center bg-transparent border-0 p-0"
          style={{
            color: "var(--color-text-primary)",
            opacity: look.quiet ? 0.55 : 1,
            touchAction: "pan-y",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
          }}
          data-no-pin="1"
          data-testid={`home-chat-${v.chat}-${v.handle}`}
          aria-describedby="home-row-hint"
          aria-haspopup="menu"
          aria-expanded={menu?.id === address}
          aria-label={chatLabel(v, look)}
          {...hold.bind(address, true)}
          onClick={() => {
            if (hold.consumeSkipClick()) return;
            openChat(v, look);
          }}
        >
          <div className="flex justify-center" style={{ marginBottom: look.chip ? 13 : 8 }} data-testid="pin-avatar">
            <span className="relative inline-flex">
              <UnreadDot unread={look.unread} side={14} />
              {chatAvatar(v, look, ZEN_PIN_AVATAR_PX, 26)}
              {look.chip ? (
                <span
                  className="absolute zen-glass zen-glass-pill truncate"
                  style={{
                    bottom: -9,
                    left: "50%",
                    transform: "translateX(-50%)",
                    maxWidth: 84,
                    padding: "1px 7px",
                    fontSize: 11,
                    lineHeight: "15px",
                    color: "var(--color-text-secondary)",
                  }}
                  data-testid="row-server-chip"
                >
                  {look.chip}
                </span>
              ) : null}
            </span>
          </div>
          <div
            className="text-[12px] font-semibold truncate mx-auto"
            style={{ color: "var(--color-text-primary)", maxWidth: 110, ...(look.unread ? { fontWeight: 700 } : null) }}
            data-testid="row-name"
          >
            {look.name}
          </div>
          {look.quiet ? (
            <div
              className="text-[11px] truncate mx-auto"
              style={{ color: "var(--color-text-muted)", maxWidth: 110, lineHeight: 1.3 }}
              data-testid="row-chat-quiet"
            >
              {look.line}
            </div>
          ) : null}
        </button>
      </div>
    );
  };

  const chatRow = (v: ChatHomeView, i: number) => {
    const look = lookOf(v);
    const address = v.row.address;
    const shift = rearrange.offsetFor(address);
    return (
      <div
        key={address}
        className="relative"
        data-home-row={address}
        data-home-kind="chat"
        data-chat-kind={v.chat}
        data-server-id={look.serverId ?? undefined}
        data-greyed={look.quiet ? "1" : undefined}
        data-rearrange-key={address}
        data-dragging={shift.dragging ? "1" : undefined}
        style={{
          transform: shift.y ? `translateY(${shift.y}px)` : undefined,
          transition: shift.transition,
          zIndex: shift.dragging ? 3 : undefined,
          background: shift.dragging ? "var(--color-bg-elevated)" : undefined,
          boxShadow: shift.dragging ? "0 10px 28px var(--color-shadow)" : undefined,
          borderRadius: shift.dragging ? 14 : undefined,
        }}
      >
        {rearranging ? <GripHandle name={look.name} inset={inset} handlers={rearrange.handleProps(address)} /> : null}
        <button
          type="button"
          className="w-full flex items-center text-left relative"
          style={{
            gap: 10,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: rearrangePadLeft(inset, rearranging),
            paddingRight: ZEN_ROW_RIGHT_INSET,
            opacity: look.quiet ? 0.55 : 1,
            touchAction: "pan-y",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
            transition: rearrange.reduced ? undefined : "padding-left 200ms cubic-bezier(.2,.9,.25,1)",
          }}
          data-no-pin="1"
          data-testid={`home-chat-${v.chat}-${v.handle}`}
          aria-describedby="home-row-hint"
          aria-haspopup={rearranging ? undefined : "menu"}
          aria-expanded={rearranging ? undefined : menu?.id === address}
          aria-label={chatLabel(v, look)}
          {...hold.bind(address, !rearranging)}
          onClick={() => {
            if (hold.consumeSkipClick() || rearranging) return;
            openChat(v, look);
          }}
        >
          <AgentRowContent
            name={look.name}
            initial=""
            busy={null}
            when={look.when}
            preview={look.line}
            homeTag={otherHomeOf?.(address) ?? null}
            serverChip={look.chip}
            unread={look.unread}
            avatar={chatAvatar(v, look, 50, 18)}
          />
        </button>
        {i < listed.length - 1 && !shift.dragging ? (
          <RowDivider
            padLeft={rearrangePadLeft(inset, rearranging)}
            padRight={ZEN_ROW_RIGHT_INSET}
            transition={rearrange.reduced ? undefined : "left 200ms cubic-bezier(.2,.9,.25,1)"}
          />
        ) : null}
      </div>
    );
  };

  const tile = (v: HomeRowView) => {
    if (v.kind === "chat") return chatTile(v);
    const { address, handle, here, look, failure, action, there, busy, name, unread, opacity, elsewhere, dim } = modelOf(v);
    const shownBusy = failure ? null : busy;
    const color = shownBusy ? activityColor(shownBusy) : "";
    const chip = v.kind === "remote" ? v.serverLabel : hereChip;
    return (
      <div key={address} className="relative" data-home-row={address} data-home-kind={v.kind} data-server-id={v.kind === "remote" ? v.server?.id : undefined} data-greyed={look && dim ? "1" : undefined}>
        <button
          type="button"
          className="w-full text-center bg-transparent border-0 p-0"
          style={{
            color: "var(--color-text-primary)",
            opacity,
            touchAction: "pan-y",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
          }}
          data-no-pin="1"
          data-testid={`home-row-${handle}`}
          aria-describedby="home-row-hint"
          aria-haspopup="menu"
          aria-expanded={menu?.id === address}
          aria-label={
            (v.kind === "remote" ? `${name}, on ${v.serverLabel}` + (failure ? `, ${failure.copy}` : "") : name) +
            (elsewhere ? `, on ${elsewhere}` : "")
          }
          {...hold.bind(address, true)}
          onClick={() => {
            if (hold.consumeSkipClick()) return;
            openRow(v, failure, action);
          }}
        >
          <div className="flex justify-center" style={{ marginBottom: chip ? 13 : 8 }} data-testid="pin-avatar">
            <span className="relative inline-flex">
              <UnreadDot unread={unread} side={14} />
              <WorkspaceAvatar
                initial={here?.initial ?? there?.initial ?? skinInitials(name || "?")}
                color={here?.color ?? there?.color}
                iconUrl={look ? look.iconUrl : here?.iconUrl}
                size={ZEN_PIN_AVATAR_PX}
                fontSize={26}
                fallback="var(--color-bg-elevated)"
              />
              {shownBusy ? (
                <span
                  aria-hidden
                  data-testid="pin-activity-dot"
                  className={`absolute rounded-full ${shownBusy.display === "working" ? "k2-pulse" : ""}`}
                  style={{
                    right: chip ? -2 : 1,
                    bottom: chip ? 12 : 1,
                    width: 20,
                    height: 20,
                    background: color,
                    color,
                    border: "2.5px solid var(--color-bg)",
                    ["--k2-pulse-edge" as string]: "2.5px",
                  }}
                />
              ) : null}
              {chip ? (
                // Across the picture's bottom edge (Riley 2026-11-09); the
                // activity dot moves up the circle to clear it.
                <span
                  className="absolute zen-glass zen-glass-pill truncate"
                  style={{
                    bottom: -9,
                    left: "50%",
                    transform: "translateX(-50%)",
                    maxWidth: 84,
                    padding: "1px 7px",
                    fontSize: 11,
                    lineHeight: "15px",
                    color: "var(--color-text-secondary)",
                  }}
                  data-testid="row-server-chip"
                >
                  {chip}
                </span>
              ) : null}
            </span>
          </div>
          <div className="text-[12px] font-semibold truncate mx-auto" style={{ color: "var(--color-text-primary)", maxWidth: 110 }} data-testid="row-name">
            {name}
          </div>
          {failure ? (
            <div className="text-[11px] truncate mx-auto" style={{ color: "var(--color-text-muted)", maxWidth: 110, lineHeight: 1.3 }} data-testid="row-failure" data-state={failure.state}>
              <FailureText failure={failure} nextAt={look?.nextAt ?? null} />
            </div>
          ) : shownBusy ? (
            <div className="text-[11px] truncate mx-auto" style={{ color, maxWidth: 110, lineHeight: 1.3 }} data-testid="pin-activity">
              {activityPinText(shownBusy)}
            </div>
          ) : null}
        </button>
      </div>
    );
  };

  return (
    <div data-testid="home-list" data-rearranging={rearranging ? "1" : undefined}>
      <span id="home-row-hint" className="sr-only">
        {rearranging
          ? "Drag a handle to reorder. Tap Done when finished."
          : `Press and hold for options, like Remove from ${homeName}.`}
      </span>
      {gridded.length ? (
        <div
          className="grid"
          style={{
            gridTemplateColumns: zenPinGridColumns(gridded.length),
            justifyContent: gridded.length < 3 ? "center" : undefined,
            padding: `4px ${ZEN_LIST_EDGE_PAD}px ${ZEN_PIN_GRID_BOTTOM_PX}px`,
            gap: `${ZEN_PIN_ROW_GAP}px ${ZEN_PIN_COL_GAP}px`,
            margin: `10px ${ZEN_LIST_EDGE_INSET}px 0`,
          }}
          data-testid="home-grid"
        >
          {gridded.map(tile)}
        </div>
      ) : null}
      {listed.map((v, i) => {
        if (v.kind === "chat") return chatRow(v, i);
        const { address, handle, here, look, failure, action, there, busy, when, name, preview, unread, opacity, elsewhere, dim, remoteView } = modelOf(v);
        const shift = rearrange.offsetFor(address);
        return (
          <div
            key={address}
            className="relative"
            data-home-row={address}
            data-home-kind={v.kind}
            data-server-id={v.kind === "remote" ? v.server?.id : undefined}
            data-greyed={look && dim ? "1" : undefined}
            data-rearrange-key={address}
            data-dragging={shift.dragging ? "1" : undefined}
            style={{
              transform: shift.y ? `translateY(${shift.y}px)` : undefined,
              transition: shift.transition,
              zIndex: shift.dragging ? 3 : undefined,
              background: shift.dragging ? "var(--color-bg-elevated)" : undefined,
              boxShadow: shift.dragging ? "0 10px 28px var(--color-shadow)" : undefined,
              borderRadius: shift.dragging ? 14 : undefined,
            }}
          >
            {rearranging ? (
              <GripHandle name={name} inset={inset} handlers={rearrange.handleProps(address)} />
            ) : null}
            <button
              type="button"
              className="w-full flex items-center text-left relative"
              style={{
                gap: 10,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: rearrangePadLeft(inset, rearranging),
                paddingRight: failure?.action ? `calc(${ZEN_ROW_RIGHT_INSET} + 96px)` : ZEN_ROW_RIGHT_INSET,
                opacity,
                touchAction: "pan-y",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                transition: rearrange.reduced ? undefined : "padding-left 200ms cubic-bezier(.2,.9,.25,1)",
              }}
              data-no-pin="1"
              data-testid={`home-row-${handle}`}
              aria-describedby="home-row-hint"
              aria-haspopup={rearranging ? undefined : "menu"}
              aria-expanded={rearranging ? undefined : menu?.id === address}
              aria-label={
                (v.kind === "remote" ? `${name}, on ${v.serverLabel}` + (failure ? `, ${failure.copy}` : "") : name) +
                (elsewhere ? `, on ${elsewhere}` : "")
              }
              {...hold.bind(address, !rearranging)}
              onClick={() => {
                if (hold.consumeSkipClick() || rearranging) return;
                openRow(v, failure, action);
              }}
            >
              <AgentRowContent
                name={name}
                iconUrl={look ? look.iconUrl : here?.iconUrl}
                color={here?.color ?? there?.color}
                initial={here?.initial ?? there?.initial ?? skinInitials(name || "?")}
                busy={failure ? null : busy}
                when={failure ? "" : when}
                preview={preview}
                homeTag={elsewhere}
                stub={source === "stub" && v.kind === "here"}
                serverChip={v.kind === "remote" ? v.serverLabel : hereChip}
                unread={unread}
              />
            </button>
            {failure && remoteView && !rearranging ? (
              <span
                className="absolute flex items-center"
                style={{ right: ZEN_ROW_RIGHT_INSET, top: "50%", transform: "translateY(-50%)" }}
                data-no-pin="1"
              >
                <FailureAction
                  failure={failure}
                  serverLabel={v.kind === "remote" ? v.serverLabel : ""}
                  onAction={() => action?.()}
                />
              </span>
            ) : null}
            {/* A hairline between rows: none under the last one. */}
            {i < listed.length - 1 && !shift.dragging ? (
              <RowDivider
                padLeft={rearrangePadLeft(inset, rearranging)}
                padRight={ZEN_ROW_RIGHT_INSET}
                transition={rearrange.reduced ? undefined : "left 200ms cubic-bezier(.2,.9,.25,1)"}
              />
            ) : null}
          </div>
        );
      })}

      {menu && menuView ? (
        <AgentMenu
          label={`Options for ${menuView.kind === "chat" ? lookOf(menuView).name : menuView.row.label} on ${otherHomeOf?.(menuView.row.address) ?? homeName}`}
          menu={menu}
          entries={menuEntries(menuView)}
          onClose={hold.close}
          testId="home-row-menu"
        />
      ) : null}
    </div>
  );
}
