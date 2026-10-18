import { useState } from "react";
import { serverHostKey, useServersStore } from "../stores/servers";
import { parseHomeAddress, selectedHome, useHomesStore } from "./homes";
import { BellIcon } from "./NotifyBell";
import {
  MUTE_CHOICES,
  agentsBackCount,
  homeBackCount,
  homeRowRefs,
  projectsBackCount,
  rowUnreadOf,
  toneColor,
  unreadCountText,
  type RowRef,
  type RowUnread,
} from "./unread";
import { unreadSupported, useRowEntry, useUnreadStore } from "./unreadStore";
import { zenTextPx } from "./zenFont";

// The iMessage-style unread marks (K2 0.46.1 `thread-read-v1`):
//   - a dot left of a row's avatar (blue unread, amber waiting on you,
//     grey muted), and a count pill at the end of line two when more than
//     one (amber waiting count first; "99+" above 99);
//   - a bell-slash after the name of a muted row;
//   - the count pill in the open chat's back button and on server cards;
//   - Mute / Unmute items for the row menus.
// None of it renders for a server without the feature (no entry).

/** The dot left of the avatar. `side` px from the avatar's left edge. */
export function UnreadDot({ unread, side = 16 }: { unread: RowUnread | null; side?: number }) {
  if (!unread || (unread.tone === "muted" && unread.count === 0)) return null;
  const c = toneColor(unread.tone);
  return (
    <span
      aria-hidden
      data-testid="row-unread-dot"
      data-tone={unread.tone}
      className="absolute rounded-full"
      style={{ left: -side, top: "50%", width: 10, height: 10, marginTop: -5, background: c }}
    />
  );
}

