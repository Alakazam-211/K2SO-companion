import { invoke, isTauri } from "@tauri-apps/api/core";
import { useServersStore } from "../stores/servers";
import { iconRevOf, parseCliProjects } from "../zen/agentRow";
import { PUSH_PLUGIN, pushAvailability } from "./pushAvailability";

// Notification avatar cache — iOS Communication Notifications.
//
// A Thread push names `subdomain` + `projectId`. The iOS Notification
// Service Extension (gen/apple/K2NotificationService) shows that
// workspace's picture as the big notification icon, read from the App
// Group container. This module feeds that container: whenever a
// server's `/cli/projects/list` (or a `get-icon` fill-in) is loaded, the
// workspace icons go to the k2-push plugin's `cache_avatars` command.
//
// Key: `<subdomain>|<projectId>` lowercased, where subdomain is the
// server's tunnel label (`<label>.k2.dev`, the same rule `push.ts` uses
// to match a tap). Servers on any other host never get a push with a
// subdomain, so they are skipped. `rev` = the row's `iconRev` when K2
// sends it, else a hash of the icon string.
//
// Only `data:image/…` icons are sent. http(s) icon URLs are skipped for
// now (the extension makes no network calls; fetching them here would
// need the Tauri HTTP path and auth) — those workspaces get initials.
//
// Best-effort and quiet: coalesced on a short timer, no-op unless the
// push plugin is available on iOS, and nothing here throws into callers.

export type AvatarItem = { key: string; rev: string; dataUrl: string };

type CacheResult = {
  available: boolean;
  written?: number;
  skipped?: number;
  failed?: number;
  reason?: string | null;
};

/** How long a queued batch waits for more before it is sent. */
export const AVATAR_FLUSH_MS = 1500;
/** Items per plugin call (each carries a data URL). */
export const AVATAR_CHUNK = 20;

type Deps = {
  /** Cheap synchronous gate; false = do nothing at all. */
  enabled: () => boolean;
  availability: () => Promise<{ available: boolean; platform: string }>;
  call: (items: AvatarItem[]) => Promise<CacheResult>;
  serverUrl: (serverId: string) => string | null;
  flushMs: number;
};

const defaultDeps: Deps = {
  enabled: () => {
    try {
      return isTauri();
    } catch {
      return false;
    }
  },
  availability: pushAvailability,
  call: (items) => invoke<CacheResult>(`plugin:${PUSH_PLUGIN}|cache_avatars`, { items }),
  serverUrl: (serverId) =>
    useServersStore.getState().servers.find((x) => x.id === serverId)?.url ?? null,
  flushMs: AVATAR_FLUSH_MS,
};

let deps: Deps = defaultDeps;

/** key → item waiting for the next flush (last one wins). */
const pending = new Map<string, AvatarItem>();
/** key → rev the native side has taken this session. */
const sent = new Map<string, string>();
/** key → the icon string its fallback rev was hashed from. */
const revMemo = new Map<string, { url: string; rev: string }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
/** Native said no (no App Group entitlement, not iOS): stop for the session. */
let disabled = false;

/** `<subdomain>|<projectId>`, lowercased (the extension looks up the same). */
export function avatarKey(subdomain: string, projectId: string): string {
  return `${subdomain.trim()}|${projectId.trim()}`.toLowerCase();
}

/** The tunnel label of a `https://<label>.k2.dev` server URL, lowercased;
 *  null for any other host. Matches push.ts `matchTapServer`. */
export function subdomainOfServerUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const m = /^([a-z0-9-]+)\.k2\.dev$/.exec(host);
  return m ? m[1] : null;
}

/** 32-bit FNV-1a over the UTF-16 code units, plus the length. Stable,
 *  cheap; only a change detector, never security. */
