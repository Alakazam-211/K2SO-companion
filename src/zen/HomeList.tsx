import type { ReactNode } from "react";
import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { activityForRow } from "./agentActivity";
import { AgentRowContent } from "./AgentRowContent";
import { RowDivider } from "./RowDivider";
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
import { useZenStore } from "./zenStore";
import { useZenScope } from "./zenScope";
import { rowUnreadFor, type RowRef } from "./unread";
import { useUnreadStore } from "./unreadStore";
import { AgentMenu, OpenGlyph, RearrangeGlyph, RemoveGlyph, type AgentMenuEntry } from "./AgentMenu";
import { GripHandle, rearrangePadLeft } from "./RearrangeBits";
import { useHoldMenu } from "./useHoldMenu";
import { useRearrange } from "./useRearrange";

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
 * Agents row look. No pin grid. Press and hold a row for its menu (Open,
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
}: {
  views: HomeRowView[];
  homeName: string;
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
}) {
  const source = useZenStore((s) => s.agentSource);
  const activity = useZenStore((s) => s.activity);
  const chatSessions = useZenStore((s) => s.chatSessions);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const zenId = useZenScope().id;
  const setAgent = useZenStore((s) => s.setAgent);
  const unreadServers = useUnreadStore((s) => s.servers);
  const unreadAddrs = useUnreadStore((s) => s.addrs);

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

  const menu = hold.menu && !rearranging ? hold.menu : null;
  const menuView = menu ? views.find((v) => v.row.address === menu.id) ?? null : null;
  const menuTarget = menuView ? homeRowTarget(menuView, zenId) : null;
  const menuRef: RowRef | null = menuTarget ? { kind: "thread", addr: menuTarget.addr } : null;

  /** What a row's tap does (and the menu's Open). */
  const openRow = (v: HomeRowView, failure: RowFailure | null, action: (() => void) | null) => {
    if (v.kind === "here") setAgent(v.agent.id);
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

  const menuEntries = (v: HomeRowView): AgentMenuEntry[] => {
    const { failure, action } = rowState(v);
    const canOpen = v.kind === "here" || v.kind === "remote";
    return [
      ...(canOpen
        ? [{ key: "open", label: "Open", icon: <OpenGlyph />, onSelect: () => openRow(v, failure, action) }]
        : []),
      { key: "mute" as const, mute: { serverId: menuTarget?.serverId, rowRef: menuRef } },
      ...(canRearrange && !searching && views.length > 1 && onRearrange
        ? [{ key: "rearrange", label: "Rearrange", icon: <RearrangeGlyph />, onSelect: onRearrange }]
        : []),
      {
        key: "remove",
        label: "Remove from Home",
        icon: <RemoveGlyph />,
        danger: true,
        onSelect: () => onRemove(v.row.address),
      },
    ];
  };

  return (
    <div data-testid="home-list" data-rearranging={rearranging ? "1" : undefined}>
      <span id="home-row-hint" className="sr-only">
        {rearranging
          ? "Drag a handle to reorder. Tap Done when finished."
          : `Press and hold for options, like Remove from ${homeName}.`}
      </span>
      {views.map((v, i) => {
        const address = v.row.address;
        const handle = parseHomeAddress(address)?.handle ?? "";
        const here = v.kind === "here" ? v.agent : null;
        const { look, failure, action } = rowState(v);
        const there = v.kind === "remote" ? v.resolved?.agent ?? null : null;
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
              background: shift.dragging ? "rgba(44,44,46,.92)" : undefined,
              boxShadow: shift.dragging ? "0 10px 28px rgba(0,0,0,.45)" : undefined,
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
                paddingRight: failure?.action ? `calc(${inset} + 96px)` : inset,
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
                v.kind === "remote"
                  ? `${name}, on ${v.serverLabel}` + (failure ? `, ${failure.copy}` : "")
                  : name
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
                stub={source === "stub" && v.kind === "here"}
                serverChip={v.kind === "remote" ? v.serverLabel : hereChip}
                unread={unread}
              />
            </button>
            {failure && remoteView && !rearranging ? (
              <span
                className="absolute flex items-center"
                style={{ right: inset, top: "50%", transform: "translateY(-50%)" }}
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
            {i < views.length - 1 && !shift.dragging ? (
              <RowDivider
                padLeft={rearrangePadLeft(inset, rearranging)}
                padRight={inset}
                transition={rearrange.reduced ? undefined : "left 200ms cubic-bezier(.2,.9,.25,1)"}
              />
            ) : null}
          </div>
        );
      })}

      {menu && menuView ? (
        <AgentMenu
          label={`Options for ${menuView.row.label} on ${homeName}`}
          menu={menu}
          entries={menuEntries(menuView)}
          onClose={hold.close}
          testId="home-row-menu"
        />
      ) : null}
    </div>
  );
}
