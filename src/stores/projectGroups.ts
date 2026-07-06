// Slice C2 — project-groups store for the ACTIVE server: groups list,
// unread dots, per-host icon cache, and the live `/events?token=` feed.
//
// Companion mirror of the desktop's `stores/project-groups.ts`:
//   - Structural events (`project-group:groups-changed` /
//     `members-changed`) → coalesced list refetch (~350ms trailing
//     window; a burst of emits = ONE fetch) + an immediate `revision`
//     bump so mounted views react.
//   - `project-group:message-created` → unread bookkeeping: the OPEN
//     group marks itself seen (its messages are on screen — the chat
//     page refetches on the same revision bump, coalesced ~300ms
//     page-side); every other group accrues the unread dot.
//   - Unread survives restarts via per-server last-seen cursors in
//     localStorage (`messages?after=&limit=1` probe on list refresh).
//   - Icons are cached per `${serverId}:${groupId}` (a group's icon on
//     server A must never render for the same id via server B) and
//     dropped on groups-changed (set-icon emits it) so fresh uploads
//     propagate live.
//
// EVENTS WS LIFECYCLE (the C1 gridSocket revive idiom — never loop on a
// dead token): pages call `startEvents()` (refcounted); the socket URL
// is built FRESH per open, and a close routes through
// `reviveServerSession` before reopening — `signin-required` STOPS the
// loop (the footer/Servers page surface the state). Switching the
// active server retargets the socket and resets all per-server state.

import { create } from "zustand";
import {
  fetchProjectGroups,
  fetchProjectGroupShow,
  fetchProjectGroupIcon,
  fetchUnreadGroupIds,
  type ProjectGroup,
  type GroupIconResult,
} from "../api/projectGroups";
import { getBaseUrl, getToken } from "../api/client";
import { useServersStore } from "./servers";
import { reviveServerSession } from "../lib/revive";
import { iconCacheKey, pocLabel } from "../lib/projectChat";

// ── Per-server last-seen cursors (localStorage; advisory) ──────────────

function lastSeenKey(serverId: string, groupId: string): string {
  return `k2_pg_seen.${serverId}.${groupId}`;
}

function getLastSeen(serverId: string, groupId: string): number {
  try {
    return (
      parseInt(localStorage.getItem(lastSeenKey(serverId, groupId)) ?? "0", 10) || 0
    );
  } catch {
    return 0;
  }
}

function setLastSeenNow(serverId: string, groupId: string): void {
  try {
    localStorage.setItem(
      lastSeenKey(serverId, groupId),
      String(Math.floor(Date.now() / 1000))
    );
  } catch {
    /* private mode / quota — the dot just re-arms next launch */
  }
}

// ── Store ──────────────────────────────────────────────────────────────

interface ProjectGroupsState {
  /** The server the current `groups` were fetched for — lets a page
   *  detect "the active server changed while I was unmounted" and reset
   *  instead of rendering another server's groups. */
  forServerId: string | null;
  /** null = never fetched for the current server (loading state). */
  groups: ProjectGroup[] | null;
  loading: boolean;
  error: string | null;
  /** PoC display name per group id (enriched from `show` fan-out). */
  pocNames: Record<string, string>;
  unreadGroupIds: Set<string>;
  /** Bumped on every relevant live event; open views refetch on it. */
  revision: number;
  /** Group the chat screen currently has open (its events mark-seen
   *  instead of accruing unread); null = list/none. */
  openGroupId: string | null;
  /** Icon cache, keyed `${serverId}:${groupId}`. Missing = not yet
   *  fetched; `found:false` = fetched, group has no icon (initials). */
  icons: Record<string, GroupIconResult>;

  refreshGroups: () => Promise<void>;
  setOpenGroup: (groupId: string | null) => void;
  markGroupSeen: (groupId: string) => void;
  /** Fetch-and-cache a group's icon (no-op when already cached). */
  ensureIcon: (groupId: string) => void;
  /** Reset everything server-scoped (the active server changed). */
  resetForServer: () => void;
}

