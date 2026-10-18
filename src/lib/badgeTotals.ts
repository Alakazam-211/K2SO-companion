import { addPluginListener, invoke, isTauri } from "@tauri-apps/api/core";
import { onServerForget, onServerLeave, useServersStore } from "../stores/servers";
import { subdomainOfServerUrl } from "./avatarCache";
import { PUSH_PLUGIN, pushAvailability, type Availability } from "./pushAvailability";

// App-icon badge totals — iOS (K2 0.46.1 contract; dormant until it lands).
//
// The badge is the sum of each server's `unreadTotal` (unmuted unread +
// all waiting), kept natively in the App Group (`K2BadgeStore.swift`,
// shared by the k2-push plugin and the Notification Service Extension):
//   <AppGroup>/badges/totals.json
//     {"version":1,"servers":{"<subdomain>":{"unread","waiting","at"}}}
// Writers: the NSE (alert pushes carrying totals), the plugin (silent
// `{kind:"badge"}` pushes) and this module (live frames, list fetches,
// app open, server removed / signed out). Servers never send `aps.badge`:
// with several servers on one phone only the phone can sum.
//
// Key = the server's tunnel label (`<label>.k2.dev`, lowercased), the
// same rule as the avatar cache. Servers on any other host never get a
// push with a subdomain, so they are skipped.
//
// Best-effort and quiet: updates are coalesced on a short timer (last
// value per server wins), everything is a no-op unless the push plugin is
// available on iOS, and nothing here throws into callers. Not wired to
// any unread UI yet — callers come with K2's unread contract.

export type ServerTotals = { unread: number; waiting: number; at: number };

export type BadgeTotals = {
  available: boolean;
  sum: number;
  version: number;
  servers: Record<string, ServerTotals>;
  reason?: string | null;
};

/** Received pushes for one server on one local day. */
export type BadgeDayCount = { silent: number; alert: number; lastAt?: number };

/** `<AppGroup>/badges/received.json`: `days["YYYY-MM-DD"][subdomain]`. */
export type BadgeDiagnostics = {
  available: boolean;
  version: number;
  days: Record<string, Record<string, BadgeDayCount>>;
  reason?: string | null;
};

/** The plugin's `badgeTotals` event, plus the saved server it belongs to. */
export type BadgeTotalsEvent = {
  subdomain: string;
  unread: number;
  waiting: number | null;
  sum: number;
  serverId: string | null;
};

type SumResult = { available: boolean; sum?: number; reason?: string | null };
type Listener = { unregister: () => Promise<void> | void };

/** How long a queued update waits for more before it is sent. */
export const BADGE_FLUSH_MS = 250;

type Deps = {
  /** Cheap synchronous gate; false = do nothing at all. */
  enabled: () => boolean;
  availability: () => Promise<Availability>;
  call: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: (event: string, cb: (payload: unknown) => void) => Promise<Listener>;
  servers: () => { id: string; url: string }[];
  onForget: (fn: (serverId: string) => void) => () => void;
  onLeave: (fn: (server: { id: string; url: string }) => void) => () => void;
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
  call: (cmd, args) => invoke(`plugin:${PUSH_PLUGIN}|${cmd}`, args),
  listen: (event, cb) => addPluginListener(PUSH_PLUGIN, event, cb),
  servers: () => useServersStore.getState().servers,
  onForget: (fn) => onServerForget((id) => fn(id)),
  onLeave: (fn) => onServerLeave((server) => fn(server)),
  flushMs: BADGE_FLUSH_MS,
};

let deps: Deps = defaultDeps;

/** subdomain → totals to set, or null = clear (last one wins). */
const pending = new Map<string, { unread: number; waiting?: number } | null>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
/** Native said no (not iOS, no App Group): stop for the session. */
let disabled = false;
let hooksInstalled: (() => void) | null = null;