export function iconRevFallback(iconUrl: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < iconUrl.length; i++) {
    h ^= iconUrl.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `h${iconUrl.length.toString(36)}-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** A data: URL the native side can decode (raster image; not SVG). */
export function isCacheableIcon(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s.startsWith("data:image/") && !s.startsWith("data:image/svg") && s.includes(",");
}

function revFor(key: string, iconUrl: string, iconRev: string | null): string {
  if (iconRev) return iconRev;
  const memo = revMemo.get(key);
  if (memo && memo.url === iconUrl) return memo.rev;
  const rev = iconRevFallback(iconUrl);
  revMemo.set(key, { url: iconUrl, rev });
  return rev;
}

/** One server's `/cli/projects/list` body → cache items. Rows without an
 *  id or a cacheable data: icon are skipped. Pure apart from the hash memo. */
export function avatarItemsFromProjects(subdomain: string, data: unknown): AvatarItem[] {
  const rows = parseCliProjects(data);
  if (!rows) return [];
  const out: AvatarItem[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : typeof r.id === "number" ? String(r.id) : "";
    if (!id || !isCacheableIcon(r.iconUrl)) continue;
    const dataUrl = (r.iconUrl as string).trim();
    const key = avatarKey(subdomain, id);
    out.push({ key, rev: revFor(key, dataUrl, iconRevOf(r.iconRev)), dataUrl });
  }
  return out;
}

function enqueue(items: AvatarItem[]): void {
  let added = false;
  for (const it of items) {
    if (sent.get(it.key) === it.rev) {
      pending.delete(it.key);
      continue;
    }
    pending.set(it.key, it);
    added = true;
  }
  if (added && !timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushAvatarCache();
    }, deps.flushMs);
  }
}

/** After a server's `/cli/projects/list` loaded. Never throws. */
export function queueServerAvatars(serverId: string, projectsData: unknown): void {
  try {
    if (disabled || !deps.enabled()) return;
    const sub = subdomainOfServerUrl(deps.serverUrl(serverId));
    if (!sub) return;
    enqueue(avatarItemsFromProjects(sub, projectsData));
  } catch (e) {
    console.warn("[avatars] queue skipped:", e);
  }
}

/** One workspace picture from elsewhere (a `get-icon` fill-in for a row
 *  whose projects/list entry had none). Never throws. */
export function queueAvatar(
  serverId: string,
  projectId: string | null | undefined,
  dataUrl: string | null | undefined,
  iconRev?: string | null
): void {
  try {
    if (disabled || !deps.enabled()) return;
    if (!projectId || !isCacheableIcon(dataUrl)) return;
    const sub = subdomainOfServerUrl(deps.serverUrl(serverId));
    if (!sub) return;
    const url = dataUrl.trim();
    const key = avatarKey(sub, projectId);
    enqueue([{ key, rev: revFor(key, url, iconRevOf(iconRev)), dataUrl: url }]);
  } catch (e) {
    console.warn("[avatars] queue skipped:", e);
  }
}

/** Send what is queued now (the timer calls this). Concurrent calls share
 *  one run. Never throws. */
export function flushAvatarCache(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!pending.size) return;
      const avail = await deps.availability();
      if (!avail.available || avail.platform !== "ios") {
        disabled = true;
        pending.clear();
        return;
      }
      while (pending.size && !disabled) {
        const batch = [...pending.values()].slice(0, AVATAR_CHUNK);
        for (const it of batch) pending.delete(it.key);
        let res: CacheResult;
        try {
          res = await deps.call(batch);
        } catch (e) {
          // Plugin error: keep them unsent; the next list load re-queues.
          console.warn("[avatars] cache_avatars failed:", e);
          continue;
        }
        if (!res?.available) {
          disabled = true;
          pending.clear();
          if (res?.reason) console.info("[avatars] notification avatars off:", res.reason);
          return;
        }
        // Undecodable items count as taken too: re-sending the same rev
        // would fail the same way.
        for (const it of batch) sent.set(it.key, it.rev);
      }
    } catch (e) {
      console.warn("[avatars] flush skipped:", e);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Tests only: swap the platform edges and forget all state. */
export function __setAvatarCacheDepsForTests(next: Partial<Deps> | null): void {
  if (timer) clearTimeout(timer);
  timer = null;
  flushing = null;
  disabled = false;
  pending.clear();
  sent.clear();
  revMemo.clear();
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

/** Tests only: what is waiting for the next flush. */
export function __pendingAvatarKeysForTests(): string[] {
  return [...pending.keys()];
}
