// The per-server connection pool (multi-server S2: MS10–MS14 as amended by
// MA11 and MA22). A port of desktop K2's `lib/host-pool.ts`, keyed by the
// saved server's id (MA2) instead of the host key.
//
// One entry per saved server. A status check is single-flight per server:
//   1. `GET /boot-status` (public; 4 s, one retry on a network error only)
//      → reach live / starting / offline, version, features, `instanceId`.
//      A changed `instanceId` means that server restarted: only ITS
//      `onRestart` listeners run (MS13).
//   2. live and a token is held → `GET /cli/auth/whoami` (5 s) → role,
//      username, `mustChangePassword` → `rotate-required`.
//   3. login ok → `GET /cli/presence/summary` (5 s) → presence,
//      `agentActivity` and `activeProjectIds`. Any failure other than
//      401 / 403-token-gate reads as Live with no dots.
//
// A 503 `{"state":"migrating"}` from either read means the daemon is still
// starting. The pool keeps the phone's Bearer header (scopedFetch), never
// revives, never deletes a token and never switches the active server:
// background failures only change this in-memory state (MA22, MS33).
//
// The phone has no auto-login (NG5): there is no `signing-in` auth state
// here and no login lease. `signing-in` is shown only while a sign-in sheet
// the user opened is up (rowStatus.ts, MA10).

import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import {
  noteBootStatus,
  readBootStatus,
  scopeFor,
  ServerRemovedError,
  type ServerScope,
} from "../../api/scope";
import { scopedFetch, type RawResponse } from "../../api/scopedFetch";
import { isPossibleAuthFailure, noteServerAccepted } from "../../lib/revive";
import { onServerSignal } from "../../api/serverSignals";
import { onServerForget } from "../../stores/servers";
import type { ActivityDisplay } from "../agentActivity";

export type PoolReach = "unknown" | "live" | "starting" | "offline";
export type PoolAuth = "ok" | "signin-required" | "rotate-required" | "kicked";

export interface PoolBoot {
  phase: string | null;
  /** `phase === "ready"` (MA11: the daemon sends no `ready` field; a
   *  `ready === true` body is accepted for shape-tolerance only). */
  ready: boolean;
  version: string | null;
  protocol: number | null;
  instanceId: string | null;
  /** `/boot-status` `features`; `[]` from an older daemon. */
  features: string[];
  at: number;
}

/** One row of the summary's `workspaces[]`. */
export interface PresenceWorkspace {
  workspaceId: string | null;
  handle: string | null;
  name: string | null;
  path: string;
  count: number;
  people: { user: string; name: string; role: string }[];
}

/** One row of the summary's `agentActivity[]`: a workspace on that server
 *  with a non-idle agent. No counts (MA12). */
export interface PresenceActivity {
  workspaceId: string;
  status: "working" | "permission";
  display?: ActivityDisplay;
}

export interface PoolEntry {
  serverId: string;
  hostKey: string;
  reach: PoolReach;
  boot: PoolBoot | null;
  auth: PoolAuth;
  /** Extra copy for the auth state ("Box B needs a new password."). */
  authNote: string | null;
  /** whoami `role`. Null = not read (an older server): allowed (MA10). */
  role: string | null;
  /** whoami `username`. */
  username: string | null;
  presence: PresenceWorkspace[] | null;
  /** The summary's `agentActivity`; null when unread or pre-0.43.2. */
  activity: PresenceActivity[] | null;
  activeProjectIds: string[] | null;
  /** Offline checks in a row, for the 5 s / 15 s / 30 s backoff. */
  offlineStreak: number;
  checkedAt: number | null;
  /** When the loop will check this server next (for "retrying in N s"). */
  nextAt: number | null;
}

// ─── Pure helpers (desktop parity) ───

/** Timeouts (MA11). */
export const BOOT_TIMEOUT_MS = 4_000;
export const LOGIN_TIMEOUT_MS = 5_000;

/** `/boot-status` says ready. */
export function bootIsReady(b: { phase?: unknown; ready?: unknown } | null | undefined): boolean {
  if (!b) return false;
  return b.phase === "ready" || b.ready === true;
}

/** Roles that may open an agent there (MS83). Null = not read: allowed. */
export function roleAllowsRoom(role: string | null): boolean {
  if (role === null) return true;
  return role === "owner" || role === "admin" || role === "member";
}

