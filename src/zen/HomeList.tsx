import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { activityForRow } from "./agentActivity";
import { AgentRowContent } from "./AgentRowContent";
import { skinInitials } from "./agentRow";
import { parseHomeAddress } from "./homes";
import type { HomeRowView } from "./homeView";
import { FailureAction, FailureText } from "./multi/MergedRows";
import type { FailureAction as FailureActionKind, RowFailure } from "./multi/rowStatus";
import { roomBelowFloor } from "./multi/useMultiServerList";
import type { RowActivity } from "./agentActivity";
import { lastAtKeyFor } from "./lastAtFetch";
import type { StubAgent } from "./stubData";
import { mountainListWhen } from "./threadModel";
import { isHorizontalSwipe, SWIPE_SLOP_PX } from "./useRowSwipe";
import { useZenStore } from "./zenStore";
import { useZenScope } from "./zenScope";
import { useBackHandler } from "../lib/androidBack";
import { rowUnreadFor, type RowRef } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { MuteMenuItems } from "./UnreadMarks";

/** A Home row's server and Thread (unread marks, Mute). */
function homeRowTarget(
  v: HomeRowView,
  zenId: string
): { serverId: string; addr: string } | null {
  if (v.kind === "here") return v.agent.addr ? { serverId: zenId, addr: v.agent.addr } : null;
  if (v.kind !== "remote" || !v.server) return null;
  const addr = v.resolved?.agent?.addr || parseHomeAddress(v.row.address)?.handle || "";
  return addr ? { serverId: v.server.id, addr } : null;
}

/** Trailing (swipe-left) Remove action width. */
export const HOME_REMOVE_W = 96;
/** A still press this long opens the row's menu. */
export const HOME_HOLD_MS = 500;
const REMOVE_RED = "#ff453a";

export const HOME_EMPTY_TITLE = "Your Home is empty";
export const HOME_EMPTY_BODY = "Tap + to add agents from your servers.";

/** Where a swipe-left settles on release. */
export function homeSwipeRelease(x: number): "open" | "close" {
  return x <= -HOME_REMOVE_W / 2 ? "open" : "close";
}

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

type Track = { address: string; x0: number; y0: number; base: number; committed: boolean };

/**
 * The Home tab's list (HM3/HM6/HM7): the current Home's rows with the
 * Agents row look. No pin grid, no swipe-right-to-group, no hold-to-pin
 * (rows carry no `data-pin-id`, so the list's pin/group gestures never
 * see them). Swipe left, or press and hold, for Remove from Home.
 */
