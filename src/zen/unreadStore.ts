import { create } from "zustand";
import { scopeFor } from "../api/scope";
import {
  getThreadUnread,
  postProjectRead,
  postThreadMute,
  postThreadRead,
} from "../api/threadRead";
import { clearServerTotals, setServerTotals } from "../lib/badgeTotals";
import { onServerForget, useServersStore } from "../stores/servers";
import {
  EMPTY_SERVER_UNREAD,
  addrKey,
  blankEntry,
  conversationOf,
  entryForRow,
  optimisticMute,
  optimisticRead,
  parseTotals,
  parseUnreadEntry,
  parseUnreadSummary,
  rowKeyOf,
  withEntry,
  type AddrMap,
  type RowRef,
  type ServerUnread,
  type UnreadEntry,
  type UnreadTotals,
} from "./unread";

// Unread counts per saved server (K2 0.46.1 `thread-read-v1`).
//
// One slice per server id: the conversations with something unread, a
// card waiting, or a mute, plus the badge totals. Seeded by
// `GET /cli/thread/unread`, patched by `thread_read` / `project_read`
// frames on that server's `/cli/sessions/events` socket (`unreadSync`), by
// our own read / mute replies, and optimistically by `markRead` /
// `setMuted`. Every totals change feeds the app-icon badge
// (`setServerTotals`, coalesced natively per server).
//
// Gating: a server whose `/boot-status` does not list `thread-read-v1`
// (or that has no login here) is never asked anything; its slice is
// dropped and its badge share cleared, so it shows no dots and is left
// out of the badge.

export const FEATURE = "thread-read-v1" as const;

type State = {
  servers: Record<string, ServerUnread>;
  /** serverId → (lowercased addr → conversationId). */
  addrs: Record<string, AddrMap>;
  /** Re-read one server's summary. `minGapMs` skips it when the last read
   *  started that recently. No-op without the feature or a login. */
  refresh: (serverId: string, opts?: { minGapMs?: number }) => Promise<void>;
  /** A `thread_read` / `project_read` frame (or a POST reply). */
  applyFrame: (serverId: string, frame: unknown) => void;
  /** Read `ref` up to `seq` (absent = newest). Optimistic; one request in
   *  flight per conversation; a later seq asked meanwhile follows it. */
  markRead: (serverId: string, ref: RowRef, seq?: number) => Promise<void>;
  /** Mute (for `seconds`, or until unmuted) or unmute. Optimistic. True
   *  when the server took it. */
  setMuted: (
    serverId: string,
    ref: RowRef,
    muted: boolean,
    seconds?: number | null
  ) => Promise<boolean>;
  /** A Thread's addr ↔ conversationId (from `thread/latest`, the open
   *  Thread). */
  noteAddr: (serverId: string, addr: string | null | undefined, conversationId: string | null | undefined) => void;
};

/** Does `serverId` take the read routes (feature listed + signed in)? */
export function unreadSupported(serverId: string | null | undefined): boolean {
  if (!serverId) return false;
  try {
    const scope = scopeFor(serverId);
    return scope.supports(FEATURE) && !!scope.token();
  } catch {
    return false;
  }
}

function saved(serverId: string): boolean {
  return useServersStore.getState().servers.some((s) => s.id === serverId);
}

function pushTotals(serverId: string, t: UnreadTotals): void {
  setServerTotals(serverId, { unread: t.total, waiting: t.waitingTotal });
}

type Mem = {
  inflight: Promise<void> | null;
  again: boolean;
  startedAt: number;
  /** Bumped by every frame / reply: a summary read that started before
   *  one may be older than it, so it is read again. */
  gen: number;
};
const mem = new Map<string, Mem>();
function memOf(serverId: string): Mem {
  let m = mem.get(serverId);
  if (!m) {
    m = { inflight: null, again: false, startedAt: 0, gen: 0 };
    mem.set(serverId, m);
  }
  return m;
}

