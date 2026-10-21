// ServerScope — which saved server a request, socket, cache or memory
// belongs to (multi-server PRD MS4, amended by MA2 and MA28).
//
// Desktop K2 has the same idea in `kessel/server-scope.ts`
// (`scopeForHost`, memoised per hostKey). The phone keys by the saved
// server's stable `id` instead (MA2): the id survives an address edit, and
// every per-server thing the phone already persists (tokens, recovery,
// focus pick, group cursors, revive backoff) is keyed by it.
//
//   - `scopeFor(serverId)` — one specific saved server, memoised per id. It
//     never follows a server switch. `httpBase()`, `wsBase()` and `token()`
//     read the saved entry ON EVERY CALL, so a re-sign-in is picked up. A
//     removed server throws `ServerRemovedError` LAZILY, on its next call
//     (desktop parity), so a room holding the scope fails closed instead of
//     falling back to another server.
//   - `activeScope()` — the compatibility shim: `scopeFor(activeServerId)`
//     resolved at call time, for classic pages and the active-server
//     stores. Capture it ONCE per operation; never re-read it for a retry.
//
// Feature memory (MS31, MA15): what each server's `/boot-status` said —
// `version`, `features[]`, `instanceId` — keyed by server id. Gates read
// `scope.supports(feature)`, never a version string; an unknown server
// supports nothing (desktop rule).

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  hostLabel,
  onServerForget,
  serverHostKey,
  useServersStore,
  type ServerEntry,
} from "../stores/servers";
import { isConnectionLevelError } from "../lib/netRetry";
import { isPossibleAuthFailure, reviveServerSession } from "../lib/revive";
import { scopedFetch } from "./scopedFetch";
import { tryHostKey } from "../lib/hostKey";

/** Every key the daemon reports in `/boot-status` `features` (K2 0.45.5,
 *  `boot_status.rs` `features()`). Phone consumers today:
 *    - `daemon-activity` — `GET /cli/activity/snapshot` + `thread/activity`
 *      (client.ts activity routes; absent → never asked);
 *    - `spawn-attach-only`, `thread-latest`, `tickets-list-all`,
 *      `thread-address-stable` — read by S2/S3 (rooms, pool, Tickets);
 *    - the `zen-*`, `thread-widget-origin` and `home-avatars-v1` keys gate
 *      desktop-only surfaces; listed so the memory is complete. */
export const DAEMON_FEATURES = [
  "spawn-attach-only",
  "tickets-list-all",
  "zen-v1",
  "zen-gardens-v1",
  "zen-chrome-v1",
  "zen-widgets-v1",
  "zen-lib-v1",
  "zen-sync-v1",
  "thread-latest",
  "thread-widget-origin",
  "home-avatars-v1",
  "daemon-activity",
  "thread-address-stable",
  // K2 0.45.5: Thread push prefs routes + payload (`notify/prefs`,
  // viewing frames). Read by push registration and the bells.
  "thread-push-v1",
  // K2 0.46.1: register-device takes `previews` / `environment`. Read by
  // push registration (lib/push `registrationBody`) and Server settings.
  "push-previews-v1",
  "push-environment-v1",
  // K2 0.46.1: unread counts, read cursors and mutes (`thread/unread`,
  // `thread/read`, `project-group/read`, `thread/mute`, read frames).
  // Read by `zen/unreadStore`; absent → no dots, no badge share.
  "thread-read-v1",
  // K2 0.46.1: Homes sync through one server the person picks
  // (`/cli/me/homes*`, `homes_changed` frames, `serverId` in boot-status).
  // Read by the Homes sync engine and Server settings.
  "homes-sync-v1",
  // K2 0.46.1: files on Thread messages (`doc.attachments`,
  // `GET /cli/thread/attachment`, `attachmentCount` on thread/latest).
  // Read by the Thread's file chips; absent → no chips.
  "thread-attachments-v1",
  // K2 0.46.1: delta reads — `after_seq=N` on `GET /cli/thread` and the
  // project chat messages route (items / changed / removed). Read by
  // `api/threadDelta` (chat open and prefetch); absent → newest-page reads.
  "thread-delta-v1",
  // K2 0.46.2: older pages of a project chat — `before_seq=N` on
  // `GET /cli/project-group/messages`. Read by the store's `loadEarlier`
  // and ThreadPane's lazy load; absent → a project chat grows from memory
  // only (an older daemon ignores `before_seq` and sends the newest page).
  "project-chat-paging-v1",
  // K2 0.46.3: image thumbnails (`mode=thumb&px=256|512` on
  // `/cli/thread/attachment`). Read by the Thread's inline images
  // (ThreadImages); absent → images stay file chips.
  "thread-images-v1",
  // K2 0.46.3: one-call foreground catch-up (`POST /cli/thread/catchup`).
  "inbox-catchup-v1",
  // K2 0.46.3: boot-status views (Bearer → `full`).
  "boot-status-views-v1",
  // K2 0.46.3: catch-up's `unchanged` short-cut (`sinceRev` + `instanceId`).
  "catchup-unchanged-v1",
] as const;