export function HomeList({
  views,
  homeName,
  searching,
  reorderable = true,
  onRemove,
  onMove,
  onOpenRemote,
  previewFor,
  remoteLook,
  onRemoteAction,
  hereChip = null,
  activeDown = false,
  inset = "16px",
}: {
  views: HomeRowView[];
  homeName: string;
  searching: boolean;
  /** Menu Move up / Move down shown (off while "Recent agents first"
   *  orders the list). */
  reorderable?: boolean;
  onRemove: (address: string) => void;
  /** Reorder within the Home (menu Move up / Move down; not while searching). */
  onMove: (address: string, delta: -1 | 1) => void;
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
}) {
  const source = useZenStore((s) => s.agentSource);
  const activity = useZenStore((s) => s.activity);
  const chatSessions = useZenStore((s) => s.chatSessions);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const zenId = useZenScope().id;
  const setAgent = useZenStore((s) => s.setAgent);
  const unreadServers = useUnreadStore((s) => s.servers);
  const unreadAddrs = useUnreadStore((s) => s.addrs);

  const [openAddr, setOpenAddr] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ address: string; x: number } | null>(null);
  const [menu, setMenu] = useState<{ address: string; top: number } | null>(null);
  const track = useRef<Track | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipClick = useRef(false);

  const clearHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => clearHold, []);
  // Android Back closes the row menu, like its backdrop. Only while it
  // shows (its row may have left the list).
  useBackHandler(
    menu !== null && views.some((v) => v.row.address === menu.address),
    () => setMenu(null)
  );

  const openMenu = (address: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpenAddr(null);
    setMenu({ address, top: r.bottom + 4 });
  };

  const onDown = (address: string) => (e: ReactPointerEvent<HTMLElement>) => {
    skipClick.current = false;
    if (e.button && e.button !== 0) return;
    if (openAddr && openAddr !== address) {
      setOpenAddr(null);
      skipClick.current = true;
    }
    const base = openAddr === address ? -HOME_REMOVE_W : 0;
    if (base) skipClick.current = true;
    track.current = { address, x0: e.clientX, y0: e.clientY, base, committed: false };
    const el = e.currentTarget;
    clearHold();
    hold.current = setTimeout(() => {
      hold.current = null;
      if (track.current?.committed) return;
      track.current = null;
      skipClick.current = true;
      openMenu(address, el);
    }, HOME_HOLD_MS);
  };

  const onMoveRow = (e: ReactPointerEvent<HTMLElement>) => {
    const t = track.current;
    if (!t) return;
    const dx = e.clientX - t.x0;
    const dy = e.clientY - t.y0;
    if (!t.committed) {
      if (Math.abs(dx) > SWIPE_SLOP_PX || Math.abs(dy) > SWIPE_SLOP_PX) clearHold();
      if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
        track.current = null;
        return;
      }
      if (!isHorizontalSwipe(dx, dy)) return;
      // Trailing action only: a right drag on a closed row is not a swipe.
      if (dx > 0 && t.base === 0) {
        track.current = null;
        return;
      }
      t.committed = true;
      skipClick.current = true;
    }
    const x = Math.min(0, Math.max(-HOME_REMOVE_W * 1.5, t.base + dx));
    setDrag({ address: t.address, x });
  };

  const onUp = () => {
    clearHold();
    const t = track.current;
    track.current = null;
    if (!t?.committed) return;
    const x = drag?.address === t.address ? drag.x : t.base;
    setDrag(null);
    setOpenAddr(homeSwipeRelease(x) === "open" ? t.address : null);
  };

  if (views.length === 0) {
    return searching ? (
      <p className="py-6 text-[14px] text-center" style={{ color: "#8e8e93" }} data-testid="home-no-match">
        No matches on {homeName}.
      </p>
    ) : (
      <div
        className="zen-glass flex flex-col items-center text-center"
        style={{ margin: "24px 20px 0", padding: "24px 18px", borderRadius: 20, gap: 6, color: "#fff" }}
        data-testid="home-empty"
      >
        <span className="text-[17px] font-semibold">{HOME_EMPTY_TITLE}</span>
        <span className="text-[14px]" style={{ color: "#8e8e93" }}>
          {HOME_EMPTY_BODY}
        </span>
      </div>
    );
  }

  const menuIndex = menu ? views.findIndex((v) => v.row.address === menu.address) : -1;
  const menuView = menuIndex >= 0 ? views[menuIndex] : null;
  const menuTarget = menuView ? homeRowTarget(menuView, zenId) : null;
  const menuRef: RowRef | null = menuTarget ? { kind: "thread", addr: menuTarget.addr } : null;

  return (
    <div data-testid="home-list">
      <span id="home-row-hint" className="sr-only">
        Swipe left, or press and hold, to remove from {homeName}.
      </span>
      {views.map((v) => {
        const address = v.row.address;
        const handle = parseHomeAddress(address)?.handle ?? "";
        const x = drag?.address === address ? drag.x : openAddr === address ? -HOME_REMOVE_W : 0;
        const dragging = drag?.address === address;
        const here = v.kind === "here" ? v.agent : null;
        const look = v.kind === "remote" && remoteLook ? remoteLook(v) : null;
        const there = v.kind === "remote" ? v.resolved?.agent ?? null : null;
        const failure = look?.failure ?? null;
        const busy = look
          ? look.busy
          : here && source === "live"
            ? activityForRow(here, activity, false, chatSessions)
            : null;
        const lastKey = here && source === "live" ? lastAtKeyFor(zenId, here) ?? undefined : undefined;
        const when = look
          ? look.when
          : lastKey && lastAtByKey[lastKey] != null
            ? mountainListWhen(lastAtByKey[lastKey] as number)
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
        ) : v.kind === "remote" ? (
          `On ${v.serverLabel}`
        ) : (
          "Not on this server's list right now"
        );
        const dim = look ? !!failure || look.dim : v.kind !== "here";
        const target = source === "live" || v.kind === "remote" ? homeRowTarget(v, zenId) : null;
        const unread =
          target && !failure
            ? rowUnreadFor(unreadServers, unreadAddrs, target.serverId, { addr: target.addr })
            : null;
        const opacity = look ? (dim ? 0.6 : 1) : dim ? 0.55 : 1;
        const remoteView = v.kind === "remote" ? v : null;
        const action =
          remoteView && failure?.action && onRemoteAction
            ? () => onRemoteAction(remoteView, failure.action as FailureActionKind)
            : null;
        return (
          <div
            key={address}
            className="relative overflow-hidden"
            data-home-row={address}
            data-home-kind={v.kind}
            data-server-id={v.kind === "remote" ? v.server?.id : undefined}
            data-greyed={look && dim ? "1" : undefined}
          >
            <button
              type="button"
              className="absolute top-0 bottom-0 right-0 flex items-center justify-center border-0 text-[15px] font-semibold"
              style={{
                width: Math.max(0, -x),
                background: REMOVE_RED,
                color: "#fff",
                overflow: "hidden",
                transition: dragging ? "none" : "width 260ms cubic-bezier(.2,.9,.25,1)",
              }}
              tabIndex={x < 0 ? 0 : -1}
              aria-hidden={x < 0 ? undefined : true}
              aria-label={`Remove ${name} from ${homeName}`}
              data-no-pin="1"
              data-testid={`home-remove-${handle}`}
              onClick={() => {
                setOpenAddr(null);
                onRemove(address);
              }}
            >
              Remove
            </button>
            <button
              type="button"
              className="w-full flex items-center text-left relative"
              style={{
                gap: 10,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: inset,
                paddingRight: failure?.action ? `calc(${inset} + 96px)` : inset,
                opacity,
                touchAction: "pan-y",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                transform: `translateX(${x}px)`,
                transition: dragging ? "none" : "transform 260ms cubic-bezier(.2,.9,.25,1)",
              }}
              data-no-pin="1"
              data-testid={`home-row-${handle}`}
              aria-describedby="home-row-hint"
              aria-label={
                v.kind === "remote"
                  ? `${name}, on ${v.serverLabel}` + (failure ? `, ${failure.copy}` : "")
                  : name
              }
              onPointerDown={onDown(address)}
              onPointerMove={onMoveRow}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onContextMenu={(e) => {
                e.preventDefault();
                clearHold();
                track.current = null;
                openMenu(address, e.currentTarget);
              }}
              onClick={() => {
                if (skipClick.current) {
                  skipClick.current = false;
                  return;
                }
                if (openAddr) {
                  setOpenAddr(null);
                  return;
                }
                if (v.kind === "here") setAgent(v.agent.id);
                else if (v.kind === "remote") {
                  // Flag on: a server in trouble runs its one fix instead —
                  // except one that is down: the chat opens with what is
                  // cached and reconnects (auto reconnect, its banner).
                  if (failure && failure.state !== "offline" && failure.state !== "restarting") action?.();
                  else onOpenRemote(v);
                }
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
                stub={source === "stub" && v.kind === "here"}
                serverChip={v.kind === "remote" ? v.serverLabel : hereChip}
                unread={unread}
              />
            </button>
            {failure && remoteView ? (
              <span
                className="absolute flex items-center"
                style={{
                  right: inset,
                  top: "50%",
                  transform: `translate(${x}px, -50%)`,
                  transition: dragging ? "none" : "transform 260ms cubic-bezier(.2,.9,.25,1)",
                }}
                data-no-pin="1"
              >
                <FailureAction
                  failure={failure}
                  serverLabel={v.kind === "remote" ? v.serverLabel : ""}
                  onAction={() => action?.()}
                />
              </span>
            ) : null}
          </div>
        );
      })}

      {menu && menuView ? (
        <div data-no-pin="1">
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 bg-transparent border-0 p-0"
            style={{ zIndex: 29 }}
            onClick={() => setMenu(null)}
            data-testid="home-menu-backdrop"
          />
          <div
            role="menu"
            aria-label={`${menuView.row.label} on ${homeName}`}
            className="zen-glass fixed"
            data-testid="home-row-menu"
            style={{
              zIndex: 30,
              top: `min(${menu.top}px, calc(100vh - 200px))`,
              right: 16,
              width: 220,
              borderRadius: 16,
              padding: 6,
              color: "#fff",
            }}
          >
            {reorderable && !searching && menuIndex > 0 ? (
              <button type="button" role="menuitem"
                className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
                style={{ padding: "10px 12px", minHeight: 44, borderRadius: 10, color: "#fff" }}
                data-testid="home-menu-up"
                onClick={() => {
                  setMenu(null);
                  onMove(menuView.row.address, -1);
                }}>
                Move up
              </button>
            ) : null}
            {reorderable && !searching && menuIndex < views.length - 1 ? (
              <button type="button" role="menuitem"
                className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
                style={{ padding: "10px 12px", minHeight: 44, borderRadius: 10, color: "#fff" }}
                data-testid="home-menu-down"
                onClick={() => {
                  setMenu(null);
                  onMove(menuView.row.address, 1);
                }}>
                Move down
              </button>
            ) : null}
            <MuteMenuItems
              serverId={menuTarget?.serverId}
              rowRef={menuRef}
              onDone={() => setMenu(null)}
            />
            <button type="button" role="menuitem"
              className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
              style={{ padding: "10px 12px", minHeight: 44, borderRadius: 10, color: REMOVE_RED }}
              data-testid="home-menu-remove"
              onClick={() => {
                setMenu(null);
                onRemove(menuView.row.address);
              }}>
              Remove from Home
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