/** `${serverId}|${key}` → the newest seq asked while a read POST runs
 *  (`null` = "newest now"; `undefined` = nothing more). */
const readsInFlight = new Map<string, { pending: number | null | undefined }>();

export const useUnreadStore = create<State>((set, get) => {
  /** Forget a server that lost the feature or its login: no dots, and its
   *  share leaves the badge. */
  const drop = (serverId: string) => {
    if (!get().servers[serverId]) return;
    set((s) => {
      const servers = { ...s.servers };
      delete servers[serverId];
      return { servers };
    });
    clearServerTotals(serverId);
  };

  const apply = (serverId: string, entry: UnreadEntry, totals: UnreadTotals | null) => {
    memOf(serverId).gen += 1;
    set((s) => ({
      servers: {
        ...s.servers,
        [serverId]: withEntry(s.servers[serverId] ?? EMPTY_SERVER_UNREAD, entry, totals),
      },
    }));
    if (totals) pushTotals(serverId, totals);
  };

  const patch = (serverId: string, next: ServerUnread) => {
    set((s) => ({ servers: { ...s.servers, [serverId]: next } }));
    pushTotals(serverId, next);
  };

  return {
    servers: {},
    addrs: {},

    refresh: async (serverId, opts = {}) => {
      if (!serverId) return;
      if (!unreadSupported(serverId)) {
        drop(serverId);
        return;
      }
      const m = memOf(serverId);
      if (opts.minGapMs && Date.now() - m.startedAt < opts.minGapMs) return;
      if (m.inflight) {
        m.again = true;
        return m.inflight;
      }
      m.startedAt = Date.now();
      const gen = m.gen;
      const run = (async () => {
        const r = await getThreadUnread(scopeFor(serverId));
        if (!r.ok || !saved(serverId) || !unreadSupported(serverId)) return;
        const next = parseUnreadSummary(r.data);
        if (!next) return;
        // A frame or reply landed meanwhile: this answer may be older.
        if (memOf(serverId).gen !== gen) m.again = true;
        set((s) => ({ servers: { ...s.servers, [serverId]: next } }));
        pushTotals(serverId, next);
      })()
        .catch(() => {
          /* what is shown stays; the next trigger reads again */
        })
        .finally(() => {
          m.inflight = null;
          if (m.again) {
            m.again = false;
            void get().refresh(serverId);
          }
        });
      m.inflight = run;
      return run;
    },

    applyFrame: (serverId, frame) => {
      if (!serverId || !unreadSupported(serverId)) return;
      const entry = parseUnreadEntry(frame);
      if (!entry) return;
      apply(serverId, entry, parseTotals(frame));
    },

    markRead: async (serverId, ref, seq) => {
      if (!unreadSupported(serverId)) return;
      const key = rowKeyOf(ref, get().addrs[serverId]);
      if (!key) return;
      const before = get().servers[serverId]?.byKey[key];
      // Nothing unread there (or already read that far): nothing to send.
      if (!before || before.unread <= 0) return;
      if (seq !== undefined && seq <= before.lastReadSeq) return;
      const slotKey = `${serverId}|${key}`;
      const running = readsInFlight.get(slotKey);
      if (running) {
        const p = running.pending;
        running.pending = seq === undefined || p === null ? null : Math.max(p ?? 0, seq);
        return;
      }
      const slot: { pending: number | null | undefined } = { pending: undefined };
      readsInFlight.set(slotKey, slot);
      patch(serverId, optimisticRead(get().servers[serverId] ?? EMPTY_SERVER_UNREAD, key, seq));
      let acked = -1;
      try {
        const scope = scopeFor(serverId);
        const r =
          ref.kind === "project"
            ? await postProjectRead(scope, ref.groupId, seq)
            : await postThreadRead(
                scope,
                { conversationId: conversationOf(ref, get().addrs[serverId]), addr: ref.addr },
                seq
              );
        if (!r.ok) throw new Error(r.error || "read failed");
        const entry = parseUnreadEntry(r.data, ref.kind);
        if (entry && saved(serverId)) {
          acked = entry.lastReadSeq;
          apply(serverId, entry, parseTotals(r.data));
        }
      } catch {
        // Put the truth back.
        if (saved(serverId)) void get().refresh(serverId);
      } finally {
        readsInFlight.delete(slotKey);
      }
      const next = slot.pending;
      if (next === undefined || !saved(serverId)) return;
      if (next === null) await get().markRead(serverId, ref);
      else if (next > acked) await get().markRead(serverId, ref, next);
    },

    setMuted: async (serverId, ref, muted, seconds) => {
      if (!unreadSupported(serverId)) return false;
      const addrs = get().addrs[serverId];
      const key = rowKeyOf(ref, addrs);
      const until =
        muted && typeof seconds === "number" && seconds > 0
          ? Math.floor(Date.now() / 1000) + Math.floor(seconds)
          : undefined;
      if (key) {
        const cur = get().servers[serverId] ?? EMPTY_SERVER_UNREAD;
        const base =
          cur.byKey[key] ??
          blankEntry(ref.kind, ref.kind === "project" ? ref.groupId : (conversationOf(ref, addrs) as string));
        patch(serverId, optimisticMute(cur, base, muted, until ?? null));
      }
      try {
        const scope = scopeFor(serverId);
        const target =
          ref.kind === "project"
            ? ({ kind: "project", group: ref.groupId } as const)
            : ({
                kind: "thread",
                conversationId: conversationOf(ref, addrs),
                addr: ref.addr,
              } as const);
        const r = await postThreadMute(scope, target, muted, until);
        if (!r.ok) throw new Error(r.error || "mute failed");
        const entry = parseUnreadEntry(r.data, ref.kind);
        if (entry && saved(serverId)) {
          if (ref.kind === "thread" && ref.addr) get().noteAddr(serverId, ref.addr, entry.id);
          apply(serverId, entry, parseTotals(r.data));
        }
        return true;
      } catch {
        if (saved(serverId)) void get().refresh(serverId);
        return false;
      }
    },

    noteAddr: (serverId, addr, conversationId) => {
      const a = (addr || "").trim();
      const c = (conversationId || "").trim();
      if (!serverId || !a || !c) return;
      const k = addrKey(a);
      if (get().addrs[serverId]?.[k] === c) return;
      set((s) => ({ addrs: { ...s.addrs, [serverId]: { ...(s.addrs[serverId] ?? {}), [k]: c } } }));
    },
  };
});

