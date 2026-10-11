import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { connectServer } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { activityForRow } from "./agentActivity";
import { AgentRowContent } from "./AgentRowContent";
import { skinInitials } from "./agentRow";
import { parseHomeAddress } from "./homes";
import type { HomeRowView } from "./homeView";
import { lastAtKeyFor } from "./lastAtFetch";
import type { StubAgent } from "./stubData";
import { mountainListWhen } from "./threadModel";
import { isHorizontalSwipe, SWIPE_SLOP_PX } from "./useRowSwipe";
import { useZenStore } from "./zenStore";

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
 * Open a Home row that lives on another saved server: make that server
 * active the way the Servers sheet does, then open the agent's chat.
 * False when it needs a sign-in or cannot be reached.
 * TODO(multi-server S3): open a room on that server without switching.
 */
export async function openHomeRowOnServer(serverId: string, handle: string): Promise<boolean> {
  const store = useServersStore.getState();
  if (store.activeServerId !== serverId) {
    const outcome = await connectServer(serverId);
    if (outcome !== "still-valid" && outcome !== "revived") return false;
    useServersStore.getState().setActive(serverId);
  }
  await useZenStore.getState().hydrateAgents({ resumeId: handle });
  return true;
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
  onRemove,
  onMove,
  onOpenRemote,
  previewFor,
  inset = "16px",
}: {
  views: HomeRowView[];
  homeName: string;
  searching: boolean;
  onRemove: (address: string) => void;
  /** Reorder within the Home (menu Move up / Move down; not while searching). */
  onMove: (address: string, delta: -1 | 1) => void;
  onOpenRemote: (view: Extract<HomeRowView, { kind: "remote" }>) => void;
  /** Line two of an active-server row: the Agents list's own preview. */
  previewFor: (agent: StubAgent) => ReactNode;
  /** Row side padding: the Agents list's content inset. */
  inset?: string;
}) {
  const source = useZenStore((s) => s.agentSource);
  const activity = useZenStore((s) => s.activity);
  const chatSessions = useZenStore((s) => s.chatSessions);
  const lastAtByKey = useZenStore((s) => s.lastAtByKey);
  const setAgent = useZenStore((s) => s.setAgent);

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
        const busy =
          here && source === "live" ? activityForRow(here, activity, false, chatSessions) : null;
        const lastKey = here && source === "live" ? lastAtKeyFor(here) ?? undefined : undefined;
        const when =
          lastKey && lastAtByKey[lastKey] != null ? mountainListWhen(lastAtByKey[lastKey] as number) : "";
        const name = here?.name ?? v.row.label ?? handle;
        const preview =
          v.kind === "here"
            ? previewFor(v.agent)
            : v.kind === "remote"
              ? `On ${v.serverLabel}`
              : "Not on this server's list right now";
        const dim = v.kind !== "here";
        return (
          <div
            key={address}
            className="relative overflow-hidden"
            data-home-row={address}
            data-home-kind={v.kind}
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
                paddingRight: inset,
                opacity: dim ? 0.55 : 1,
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
              aria-label={v.kind === "remote" ? `${name}, on ${v.serverLabel}` : name}
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
                else if (v.kind === "remote") onOpenRemote(v);
              }}
            >
              <AgentRowContent
                name={name}
                initial={here?.initial ?? skinInitials(name || "?")}
                color={here?.color}
                iconUrl={here?.iconUrl}
                busy={busy}
                when={when}
                preview={preview}
                stub={source === "stub" && v.kind === "here"}
                serverChip={v.kind === "remote" ? v.serverLabel : null}
              />
            </button>
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
            {!searching && menuIndex > 0 ? (
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
            {!searching && menuIndex < views.length - 1 ? (
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