/** The check cadence (MS12): offline 5 s, 15 s, then 30 s; else 30 s. */
export function nextCheckDelayMs(
  entry: Pick<PoolEntry, "reach" | "offlineStreak"> | undefined | null
): number {
  if (!entry || entry.reach !== "offline") return 30_000;
  if (entry.offlineStreak <= 1) return 5_000;
  if (entry.offlineStreak === 2) return 15_000;
  return 30_000;
}

const DISPLAYS: ReadonlySet<string> = new Set([
  "working",
  "monitoring",
  "waiting",
  "unverifiable",
  "idle",
]);

/** The summary's `agentActivity`, keeping only rows the phone understands.
 *  Absent → null. A `display` the daemon sends is kept when known. */
export function parsePresenceActivity(raw: unknown): PresenceActivity[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PresenceActivity[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { workspaceId, status, display } = r as {
      workspaceId?: unknown;
      status?: unknown;
      display?: unknown;
    };
    if (typeof workspaceId !== "string" || workspaceId.length === 0) continue;
    const real =
      typeof display === "string" && DISPLAYS.has(display) ? (display as ActivityDisplay) : null;
    if (real) {
      out.push({
        workspaceId,
        status: status === "permission" ? "permission" : "working",
        display: real,
      });
      continue;
    }
    if (status !== "working" && status !== "permission") continue;
    out.push({ workspaceId, status });
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parseBoot(body: unknown, at: number): PoolBoot {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    phase: str(b.phase),
    ready: bootIsReady(b),
    version: str(b.version),
    protocol: typeof b.protocol === "number" ? b.protocol : null,
    instanceId: str(b.instanceId),
    features: Array.isArray(b.features)
      ? b.features.filter((f): f is string => typeof f === "string")
      : [],
    at,
  };
}

export function blankEntry(serverId: string, hostKey: string): PoolEntry {
  return {
    serverId,
    hostKey,
    reach: "unknown",
    boot: null,
    auth: "signin-required",
    authNote: null,
    role: null,
    username: null,
    presence: null,
    activity: null,
    activeProjectIds: null,
    offlineStreak: 0,
    checkedAt: null,
    nextAt: null,
  };
}

/** What one read of whoami or the summary said. */
export type LoginRead =
  | { kind: "ok"; body: unknown }
  /** 401, or 403 with the token-gate body (never `role_required`). */
  | { kind: "dead" }
  /** 503 `{"state":"migrating"}`: the daemon is still starting. */
  | { kind: "migrating" }
  /** Anything else: network error, timeout, other status. */
  | { kind: "failed"; status?: number };

/** Classify one whoami / summary response (MA11, MA22). */
export function classifyLoginRead(res: RawResponse | null): LoginRead {
  if (!res) return { kind: "failed" };
  if (isPossibleAuthFailure(res.status, res.text)) return { kind: "dead" };
  if (res.status === 503 && /"state"\s*:\s*"migrating"/.test(res.text)) return { kind: "migrating" };
  if (!res.ok) return { kind: "failed", status: res.status };
  try {
    return { kind: "ok", body: res.text ? (JSON.parse(res.text) as unknown) : {} };
  } catch {
    return { kind: "ok", body: {} };
  }
}

/** The pool's state machine, one event at a time. Pure. */
export type PoolEvent =
  | { type: "boot"; body: unknown | null; at: number }
  | { type: "no-token" }
  | { type: "whoami"; read: LoginRead; serverLabel: string }
  | { type: "summary"; read: LoginRead; whoamiAlive: boolean }
  | { type: "kicked"; serverLabel: string }
  /** A socket's whoami said the login is dead (MA14/MA22). */
  | { type: "signin"; serverLabel: string }
  | { type: "scheduled"; nextAt: number | null };

export function reducePool(prev: PoolEntry, ev: PoolEvent): PoolEntry {
  switch (ev.type) {
    case "boot": {
      if (ev.body === null) {
        return { ...prev, reach: "offline", offlineStreak: prev.offlineStreak + 1, checkedAt: ev.at };
      }
      const boot = parseBoot(ev.body, ev.at);
      return {
        ...prev,
        boot,
        reach: boot.ready ? "live" : "starting",
        offlineStreak: 0,
        checkedAt: ev.at,
      };
    }
    case "no-token":
      return { ...prev, auth: "signin-required", authNote: null, ...noPresence() };
    case "whoami": {
      const r = ev.read;
      if (r.kind === "dead") return { ...prev, auth: "signin-required", authNote: null, ...noPresence() };
      if (r.kind === "migrating") return { ...prev, reach: "starting" };
      if (r.kind !== "ok") return prev;
      const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
      const role = str(b.role);
      const username = str(b.username);
      if (b.mustChangePassword === true) {
        return {
          ...prev,
          auth: "rotate-required",
          authNote: `${ev.serverLabel} needs a new password.`,
          role,
          username,
          ...noPresence(),
        };
      }
      return { ...prev, role, username };
    }
    case "summary": {
      const r = ev.read;
      if (r.kind === "dead") return { ...prev, auth: "signin-required", authNote: null, ...noPresence() };
      if (r.kind === "migrating") return { ...prev, reach: "starting" };
      if (r.kind === "failed") {
        // MA11: the login stands if whoami said so; Live with no dots.
        return ev.whoamiAlive
          ? { ...prev, auth: "ok", authNote: null, ...noPresence() }
          : { ...prev, ...noPresence() };
      }
      const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
      return {
        ...prev,
        auth: "ok",
        authNote: null,
        presence: Array.isArray(b.workspaces) ? (b.workspaces as PresenceWorkspace[]) : null,
        activity: parsePresenceActivity(b.agentActivity),
        activeProjectIds: Array.isArray(b.activeProjectIds)
          ? b.activeProjectIds.filter((id): id is string => typeof id === "string")
          : null,
      };
    }
    case "kicked":
      return {
        ...prev,
        auth: "kicked",
        authNote: `Removed from ${ev.serverLabel}. Sign in again.`,
        ...noPresence(),
      };
    case "signin":
      if (prev.auth === "kicked") return prev; // kicked is the stronger word
      return { ...prev, auth: "signin-required", authNote: null, ...noPresence() };
    case "scheduled":
      return { ...prev, nextAt: ev.nextAt };
  }
}

function noPresence(): Pick<PoolEntry, "presence" | "activity" | "activeProjectIds"> {
  return { presence: null, activity: null, activeProjectIds: null };
}

/** Did this boot answer come from a restarted daemon (MS13)? */
export function restartedBetween(prev: PoolBoot | null, next: PoolBoot | null): boolean {
  return !!prev?.instanceId && !!next?.instanceId && prev.instanceId !== next.instanceId;
}

// ─── The pool ───

export interface PoolDeps {
  scopeOf: (serverId: string) => ServerScope;
  /** Raw `/boot-status` body, or null when unreachable. */
  bootStatus: (scope: ServerScope) => Promise<unknown | null>;
  /** One authed GET on `scope`. Throws on a network error / timeout. */
  get: (scope: ServerScope, path: string, timeoutMs: number) => Promise<RawResponse>;
  /** Record what `/boot-status` said in the per-server feature memory. */
  noteBoot: (serverId: string, body: unknown) => void;
  /** MS29: the server was reached and its login accepted. */
  onAccepted?: (serverId: string) => void;
  now: () => number;
}

export type RestartListener = (serverId: string, prevInstanceId: string, nextInstanceId: string) => void;

export interface Pool {
  readonly store: StoreApi<{ entries: Record<string, PoolEntry> }>;
  entry(serverId: string): PoolEntry | undefined;
  /** The status check. `bootOnly` skips the login half (the active
   *  server, which keeps today's paths). Never throws. Single-flight. */
  check(serverId: string, opts?: { bootOnly?: boolean }): Promise<PoolEntry | undefined>;
  /** Record when the loop checks next (the "retrying in N s" copy). */
  schedule(serverId: string, nextAt: number | null): void;
  /** A sessions/events socket for this server closed 4001 (MA14). */
  noteKicked(serverId: string): void;
  /** A socket's whoami check said this server's login is dead. */
  noteSigninRequired(serverId: string): void;
  /** The server was removed or re-keyed: drop its entry. */
  forget(serverId: string): void;
  onRestart(fn: RestartListener): () => void;
}

export function createPool(deps: PoolDeps): Pool {
  const store = createStore<{ entries: Record<string, PoolEntry> }>(() => ({ entries: {} }));
  const inflight = new Map<string, Promise<PoolEntry | undefined>>();
  const restartListeners = new Set<RestartListener>();
  const forgotten = new Set<string>();

  const read = (id: string, hostKey: string): PoolEntry =>
    store.getState().entries[id] ?? blankEntry(id, hostKey);

  const write = (id: string, next: PoolEntry): PoolEntry => {
    if (forgotten.has(id)) return next;
    store.setState((s) => ({ entries: { ...s.entries, [id]: next } }));
    return next;
  };

  const apply = (id: string, hostKey: string, ev: PoolEvent): PoolEntry =>
    write(id, reducePool({ ...read(id, hostKey), hostKey }, ev));

  const loginGet = async (scope: ServerScope, path: string): Promise<LoginRead> => {
    try {
      return classifyLoginRead(await deps.get(scope, path, LOGIN_TIMEOUT_MS));
    } catch {
      return { kind: "failed" };
    }
  };

  const doCheck = async (id: string, bootOnly: boolean): Promise<PoolEntry | undefined> => {
    const scope = deps.scopeOf(id);
    let hostKey: string;
    let label: string;
    try {
      scope.httpBase();
      hostKey = scope.hostKey;
      label = scope.label;
    } catch (e) {
      if (e instanceof ServerRemovedError || (e as Error)?.name === "ServerRemovedError") {
        forget(id);
        return undefined;
      }
      throw e;
    }
    forgotten.delete(id);
    const prevBoot = read(id, hostKey).boot;
    const body = await deps.bootStatus(scope);
    const at = deps.now();
    if (body !== null) deps.noteBoot(id, body);
    let entry = apply(id, hostKey, { type: "boot", body, at });
    if (restartedBetween(prevBoot, entry.boot)) {
      for (const fn of [...restartListeners]) {
        fn(id, prevBoot!.instanceId!, entry.boot!.instanceId!);
      }
    }
    if (bootOnly || entry.reach !== "live") return entry;

    let token = "";
    try {
      token = scope.token();
    } catch {
      return entry;
    }
    if (!token) return apply(id, hostKey, { type: "no-token" });

    const who = await loginGet(scope, "/cli/auth/whoami");
    entry = apply(id, hostKey, { type: "whoami", read: who, serverLabel: label });
    if (who.kind === "dead" || who.kind === "migrating" || entry.auth === "rotate-required") {
      return entry;
    }
    const summary = await loginGet(scope, "/cli/presence/summary");
    entry = apply(id, hostKey, { type: "summary", read: summary, whoamiAlive: who.kind === "ok" });
    if (entry.auth === "ok") deps.onAccepted?.(id);
    return entry;
  };

  const noteAuth = (id: string, type: "kicked" | "signin") => {
    let label: string;
    let hostKey: string;
    try {
      const scope = deps.scopeOf(id);
      scope.httpBase(); // a removed server has nothing to note
      label = scope.label;
      hostKey = scope.hostKey;
    } catch {
      return;
    }
    forgotten.delete(id);
    const e = store.getState().entries[id] ?? blankEntry(id, hostKey);
    write(id, reducePool(e, { type, serverLabel: label }));
  };

  const forget = (id: string) => {
    forgotten.add(id);
    inflight.delete(id);
    store.setState((s) => {
      if (!(id in s.entries)) return s;
      const entries = { ...s.entries };
      delete entries[id];
      return { entries };
    });
  };

  return {
    store,
    entry: (id) => store.getState().entries[id],
    check(id, opts) {
      const running = inflight.get(id);
      if (running) return running;
      const p = doCheck(id, opts?.bootOnly === true)
        .catch(() => store.getState().entries[id])
        .finally(() => {
          if (inflight.get(id) === p) inflight.delete(id);
        });
      inflight.set(id, p);
      return p;
    },
    schedule(id, nextAt) {
      const e = store.getState().entries[id];
      if (e) write(id, reducePool(e, { type: "scheduled", nextAt }));
    },
    noteKicked(id) {
      noteAuth(id, "kicked");
    },
    noteSigninRequired(id) {
      noteAuth(id, "signin");
    },
    forget,
    onRestart(fn) {
      restartListeners.add(fn);
      return () => {
        restartListeners.delete(fn);
      };
    },
  };
}

/** The app's pool: real scopes, scopedFetch (Bearer, no revive). */
export const pool: Pool = createPool({
  scopeOf: (id) => scopeFor(id),
  bootStatus: (scope) => readBootStatus(scope),
  get: (scope, path, timeoutMs) => scopedFetch(scope, path, { timeoutMs, revive: false }),
  noteBoot: (id, body) => void noteBootStatus(id, body),
  onAccepted: (id) => noteServerAccepted(id),
  now: () => Date.now(),
});

onServerForget((id) => pool.forget(id));

// MA14: what the sockets learn reaches the pool (rows + room banner).
onServerSignal((id, signal) => {
  if (signal === "kicked") pool.noteKicked(id);
  else if (signal === "signin") pool.noteSigninRequired(id);
});

/** React view of the pool's entries. */
export function usePoolEntries(): Record<string, PoolEntry> {
  return useStore(pool.store, (s) => s.entries);
}