/** A non-negative integer, or null. */
function count(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function subdomainOfServer(serverId: string): string | null {
  const url = deps.servers().find((s) => s.id === serverId)?.url;
  return subdomainOfServerUrl(url);
}

/** True when badge totals work here: Tauri, push available, iOS. */
export async function badgeTotalsSupported(): Promise<boolean> {
  try {
    if (disabled || !deps.enabled()) return false;
    const a = await deps.availability();
    return a.available && a.platform === "ios";
  } catch {
    return false;
  }
}

function enqueue(sub: string, value: { unread: number; waiting?: number } | null): void {
  pending.set(sub, value);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushBadgeTotals();
    }, deps.flushMs);
  }
}

/** One server's totals (a live frame, a list fetch, app open). Coalesced;
 *  `waiting` omitted keeps the stored value. Never throws. */
export function setServerTotals(
  serverId: string,
  totals: { unread: unknown; waiting?: unknown }
): void {
  try {
    if (disabled || !deps.enabled()) return;
    const sub = subdomainOfServer(serverId);
    if (!sub) return;
    const unread = count(totals.unread);
    if (unread === null) return;
    const waiting = count(totals.waiting);
    enqueue(sub, waiting === null ? { unread } : { unread, waiting });
  } catch (e) {
    console.warn("[badge] set skipped:", e);
  }
}

/** Drop a server's totals (removed / signed out). Coalesced. Never throws. */
export function clearServerTotals(serverId: string): void {
  try {
    if (disabled || !deps.enabled()) return;
    const sub = subdomainOfServer(serverId);
    if (sub) enqueue(sub, null);
  } catch (e) {
    console.warn("[badge] clear skipped:", e);
  }
}

/** Same, by server URL (the entry may already be gone from the store). */
export function clearServerTotalsForUrl(url: string | null | undefined): void {
  try {
    if (disabled || !deps.enabled()) return;
    const sub = subdomainOfServerUrl(url);
    if (sub) enqueue(sub, null);
  } catch (e) {
    console.warn("[badge] clear skipped:", e);
  }
}

/** Send what is queued now (the timer calls this). Concurrent calls share
 *  one run. Never throws. */
