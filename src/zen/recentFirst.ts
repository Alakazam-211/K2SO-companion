import { create } from "zustand";
import { parseHomeAddress } from "./homes";
import type { HomeRowView } from "./homeView";
import { lastAtKeyFor } from "./lastAtFetch";

// "Recent agents first" (Zen Settings → Lists): a phone-only setting,
// never sent to a server. Default OFF. On, the Agents and Home lists keep
// pinned agents at the top, then put the agents this phone last sent a
// message to, newest first; agents never messaged from this phone keep
// the list's own order after them. Off, both lists are exactly as before.
//
// "Spoke to" = a send from this phone's composer (ThreadPane `onSend`).
// The time is kept per row in `k2.zen.recentSent.v1`, keyed like the
// list's last-message times (`lastAtKeyFor`: `<serverId>|t:<addr>`, addr
// lowercased), so the same handle on two servers is two keys. Project
// chats are not rows in either list and are not recorded.
//
// Same synchronous localStorage idiom as the other Zen UI prefs; every
// read and write is in try/catch (a failure keeps it in memory).

export const RECENT_FIRST_KEY = "k2.zen.recentFirst";
export const RECENT_SENT_KEY = "k2.zen.recentSent.v1";
/** Rows remembered; the oldest sends drop off past this. */
export const RECENT_SENT_MAX = 200;

/** Off unless "1" is stored. */
export function readRecentFirst(): boolean {
  try {
    return localStorage.getItem(RECENT_FIRST_KEY) === "1";
  } catch {
    return false;
  }
}

/** `{key: ms}`; anything else reads as empty. */
export function readRecentSent(): Record<string, number> {
  try {
    const raw = localStorage.getItem(RECENT_SENT_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out[k] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** A row's key: its server + main-chat addr (lowercase, like Home rows'
 *  handles). Null for a row with no addr. */
export function recentSentKey(
  serverId: string | null | undefined,
  row: { addr?: string | null }
): string | null {
  const addr = (row.addr || "").trim().toLowerCase();
  return serverId && addr ? lastAtKeyFor(serverId, { addr }) : null;
}

/** Keep the newest `max` sends. */
export function trimRecentSent(sent: Record<string, number>, max = RECENT_SENT_MAX): Record<string, number> {
  const keys = Object.keys(sent);
  if (keys.length <= max) return sent;
  return Object.fromEntries(
    keys
      .sort((a, b) => sent[b] - sent[a])
      .slice(0, max)
      .map((k) => [k, sent[k]])
  );
}

/**
 * The "Recent agents first" order: pinned rows first (their order kept),
 * then rows this phone sent to, newest send first, then every other row in
 * its original relative order.
 */
export function orderRecentFirst<T>(
  rows: T[],
  sent: Record<string, number>,
  keyOf: (row: T) => string | null,
  isPinned: (row: T) => boolean = () => false
): T[] {
  const pinned: T[] = [];
  const recent: { row: T; at: number; index: number }[] = [];
  const rest: T[] = [];
  rows.forEach((row, index) => {
    if (isPinned(row)) {
      pinned.push(row);
      return;
    }
    const key = keyOf(row);
    const at = key ? sent[key] : undefined;
    if (typeof at === "number") recent.push({ row, at, index });
    else rest.push(row);
  });
  recent.sort((a, b) => b.at - a.at || a.index - b.index);
  return [...pinned, ...recent.map((r) => r.row), ...rest];
}

/**
 * A Home row's key and pin, for `orderRecentFirst`. An active-server row
 * is keyed on Zen's server (`activeServerId`, as the Agents list keys
 * it); another server's row on that saved server, by its resolved agent
 * or else its handle. Pinned = pinned on its own server.
 */
export function homeViewRecent(ctx: {
  activeServerId: string | null;
  activePinnedIds: string[];
  /** Another server's pinned row ids (its own lists), when loaded. */
  remotePinnedIds: (serverId: string) => string[] | undefined;
}): { keyOf: (v: HomeRowView) => string | null; isPinned: (v: HomeRowView) => boolean } {
  return {
    keyOf: (v) => {
      const handle = parseHomeAddress(v.row.address)?.handle ?? null;
      if (v.kind === "here") return recentSentKey(ctx.activeServerId, v.agent);
      if (v.kind === "missing") return recentSentKey(ctx.activeServerId, { addr: handle });
      return recentSentKey(v.server?.id, v.resolved?.agent ?? { addr: handle });
    },
    isPinned: (v) => {
      if (v.kind === "here") return ctx.activePinnedIds.includes(v.agent.id);
      if (v.kind === "remote" && v.server && v.resolved?.agent) {
        return !!ctx.remotePinnedIds(v.server.id)?.includes(v.resolved.agent.id);
      }
      return false;
    },
  };
}

type RecentFirstState = {
  /** The setting. */
  on: boolean;
  setOn: (on: boolean) => void;
  /** Last send from this phone, ms, by `recentSentKey`. Recorded whether
   *  the setting is on or not, so turning it on has history. */
  sent: Record<string, number>;
  markSent: (key: string | null, at?: number) => void;
  /** Re-read storage (tests). */
  reload: () => void;
};

export const useRecentFirstStore = create<RecentFirstState>((set, get) => ({
  on: readRecentFirst(),
  setOn: (on) => {
    try {
      localStorage.setItem(RECENT_FIRST_KEY, on ? "1" : "0");
    } catch {
      /* the choice lasts this session */
    }
    set({ on });
  },
  sent: readRecentSent(),
  markSent: (key, at = Date.now()) => {
    if (!key) return;
    const sent = trimRecentSent({ ...get().sent, [key]: at });
    try {
      localStorage.setItem(RECENT_SENT_KEY, JSON.stringify(sent));
    } catch {
      /* quota / private mode: kept in memory */
    }
    set({ sent });
  },
  reload: () => set({ on: readRecentFirst(), sent: readRecentSent() }),
}));