export const useProjectGroupsStore = create<ProjectGroupsState>((set, get) => ({
  forServerId: null,
  groups: null,
  loading: false,
  error: null,
  pocNames: {},
  unreadGroupIds: new Set<string>(),
  revision: 0,
  openGroupId: null,
  icons: {},

  refreshGroups: async () => {
    const serverId = useServersStore.getState().activeServerId;
    if (!serverId) {
      set({ forServerId: null, groups: [], error: null, loading: false });
      return;
    }
    set({ forServerId: serverId, loading: true });
    const r = await fetchProjectGroups();
    // A server switch mid-flight: drop this response, the new server's
    // own refresh is (or will be) running.
    if (useServersStore.getState().activeServerId !== serverId) return;
    if (!r.ok) {
      set({ loading: false, error: r.error ?? "Failed to load projects" });
      return;
    }
    const groups = r.data ?? [];
    set({ groups, error: null, loading: false });

    // Advisory enrichments — never block or error the list.
    // 1. Unread dots from the per-server last-seen cursors.
    void fetchUnreadGroupIds(groups, (gid) => getLastSeen(serverId, gid)).then(
      (unread) => {
        if (useServersStore.getState().activeServerId !== serverId) return;
        const open = get().openGroupId;
        set({
          unreadGroupIds: new Set(unread.filter((id) => id !== open)),
        });
      }
    );
    // 2. PoC display names (list rows carry only pocWorkspaceId).
    void Promise.all(
      groups
        .filter((g) => g.pocWorkspaceId !== null)
        .map(async (g) => {
          const s = await fetchProjectGroupShow(g.id);
          if (!s.ok || !s.data) return null;
          const label = pocLabel(s.data.members, s.data.pocWorkspaceId);
          return label ? ([g.id, label] as const) : null;
        })
    ).then((pairs) => {
      if (useServersStore.getState().activeServerId !== serverId) return;
      const pocNames: Record<string, string> = {};
      for (const p of pairs) if (p) pocNames[p[0]] = p[1];
      set({ pocNames });
    });
  },

  setOpenGroup: (groupId) => {
    set({ openGroupId: groupId });
    if (groupId) get().markGroupSeen(groupId);
  },

  markGroupSeen: (groupId) => {
    const serverId = useServersStore.getState().activeServerId;
    if (serverId) setLastSeenNow(serverId, groupId);
    set((s) => {
      if (!s.unreadGroupIds.has(groupId)) return {};
      const next = new Set(s.unreadGroupIds);
      next.delete(groupId);
      return { unreadGroupIds: next };
    });
  },

  ensureIcon: (groupId) => {
    const serverId = useServersStore.getState().activeServerId;
    if (!serverId) return;
    const key = iconCacheKey(serverId, groupId);
    if (get().icons[key]) return;
    void fetchProjectGroupIcon(groupId).then((r) => {
      // Cache misses too (found:false) so a broken route never hammers
      // the daemon — the initials fallback is always right.
      const entry: GroupIconResult = r.ok && r.data ? r.data : { found: false, dataUrl: null };
      set((s) => ({ icons: { ...s.icons, [key]: entry } }));
    });
  },

  resetForServer: () => {
    set({
      forServerId: null,
      groups: null,
      loading: false,
      error: null,
      pocNames: {},
      unreadGroupIds: new Set<string>(),
      revision: get().revision + 1,
      // openGroupId is route-owned; icons keep other servers' entries
      // (keys are server-scoped, so nothing can bleed).
    });
  },
}));

// ── Live events (module-level singleton, refcounted) ───────────────────

interface WireEvent {
  event: string;
  payload?: {
    groupId?: string;
    author?: string;
  };
}

let eventsWs: WebSocket | null = null;
/** The server the open socket was built for (revive target on close). */
let eventsServerId: string | null = null;
let eventsRefs = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let listRefetchTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesced structural refetch (the desktop bumpAndCoalesceRefetch
 *  idiom): bump revision NOW, refetch once per ~350ms burst. */
function bumpAndCoalesceRefetch(): void {
  useProjectGroupsStore.setState((s) => ({ revision: s.revision + 1 }));
  if (listRefetchTimer) clearTimeout(listRefetchTimer);
  listRefetchTimer = setTimeout(() => {
    listRefetchTimer = null;
    void useProjectGroupsStore.getState().refreshGroups();
  }, 350);
}

function dropIconForGroup(groupId?: string): void {
  useProjectGroupsStore.setState((s) => {
    if (!groupId) return { icons: {} };
    const suffix = `:${groupId}`;
    const icons = { ...s.icons };
    let touched = false;
    for (const k of Object.keys(icons)) {
      if (k.endsWith(suffix)) {
        delete icons[k];
        touched = true;
      }
    }
    return touched ? { icons } : {};
  });
}