export function flushBadgeTotals(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (!pending.size) return;
      if (!(await badgeTotalsSupported())) {
        disabled = true;
        pending.clear();
        return;
      }
      while (pending.size && !disabled) {
        const [sub, value] = pending.entries().next().value as [
          string,
          { unread: number; waiting?: number } | null,
        ];
        pending.delete(sub);
        let res: SumResult;
        try {
          res = value
            ? await deps.call<SumResult>("set_server_totals", { subdomain: sub, ...value })
            : await deps.call<SumResult>("clear_server_totals", { subdomain: sub });
        } catch (e) {
          // Plugin error: drop it; the next frame / list load sends again.
          console.warn("[badge] totals call failed:", e);
          continue;
        }
        if (res && res.available === false) {
          disabled = true;
          pending.clear();
          if (res.reason) console.info("[badge] badge totals off:", res.reason);
        }
      }
    } catch (e) {
      console.warn("[badge] flush skipped:", e);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** The native store and its sum; null when unsupported or on error. */
export async function getBadgeTotals(): Promise<BadgeTotals | null> {
  try {
    if (!(await badgeTotalsSupported())) return null;
    const t = await deps.call<BadgeTotals>("get_badge_totals");
    return t?.available ? t : null;
  } catch {
    return null;
  }
}

/** Received-push counters (delivery diagnostics); null when unsupported. */
export async function getBadgeDiagnostics(): Promise<BadgeDiagnostics | null> {
  try {
    if (!(await badgeTotalsSupported())) return null;
    const d = await deps.call<BadgeDiagnostics>("get_badge_diagnostics");
    return d?.available ? d : null;
  } catch {
    return null;
  }
}

/** Local `YYYY-MM-DD` (the native side keys days the same way). */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type BadgeDiagnosticsSummary = {
  today: { silent: number; alert: number };
  week: { silent: number; alert: number };
  /** Epoch ms of the newest received push within the kept days, or null. */
  lastAt: number | null;
};

/** One server's counts: today, the last 7 local days (today included),
 *  and the last-received time. Pure. */
export function summarizeBadgeDiagnostics(
  diag: Pick<BadgeDiagnostics, "days"> | null | undefined,
  subdomain: string,
  now: Date = new Date()
): BadgeDiagnosticsSummary {
  const out: BadgeDiagnosticsSummary = {
    today: { silent: 0, alert: 0 },
    week: { silent: 0, alert: 0 },
    lastAt: null,
  };
  const days = diag?.days ?? {};
  const sub = subdomain.toLowerCase();
  const todayKey = localDayKey(now);
  const week = new Set<string>();
  for (let i = 0; i < 7; i++) {
    week.add(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  for (const [day, servers] of Object.entries(days)) {
    const c = servers?.[sub];
    if (!c) continue;
    const silent = count(c.silent) ?? 0;
    const alert = count(c.alert) ?? 0;
    if (day === todayKey) out.today = { silent, alert };
    if (week.has(day)) {
      out.week.silent += silent;
      out.week.alert += alert;
    }
    const at = count(c.lastAt);
    if (at !== null && (out.lastAt === null || at > out.lastAt)) out.lastAt = at;
  }
  return out;
}

/** Subscribe to the plugin's `badgeTotals` event (a silent badge push, or
 *  an alert push while the app is open). Resolves to the remover; a no-op
 *  remover when unsupported. Never throws. */
export async function onBadgeTotals(cb: (e: BadgeTotalsEvent) => void): Promise<() => void> {
  try {
    if (!(await badgeTotalsSupported())) return () => {};
    const l = await deps.listen("badgeTotals", (raw) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      const subdomain = typeof p.subdomain === "string" ? p.subdomain.toLowerCase() : "";
      const unread = count(p.unread);
      if (!subdomain || unread === null) return;
      const server = deps.servers().find((s) => subdomainOfServerUrl(s.url) === subdomain);
      try {
        cb({
          subdomain,
          unread,
          waiting: count(p.waiting),
          sum: count(p.sum) ?? 0,
          serverId: server?.id ?? null,
        });
      } catch (e) {
        console.warn("[badge] listener failed:", e);
      }
    });
    return () => void Promise.resolve(l.unregister()).catch(() => {});
  } catch {
    return () => {};
  }
}

/** After a server is forgotten (removed, or its address now points at a
 *  different host): clear every stored subdomain no saved server uses. */
async function clearForgotten(): Promise<void> {
  const t = await getBadgeTotals();
  if (!t) return;
  const live = new Set(deps.servers().map((s) => subdomainOfServerUrl(s.url)));
  for (const sub of Object.keys(t.servers ?? {})) {
    if (!live.has(sub)) enqueue(sub, null);
  }
}

/** Clear totals when a server is signed out of or removed. Idempotent;
 *  returns the remover. Mounted once by <PushBridge/>. */
export function installBadgeServerHooks(): () => void {
  if (hooksInstalled) return hooksInstalled;
  const offLeave = deps.onLeave((server) => clearServerTotalsForUrl(server.url));
  const offForget = deps.onForget(() => {
    if (disabled || !deps.enabled()) return;
    void clearForgotten().catch(() => {});
  });
  const off = () => {
    offLeave();
    offForget();
    if (hooksInstalled === off) hooksInstalled = null;
  };
  hooksInstalled = off;
  return off;
}

/** Tests only: swap the platform edges and forget all state. */
export function __setBadgeTotalsDepsForTests(next: Partial<Deps> | null): void {
  if (timer) clearTimeout(timer);
  timer = null;
  flushing = null;
  disabled = false;
  pending.clear();
  hooksInstalled?.();
  hooksInstalled = null;
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

/** Tests only: what is waiting for the next flush. */
export function __pendingBadgeTotalsForTests(): Record<string, { unread: number; waiting?: number } | null> {
  return Object.fromEntries(pending);
}