export type DaemonFeature = (typeof DAEMON_FEATURES)[number];

/** The `/boot-status` key that gates project chat older pages. */
export const FEATURE_PROJECT_CHAT_PAGING = "project-chat-paging-v1" as const;

/** Does `scope`'s server page a project chat backward (`before_seq`)?
 *  Unknown / removed → false. Lives here (not in `projectGroups`) so the
 *  many tests that mock that module keep working. */
export function projectChatPagingSupported(scope: ServerScope): boolean {
  try {
    return scope.supports(FEATURE_PROJECT_CHAT_PAGING);
  } catch {
    return false;
  }
}

/** A scope's server is no longer saved. Never falls back to another one. */
export class ServerRemovedError extends Error {
  readonly serverId: string;
  constructor(serverId: string, label?: string) {
    super(`${label || "This server"} was removed from this phone`);
    this.name = "ServerRemovedError";
    this.serverId = serverId;
  }
}

export interface ServerScope {
  /** The saved server's id (`""` only for the no-server scope). */
  readonly id: string;
  /** Canonical host key right now (follows an address edit of this id). */
  readonly hostKey: string;
  /** Nickname, else the host. For copy and logs. */
  readonly label: string;
  /** `https://host[:port]` read from the saved entry now. `""` only on the
   *  no-server scope; throws `ServerRemovedError` for a removed server. */
  httpBase(): string;
  /** `wss://host[:port]` (or `ws://` for plain http). Same rules. */
  wsBase(): string;
  /** This server's session token now (`""` when signed out). Throws
   *  `ServerRemovedError` for a removed server. Tokens never cross servers. */
  token(): string;
  /** The username saved for this server (`""` when unknown / removed). */
  username(): string;
  /** Did this server's `/boot-status` list `feature`? Unknown → false. */
  supports(feature: DaemonFeature): boolean;
  /** This server's version from `/boot-status`, or null while unknown. */
  version(): string | null;
}

// ─── Boot-status memory (per server id) ───

export interface BootInfo {
  version: string | null;
  /** null = the body had no `features` (an older daemon: none). */
  features: ReadonlySet<string> | null;
  instanceId: string | null;
  phase: string | null;
  /** `airgap.enabled` (hide-UI only; the daemon refuses by itself). */
  airgap?: boolean;
  /** `standalone` | `bundled-app` | `unknown`, or null when absent. */
  installKind?: string | null;
  /** K2 0.46.1: the box's stable id (16 hex), the same on every client —
   *  unlike the host key ("local" on the laptop, "rosson.k2.dev" here).
   *  Null from an older daemon. */
  serverId?: string | null;
  /** K2 0.46.1: the box's public tunnel host (`rosson.k2.dev`), lowercase;
   *  null when absent. Optional; Homes sync maps it to `serverId`. */
  publicHost?: string | null;
  /** K2 0.46.3 (`boot-status-views-v1`): `full` | `compat` | `public`;
   *  null from an older daemon (which always answers in full). */
  view?: string | null;
  /** The protocol range the box speaks (`protocolMin` from 0.46.3). */
  protocol?: number | null;
  protocolMin?: number | null;
  at: number;
}

/** The `/boot-status` protocol this build speaks (K2 0.46.3 contract). */
export const PHONE_PROTOCOL = 1;

/** A `compat` / `public` body (K2 0.46.3): it leaves fields out because
 *  the caller holds no credential the box accepts, not because the box
 *  lacks them. Absent there means "unknown", never "unsupported". */
export function isPartialBootView(view: unknown): boolean {
  return view === "public" || view === "compat";
}

/** Does this box need a newer phone (or an older one)? False while the
 *  range is unknown. */
export function protocolOutOfRange(info: Pick<BootInfo, "protocol" | "protocolMin"> | null): boolean {
  if (!info) return false;
  const max = info.protocol;
  const min = info.protocolMin ?? (typeof max === "number" ? 1 : null);
  if (typeof max !== "number" || typeof min !== "number") return false;
  return PHONE_PROTOCOL < min || PHONE_PROTOCOL > max;
}