/** A small count pill. Nothing at 0. */
export function UnreadCountPill({
  count,
  tone,
  testId = "row-unread-count",
  size = "row",
}: {
  count: number;
  tone: RowUnread["tone"];
  testId?: string;
  size?: "row" | "chrome";
}) {
  const text = unreadCountText(count);
  if (!text) return null;
  const chrome = size === "chrome";
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className="shrink-0 inline-flex items-center justify-center rounded-full tabular-nums"
      style={{
        minWidth: chrome ? 20 : 20,
        height: chrome ? 20 : 20,
        padding: "0 6px",
        background: toneColor(tone),
        color: tone === "waiting" ? "#1c1c1e" : "#fff",
        fontSize: chrome ? 13 : zenTextPx(12),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {text}
    </span>
  );
}

/** Row count pill: only when there is more than one. */
export function RowUnreadCount({ unread }: { unread: RowUnread | null }) {
  if (!unread || unread.count <= 1) return null;
  return <UnreadCountPill count={unread.count} tone={unread.tone} />;
}

export function MutedGlyph() {
  return (
    <span
      className="shrink-0 inline-flex"
      style={{ color: "#8e8e93", alignSelf: "center" }}
      data-testid="row-muted"
      aria-label="Muted"
    >
      <BellIcon on={false} size={13} />
    </span>
  );
}

/** A row's marks from its server and identity (hook form). */
export function useRowUnread(serverId: string | null | undefined, ref: RowRef | null): RowUnread | null {
  return rowUnreadOf(useRowEntry(serverId, ref));
}

const ITEM_STYLE = {
  padding: "10px 12px",
  minHeight: 44,
  borderRadius: 10,
  color: "#fff",
} as const;

/**
 * Mute / Unmute for a row menu. Muted: one "Unmute" item. Not muted: a
 * "Mute" item that opens the durations (1 hour, 8 hours, until I unmute).
 * Renders nothing on a server without `thread-read-v1`, or for a Thread
 * whose conversation is not known yet and has no addr.
 */
export function MuteMenuItems({
  serverId,
  rowRef,
  onDone,
  guard,
}: {
  serverId: string | null | undefined;
  rowRef: RowRef | null;
  onDone: () => void;
  /** False = ignore this click (a hold's release landing on the menu). */
  guard?: () => boolean;
}) {
  const entry = useRowEntry(serverId, rowRef);
  const [open, setOpen] = useState(false);
  // Re-render when the server's feature memory changes with its slice.
  useUnreadStore((s) => (serverId ? !!s.servers[serverId] : false));
  if (!serverId || !rowRef || !unreadSupported(serverId)) return null;
  if (rowRef.kind === "thread" && !rowRef.addr && !rowRef.conversationId) return null;
  const ok = () => !guard || guard();
  const run = (muted: boolean, seconds?: number | null) => {
    if (!ok()) return;
    onDone();
    void useUnreadStore.getState().setMuted(serverId, rowRef, muted, seconds);
  };
  if (entry?.muted) {
    return (
      <button
        type="button"
        role="menuitem"
        className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
        style={{ ...ITEM_STYLE, gap: 10 }}
        data-testid="menu-unmute"
        onClick={() => run(false)}
      >
        <span className="flex-1">Unmute</span>
        <BellIcon on size={16} />
      </button>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        role="menuitem"
        className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
        style={{ ...ITEM_STYLE, gap: 10 }}
        data-testid="menu-mute"
        aria-expanded={false}
        onClick={() => {
          if (ok()) setOpen(true);
        }}
      >
        <span className="flex-1">Mute</span>
        <BellIcon on={false} size={16} />
      </button>
    );
  }
  return (
    <>
      {MUTE_CHOICES.map((c) => (
        <button
          key={c.label}
          type="button"
          role="menuitem"
          className="w-full flex items-center text-left bg-transparent border-0 text-[16px]"
          style={ITEM_STYLE}
          data-testid={`menu-mute-${c.seconds ?? "forever"}`}
          onClick={() => run(true, c.seconds)}
        >
          {c.label}
        </button>
      ))}
    </>
  );
}

/** Which list the open chat's Back returns to. */
export type BackOrigin = "agents" | "home" | "projects";

/**
 * The back arrow's count (iMessage): what the list it returns to has
 * unread, the open chat left out. `total` semantics (muted unread out,
 * waiting cards in). Agents: that server's total. Home: the Home's rows
 * on every server (the active server's only with the multi-server flag
 * off). Projects: that server's project chats. 0 without the feature.
 */
export function useBackUnreadCount(opts: {
  origin: BackOrigin;
  serverId: string | null | undefined;
  open: RowRef | null;
  multiOn: boolean;
}): number {
  const { origin, serverId, open, multiOn } = opts;
  const servers = useUnreadStore((s) => s.servers);
  const addrs = useUnreadStore((s) => s.addrs);
  const homes = useHomesStore((s) => s.homes);
  const homeId = useHomesStore((s) => s.selectedId);
  const saved = useServersStore((s) => s.servers);
  const activeId = useServersStore((s) => s.activeServerId);
  if (!serverId) return 0;
  if (origin === "agents") return agentsBackCount(servers[serverId], addrs[serverId], open);
  if (origin === "projects") {
    return projectsBackCount(servers[serverId], open?.kind === "project" ? open.groupId : null);
  }
  const home = homes.length ? selectedHome({ homes, selectedId: homeId }) : null;
  const list = multiOn ? saved : saved.filter((s) => s.id === activeId);
  const refs = homeRowRefs(
    home?.rows ?? [],
    list.map((s) => ({ id: s.id, hostKey: serverHostKey(s) })),
    parseHomeAddress
  );
  return homeBackCount(refs, servers, addrs, open ? { serverId, ref: open } : null);
}

/** The pill inside the chat's glass back button. Hidden at 0. */
export function BackUnreadPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return <UnreadCountPill count={count} tone="unread" size="chrome" testId="chat-back-unread" />;
}

/** A server card's count: that server's `total` (amber while any card is
 *  waiting on you). Hidden at 0 and without the feature. */
export function ServerUnreadPill({ serverId }: { serverId: string }) {
  const s = useUnreadStore((st) => st.servers[serverId]);
  if (!s || s.total <= 0) return null;
  return (
    <UnreadCountPill
      count={s.total}
      tone={s.waitingTotal > 0 ? "waiting" : "unread"}
      size="chrome"
      testId="server-unread"
    />
  );
}