// A removed / re-keyed server: its slice and memory go (the badge hooks in
// `badgeTotals` clear its share).
onServerForget((id) => {
  mem.delete(id);
  for (const k of [...readsInFlight.keys()]) if (k.startsWith(`${id}|`)) readsInFlight.delete(k);
  const s = useUnreadStore.getState();
  if (!s.servers[id] && !s.addrs[id]) return;
  const servers = { ...s.servers };
  const addrs = { ...s.addrs };
  delete servers[id];
  delete addrs[id];
  useUnreadStore.setState({ servers, addrs });
});

/** Module helper for non-React callers (`lastAtFetch`). */
export function noteThreadAddr(
  serverId: string,
  addr: string | null | undefined,
  conversationId: string | null | undefined
): void {
  useUnreadStore.getState().noteAddr(serverId, addr, conversationId);
}

/** One row's entry (hook). Null when nothing to show. */
export function useRowEntry(serverId: string | null | undefined, ref: RowRef | null): UnreadEntry | null {
  return useUnreadStore((s) =>
    serverId ? entryForRow(s.servers[serverId], s.addrs[serverId], ref) : null
  );
}

/** Tests only. */
export function __resetUnreadStoreForTests(): void {
  mem.clear();
  readsInFlight.clear();
  useUnreadStore.setState({ servers: {}, addrs: {} });
}