const bootInfo = new Map<string, BootInfo>();

/** A box id as `/boot-status` spells it: 16 hex characters (lowercased). */
export function parseBoxServerId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(t) ? t : null;
}

/** `publicHost` in host-key form (`rosson.k2.dev`); null when absent or
 *  not a host. */
export function parsePublicHost(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? tryHostKey(v) : null;
}

type BootListener = (savedServerId: string, info: BootInfo) => void;
const bootListeners = new Set<BootListener>();

/** Hear every recorded `/boot-status` (Homes sync learns `serverId`). */
export function onBootInfo(fn: BootListener): () => void {
  bootListeners.add(fn);
  return () => {
    bootListeners.delete(fn);
  };
}

/** Record what a server's `/boot-status` said (the S2 pool calls this on
 *  every check; `ensureBootStatus` does in S1). */
export function noteBootStatus(serverId: string, body: unknown): BootInfo {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const view = typeof b.view === "string" && b.view ? b.view : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const parsed: BootInfo = {
    version: typeof b.version === "string" && b.version ? b.version : null,
    features: Array.isArray(b.features)
      ? new Set(b.features.filter((f): f is string => typeof f === "string"))
      : null,
    instanceId: typeof b.instanceId === "string" ? b.instanceId : null,
    phase: typeof b.phase === "string" ? b.phase : null,
    airgap:
      !!b.airgap &&
      typeof b.airgap === "object" &&
      (b.airgap as Record<string, unknown>).enabled === true,
    installKind: typeof b.installKind === "string" ? b.installKind : null,
    serverId: parseBoxServerId(b.serverId),
    publicHost: parsePublicHost(b.publicHost),
    view,
    protocol: num(b.protocol),
    protocolMin: num(b.protocolMin),
    at: Date.now(),
  };
  // K2 0.46.3: a stranger's view (no credential, or one the box no longer
  // accepts) omits fields. Update only what it carries; keep the rest.
  const prev = isPartialBootView(view) ? bootInfo.get(serverId) : undefined;
  const info: BootInfo = { ...parsed };
  if (isPartialBootView(view)) {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    if (!has("version")) info.version = prev?.version ?? null;
    if (!has("features")) info.features = prev?.features ?? null;
    if (!has("airgap")) info.airgap = prev?.airgap ?? false;
    if (!has("installKind")) info.installKind = prev?.installKind ?? null;
    if (!has("serverId")) info.serverId = prev?.serverId ?? null;
    if (!has("publicHost")) info.publicHost = prev?.publicHost ?? null;
  }
  bootInfo.set(serverId, info);
  for (const fn of [...bootListeners]) {
    try {
      fn(serverId, info);
    } catch {
      /* a listener never breaks the memory */
    }
  }
  return info;
}

export function bootInfoFor(serverId: string): BootInfo | null {
  return bootInfo.get(serverId) ?? null;
}

// ─── Scopes ───

function savedEntry(serverId: string): ServerEntry | null {
  return useServersStore.getState().servers.find((s) => s.id === serverId) ?? null;
}

function makeScope(serverId: string): ServerScope {
  let lastHostKey = "";
  let lastLabel = "";
  const entry = (): ServerEntry => {
    const e = savedEntry(serverId);
    if (!e) throw new ServerRemovedError(serverId, lastLabel);
    lastHostKey = serverHostKey(e);
    lastLabel = e.nickname || hostLabel(e.url);
    return e;
  };
  return {
    id: serverId,
    get hostKey(): string {
      const e = savedEntry(serverId);
      if (e) lastHostKey = serverHostKey(e);
      return lastHostKey;
    },
    get label(): string {
      const e = savedEntry(serverId);
      if (e) lastLabel = e.nickname || hostLabel(e.url);
      return lastLabel || serverId;
    },
    httpBase(): string {
      return entry().url.replace(/\/+$/, "");
    },
    wsBase(): string {
      return entry().url.replace(/\/+$/, "").replace(/^http/i, "ws");
    },
    token(): string {
      entry();
      return useServersStore.getState().tokens[serverId] ?? "";
    },
    username(): string {
      return savedEntry(serverId)?.username ?? "";
    },
    supports(feature: DaemonFeature): boolean {
      return bootInfo.get(serverId)?.features?.has(feature) ?? false;
    },
    version(): string | null {
      return bootInfo.get(serverId)?.version ?? null;
    },
  };
}

