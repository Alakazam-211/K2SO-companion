import { onServerForget } from "../stores/servers";

// Each saved server's `badgeKey` (K2 0.46.1): an opaque key, stable per
// person per server (server identity + person key; survives token refresh,
// re-login, re-registration, restarts; the owner token and an owner-linked
// login share one). Badge pushes carry it INSTEAD of `principal` (push data
// passes through Apple / Google); Thread and project pushes carry it too.
//
// Learned from: the register-device reply, `GET /cli/push/device`, and
// `GET /cli/thread/unread` (top-level `badgeKey`). A changed value simply
// overwrites. Forgotten with the server (MA2).
//
// Used for: the App Group badge-totals key (`badgeTotals`: badgeKey when
// known, else the tunnel label) and tap routing between two logins on one
// host (`push.matchTapServer`; `subdomain` stays the trust anchor).
//
// Same synchronous localStorage idiom as the other phone prefs: one JSON
// object under `k2.push.badgeKeys.v1`, every access in try/catch (a failed
// write lasts the session).

export const BADGE_KEYS_KEY = "k2.push.badgeKeys.v1";

/** A usable badgeKey: trimmed, 1–128 chars of `[A-Za-z0-9._~:+/=-]`, case
 *  kept. Must match `K2BadgeStore.storeKey` on the native side. */
export function normalizeBadgeKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const k = v.trim();
  return /^[A-Za-z0-9._~:+/=-]{1,128}$/.test(k) ? k : null;
}

/** The `badgeKey` of a reply body (JSON text or object), or null. */
export function badgeKeyFromReply(raw: unknown): string | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== "object") return null;
  return normalizeBadgeKey((o as Record<string, unknown>).badgeKey);
}

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(BADGE_KEYS_KEY);
    const j = raw ? (JSON.parse(raw) as unknown) : null;
    if (j && typeof j === "object") {
      for (const [id, v] of Object.entries(j as Record<string, unknown>)) {
        const k = normalizeBadgeKey(v);
        if (k) out[id] = k;
      }
    }
  } catch {
    /* empty */
  }
  cache = out;
  return out;
}

function save(next: Record<string, string>): void {
  cache = next;
  try {
    localStorage.setItem(BADGE_KEYS_KEY, JSON.stringify(next));
  } catch {
    /* lasts this session */
  }
}

type ChangeListener = (serverId: string, next: string | null, prev: string | null) => void;
const listeners = new Set<ChangeListener>();

/** A server's key changed (learned, replaced, or forgotten). */
export function onBadgeKeyChange(fn: ChangeListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function fire(serverId: string, next: string | null, prev: string | null): void {
  for (const fn of listeners) {
    try {
      fn(serverId, next, prev);
    } catch (e) {
      console.warn("[badgeKeys] listener failed:", e);
    }
  }
}

/** Snapshot: server id → badgeKey. */
export function readBadgeKeys(): Record<string, string> {
  return { ...load() };
}

/** A saved server's badgeKey, or null when not learned yet. */
export function badgeKeyOf(serverId: string | null | undefined): string | null {
  if (!serverId) return null;
  return load()[serverId] ?? null;
}

/** Remember `raw` (when usable) as `serverId`'s badgeKey. True when it
 *  changed. Callers make sure the server is still saved. */
export function learnBadgeKey(serverId: string, raw: unknown): boolean {
  const k = normalizeBadgeKey(raw);
  if (!serverId || !k) return false;
  const cur = load();
  const prev = cur[serverId] ?? null;
  if (prev === k) return false;
  save({ ...cur, [serverId]: k });
  fire(serverId, k, prev);
  return true;
}

/** Drop a server's badgeKey. */
export function forgetBadgeKey(serverId: string): void {
  const cur = load();
  const prev = cur[serverId];
  if (prev === undefined) return;
  const { [serverId]: _gone, ...rest } = cur;
  save(rest);
  fire(serverId, null, prev);
}

// A removed or re-keyed server starts over (MA2).
onServerForget((id) => forgetBadgeKey(id));

/** Tests only: drop the in-memory copy (the next read reloads storage). */
export function __resetBadgeKeysForTests(): void {
  cache = null;
}