function handleWireEvent(frame: WireEvent): void {
  const store = useProjectGroupsStore.getState();
  switch (frame.event) {
    case "project-group:message-created": {
      const groupId = frame.payload?.groupId;
      if (!groupId) return;
      if (store.openGroupId === groupId) {
        // On screen: the chat page's revision effect coalesce-refetches
        // (~300ms); keep the seen cursor current instead of dotting.
        store.markGroupSeen(groupId);
        useProjectGroupsStore.setState((s) => ({ revision: s.revision + 1 }));
      } else {
        useProjectGroupsStore.setState((s) => {
          const next = new Set(s.unreadGroupIds);
          next.add(groupId);
          return { unreadGroupIds: next, revision: s.revision + 1 };
        });
      }
      break;
    }
    case "project-group:groups-changed":
      // set-icon/set-color ride this — drop the icon FIRST so the
      // revision bump makes mounted avatars refetch a fresh copy.
      dropIconForGroup(frame.payload?.groupId);
      bumpAndCoalesceRefetch();
      break;
    case "project-group:members-changed":
      // Membership/PoC moved — the list refetch re-runs the PoC fan-out.
      bumpAndCoalesceRefetch();
      break;
    default:
      break; // feedback:* etc — not this store's business
  }
}

/** Build the WS URL FRESH each open so a token revived between attempts
 *  is picked up (the daemon kicks stale tokens off the WS within 5s —
 *  reconnecting with the old one would just be kicked again). */
function buildEventsUrl(): string | null {
  const base = getBaseUrl().replace(/^http/, "ws");
  if (!base) return null;
  return `${base}/events?token=${encodeURIComponent(getToken())}`;
}

function openEvents(): void {
  const url = buildEventsUrl();
  if (!url) return; // no active server — nothing to stream from
  try {
    eventsWs = new WebSocket(url);
  } catch {
    scheduleEventsReconnect();
    return;
  }
  const ws = eventsWs;
  ws.onmessage = (e) => {
    let frame: WireEvent;
    try {
      frame = JSON.parse(e.data as string) as WireEvent;
    } catch {
      return; // non-JSON frame — ignore
    }
    try {
      handleWireEvent(frame);
    } catch (err) {
      console.warn("[projectGroups] event handler error:", err);
    }
  };
  ws.onclose = () => {
    if (eventsWs === ws && eventsRefs > 0) scheduleEventsReconnect();
  };
  ws.onerror = () => {
    ws.close();
  };
}

function scheduleEventsReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (eventsRefs > 0) void reviveThenReopen();
  }, 2000);
}

/** Consult the revive path BEFORE re-opening (the C1 gridSocket rule): a
 *  WS close after a daemon restart is a stale-token kick that looks like
 *  a network drop; reconnect-forever on a dead token was the stranding
 *  bug. `signin-required` STOPS this loop until the user acts. */
async function reviveThenReopen(): Promise<void> {
  if (eventsServerId) {
    const outcome = await reviveServerSession(eventsServerId);
    if (eventsRefs === 0) return;
    // The user may have switched servers while we probed — retarget.
    if (useServersStore.getState().activeServerId !== eventsServerId) {
      retargetEvents();
      return;
    }
    if (outcome === "signin-required" || outcome === "not-applicable") return;
    // revived / still-valid → reopen with the (possibly fresh) token;
    // unreachable / cooldown → reopen anyway; the next close lands back
    // here (network-down keeps its retry cadence).
  }
  if (eventsRefs > 0) openEvents();
}

function closeEvents(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ws = eventsWs;
  eventsWs = null; // onclose sees a mismatch → no reconnect
  ws?.close();
}

/** (Re)open the socket against the CURRENT active server. */
function retargetEvents(): void {
  closeEvents();
  eventsServerId = useServersStore.getState().activeServerId;
  if (eventsServerId) openEvents();
}

/**
 * Subscribe this page to live project-group events. Refcounted: the
 * first subscriber opens the socket, the last cleanup closes it. Safe
 * to call from every Projects surface (list + chat + docs) — they share
 * one socket. Re-invoke on active-server change (pages key their effect
 * on `activeServerId`); a server mismatch retargets the stream.
 */
export function startEvents(): () => void {
  eventsRefs += 1;
  const activeId = useServersStore.getState().activeServerId;
  if (eventsRefs === 1 || eventsServerId !== activeId) {
    retargetEvents();
  }
  let released = false;
  return () => {
    if (released) return; // idempotent (strict-mode double cleanup)
    released = true;
    eventsRefs -= 1;
    if (eventsRefs <= 0) {
      eventsRefs = 0;
      closeEvents();
      eventsServerId = null;
    }
  };
}