/** The scope used when no server is saved / active: every base is `""`
 *  (callers answer "Not connected"), no token, no features. */
export const NO_SERVER_SCOPE: ServerScope = {
  id: "",
  hostKey: "",
  label: "",
  httpBase: () => "",
  wsBase: () => "",
  token: () => "",
  username: () => "",
  supports: () => false,
  version: () => null,
};

const scopes = new Map<string, ServerScope>();

/** The scope pinned to one saved server. Same object per id. */
export function scopeFor(serverId: string | null | undefined): ServerScope {
  if (!serverId) return NO_SERVER_SCOPE;
  let scope = scopes.get(serverId);
  if (!scope) {
    scope = makeScope(serverId);
    scopes.set(serverId, scope);
  }
  return scope;
}

/** Compatibility shim (MS5): the active server's scope, resolved NOW. For
 *  classic pages and the active-server stores. Capture once per call. */
export function activeScope(): ServerScope {
  const s = useServersStore.getState();
  return scopeFor(s.servers.find((x) => x.id === s.activeServerId)?.id);
}

/** `<serverId>|<key>` — the per-server storage / memory key (MS8 as
 *  amended by MA2). A path or id alone is never an identity across servers. */
export function scopedKey(scope: Pick<ServerScope, "id">, key: string): string {
  return `${scope.id}|${key}`;
}

// ─── Per-server module memory ───

/** A module-level memory with one slot per server id (MA6). The slot is
 *  dropped automatically when that server is removed or re-keyed (MS3). */
export interface ServerMemory<T> {
  get(serverId: string): T;
  peek(serverId: string): T | undefined;
  delete(serverId: string): void;
  clear(): void;
}

export function serverMemory<T>(init: () => T): ServerMemory<T> {
  const slots = new Map<string, T>();
  onServerForget((id) => slots.delete(id));
  return {
    get(serverId) {
      let v = slots.get(serverId);
      if (v === undefined) {
        v = init();
        slots.set(serverId, v);
      }
      return v;
    },
    peek: (serverId) => slots.get(serverId),
    delete: (serverId) => void slots.delete(serverId),
    clear: () => slots.clear(),
  };
}

// ─── /boot-status ───

const BOOT_TIMEOUT_MS = 4000;
/** Re-read at most this often from `ensureBootStatus` (the S2 pool owns
 *  the real cadence). */
export const BOOT_STATUS_MAX_AGE_MS = 5 * 60_000;

const bootInflight = new Map<string, Promise<BootInfo | null>>();

/** The scope's token, or "" (signed out, removed). */
function tokenOf(scope: ServerScope): string {
  try {
    return scope.token();
  } catch {
    return "";
  }
}

/** K2 0.46.3: re-check a login at most this often per server when the
 *  box answered a token-bearing `/boot-status` with a stranger's view. */
export const BOOT_STALE_RECHECK_MS = 5 * 60_000;
const staleRecheckAt = new Map<string, number>();

/** Per server, the token whose stranger's view is EXPLAINED: whoami said
 *  `mustChangePassword` (K2 0.46.3 answers such a session compat until the
 *  password changes). No re-checks for it; a new token (sign-in, password
 *  change) or a `full` answer ends it. */
const mustChangeToken = new Map<string, string>();

/** Token sent, `view` not `full`: the box may no longer accept this login
 *  (e.g. sessions wiped by a restart). One whoami (never "offline"):
 *    - `mustChangePassword: true` → explained; the pool's change-password
 *      row stays, no more re-checks for this token;
 *    - a stale-session rejection → the re-login path (revive, background:
 *      whoami twice; a dead token is kept and the server marked
 *      signin-required, MA22);
 *    - anything else → nothing until the next window. */
function noteStaleSession(serverId: string, token: string): void {
  if (mustChangeToken.get(serverId) === token) return;
  const now = Date.now();
  const last = staleRecheckAt.get(serverId);
  if (last !== undefined && now - last < BOOT_STALE_RECHECK_MS) return;
  if (useServersStore.getState().recovery[serverId] === "signin-required") return;
  staleRecheckAt.set(serverId, now);
  void (async () => {
    const res = await scopedFetch(scopeFor(serverId), "/cli/auth/whoami", {
      revive: false,
      timeoutMs: BOOT_WHOAMI_TIMEOUT_MS,
    });
    if (isPossibleAuthFailure(res.status, res.text)) {
      await reviveServerSession(serverId, { background: true });
      return;
    }
    if (!res.ok) return;
    let body: unknown = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      return;
    }
    if (body && typeof body === "object" && (body as Record<string, unknown>).mustChangePassword === true) {
      mustChangeToken.set(serverId, token);
    }
  })().catch(() => {});
}

const BOOT_WHOAMI_TIMEOUT_MS = 8000;

/** Tests: forget the stale-login re-check throttle. */
export function __resetBootStaleForTests(): void {
  staleRecheckAt.clear();
  mustChangeToken.clear();
}

/** `GET /boot-status`. K2 0.46.3: with the server's token as Bearer when
 *  one is held (the box answers its `full` view), retried once without it
 *  on a 401/403 (≤0.46.2 with a must-change-password session). */
async function getBootStatus(base: string, token = "", serverId = ""): Promise<unknown | null> {
  const fetchOnce = (bearer: string) =>
    Promise.race([
      tauriFetch(
        `${base}/boot-status`,
        bearer ? { method: "GET", headers: { Authorization: `Bearer ${bearer}` } } : { method: "GET" }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("boot-status timed out")), BOOT_TIMEOUT_MS)
      ),
    ]);
  const once = async () => {
    let res = await fetchOnce(token);
    let sent = !!token;
    if (sent && (res.status === 401 || res.status === 403)) {
      res = await fetchOnce("");
      sent = false;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const view =
      body && typeof body === "object" ? (body as Record<string, unknown>).view : undefined;
    if (sent && serverId && typeof view === "string") {
      if (view !== "full") noteStaleSession(serverId, token);
      else mustChangeToken.delete(serverId);
    }
    return body;
  };
  try {
    return await once();
  } catch (err) {
    // MA11: one immediate retry on a connection error only (a timeout is
    // not retried).
    if (!isConnectionLevelError(err)) return null;
    try {
      return await once();
    } catch {
      return null;
    }
  }
}

/** The raw `GET /boot-status` body on `scope` (Bearer when a token is
 *  held; 4 s, one retry on a network error only), or null when
 *  unreachable / non-2xx / removed. NOT recorded: the S2 pool reads it to tell offline from live
 *  (`refreshBootStatus` keeps the last good answer on a failure). */
export async function readBootStatus(scope: ServerScope): Promise<unknown | null> {
  if (!scope.id) return null;
  let base: string;
  try {
    base = scope.httpBase();
  } catch {
    return null;
  }
  if (!base) return null;
  return getBootStatus(base, tokenOf(scope), scope.id);
}

/** `GET /boot-status` on `scope` (Bearer when held; 4 s, one retry on a
 *  network error), recorded in the feature memory. Single-flight per server. A
 *  failure keeps what was known. */
export function refreshBootStatus(scope: ServerScope): Promise<BootInfo | null> {
  if (!scope.id) return Promise.resolve(null);
  const running = bootInflight.get(scope.id);
  if (running) return running;
  const p = (async () => {
    let base: string;
    try {
      base = scope.httpBase();
    } catch {
      return null;
    }
    if (!base) return null;
    const body = await getBootStatus(base, tokenOf(scope), scope.id);
    if (body === null) return bootInfo.get(scope.id) ?? null;
    // The server may have been removed or re-keyed while we waited.
    if (!savedEntry(scope.id)) return null;
    return noteBootStatus(scope.id, body);
  })().finally(() => bootInflight.delete(scope.id));
  bootInflight.set(scope.id, p);
  return p;
}

/** The known boot info when fresh, else one `refreshBootStatus`. */
export function ensureBootStatus(
  scope: ServerScope,
  maxAgeMs = BOOT_STATUS_MAX_AGE_MS
): Promise<BootInfo | null> {
  const known = bootInfo.get(scope.id);
  if (known && Date.now() - known.at < maxAgeMs) return Promise.resolve(known);
  return refreshBootStatus(scope);
}

// ─── Version compare (verb rules, MA15) ───

/** `a >= b` for dotted versions (`0.44.4`, `v0.45.3-dev`). Unparseable → false. */
export function versionAtLeast(a: string | null, b: string): boolean {
  if (!a) return false;
  const parse = (v: string) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

onServerForget((id, reason) => {
  bootInfo.delete(id);
  bootInflight.delete(id);
  staleRecheckAt.delete(id);
  mustChangeToken.delete(id);
  if (reason === "removed") scopes.delete(id);
});

/** Tests only. */
export function __resetScopesForTests(): void {
  scopes.clear();
  bootInfo.clear();
  staleRecheckAt.clear();
  mustChangeToken.clear();
  bootInflight.clear();
}
