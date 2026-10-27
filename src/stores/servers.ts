import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { withNetRetry } from "../lib/netRetry";
import {
  k2DevApexLabel,
  loginUrlFor,
  LOGIN_404_K2DEV_MESSAGE,
} from "../lib/loginUrl";
import { loginErrorFromStatus } from "../lib/loginError";
import { tryHostKey } from "../lib/hostKey";

// Multi-server model — the companion mirror of the desktop's
// `stores/connect-host.ts`. Each saved server is a K2 daemon reachable over
// K2 Connect (or localhost dev), with its own session token and its own
// recovery state. Exactly one server is ACTIVE; the API layer
// (`api/client.ts`) derives base URL + token from it.
//
// Persistence (tauri-plugin-store `servers.json`; localStorage fallback for
// plain-browser dev):
//   "servers"        → ServerEntry[]
//   "activeServerId" → string | null
//   "tokens"         → Record<serverId, sessionToken>
// OPEN 12: never write a `passwords` key. Hydrate deletes any leftover
// `passwords` map from older builds (Baden device `EC351036` is the
// positive control). Session survives via the token.
//
// One-time migration: the pre-v2 single session in plugin-store `auth.json`
// + the saved-server list in localStorage `k2_connections` fold into this
// model on first hydrate (the previously-signed-in server becomes active).

export type RecoveryState =
  | "connected"
  | "reconnecting"
  | "reauthenticating"
  | "signin-required";

export interface ServerEntry {
  id: string;
  nickname: string;
  /** Normalized origin, e.g. `https://foo.k2.dev` (no trailing slash). */
  url: string;
  username: string;
  /** Leftover flag from when remember-me stored a password. Always false now. */
  rememberPassword: boolean;
  /** Derived canonical host key (MS1/MS2, `lib/hostKey.ts`), recomputed on
   *  hydrate and on every save. For dedupe, addresses and display only:
   *  storage and caches key by `id` (MA2). Read it through
   *  `serverHostKey()`, which also covers an entry built without it. */
  hostKey?: string;
  /** How this phone holds its session (K2 0.46.4 `companion-pairing-v1`):
   *  `paired` = a device session from a pairing code, renewed by use and
   *  never by a password ("Pair again" when it ends); absent = a password
   *  sign-in. */
  auth?: "paired";
}

/** The phone is paired with this server (no password sign-in). */
export function isPairedServer(entry: Pick<ServerEntry, "auth"> | null | undefined): boolean {
  return entry?.auth === "paired";
}

// ─── URL / id helpers (pure) ───

/** Normalize user input into an origin: add https:// when no scheme was
 *  typed, strip trailing slashes. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/** Human label for an origin: the URL without its scheme. */
export function hostLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

/** The canonical host key of a saved server (MS1). An address that does not
 *  parse (never saved by this build) falls back to its lowercase origin, so
 *  it still dedupes against itself. */
export function serverHostKey(entry: Pick<ServerEntry, "url"> & { hostKey?: string }): string {
  return entry.hostKey || tryHostKey(entry.url) || entry.url.trim().toLowerCase();
}

/** `entry` with its derived `hostKey` (re)computed from `url`. */
export function withHostKey(entry: ServerEntry): ServerEntry {
  const hostKey = tryHostKey(entry.url) ?? entry.url.trim().toLowerCase();
  return entry.hostKey === hostKey ? entry : { ...entry, hostKey };
}

/** MS2: the saved server (other than `exceptId`) that already uses the
 *  host key of `url`, or null. Two saved entries for one server are
 *  refused on save. */
export function duplicateServer(
  servers: ServerEntry[],
  url: string,
  exceptId: string | null
): ServerEntry | null {
  const key = serverHostKey({ url: normalizeServerUrl(url) });
  return servers.find((s) => s.id !== exceptId && serverHostKey(s) === key) ?? null;
}

/** The refusal copy for a duplicate saved server. */
export function duplicateServerMessage(dup: Pick<ServerEntry, "nickname" | "url">): string {
  return `Already saved as ${dup.nickname || hostLabel(dup.url)}.`;
}

/** MS2, read side: the saved server for a host key. Entries saved before the
 *  duplicate rule may share a key; the one holding a token wins (desktop
 *  `savedHostForKey`). */
export function serverForHostKey(
  state: Pick<ServersState, "servers" | "tokens">,
  hostKey: string
): ServerEntry | null {
  const matches = state.servers.filter((s) => serverHostKey(s) === hostKey);
  if (matches.length === 0) return null;
  return matches.find((s) => (state.tokens[s.id] ?? "").length > 0) ?? matches[0];
}

// ─── Forget hooks (MS3 / MA2) ───
//
// Per-server memories elsewhere (scopes, route memories, identity, revive
// backoff, zen caches) key by server id. When a server is removed, or its
// address is edited to a DIFFERENT host key (it may be a different daemon),
// every one of them must drop that id's state. servers.ts imports nothing
// app-side, so they subscribe here instead of being imported.

export type ServerForgetReason = "removed" | "rekeyed";
type ForgetListener = (serverId: string, reason: ServerForgetReason) => void;
const forgetListeners = new Set<ForgetListener>();

/** Subscribe to "drop everything you hold for this server id". */
export function onServerForget(fn: ForgetListener): () => void {
  forgetListeners.add(fn);
  return () => forgetListeners.delete(fn);
}

function fireForget(serverId: string, reason: ServerForgetReason): void {
  for (const fn of forgetListeners) {
    try {
      fn(serverId, reason);
    } catch (e) {
      console.warn("[servers] forget listener failed", e);
    }
  }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}`;
}

// ─── Persistence backend (plugin-store with localStorage fallback) ───

export const PASSWORDS_STORE_KEY = "passwords";

interface Backend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const STORE_FILE = "servers.json";
const LS_PREFIX = "k2_servers.";

let backendPromise: Promise<Backend> | null = null;

function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = (async (): Promise<Backend> => {
      try {
        const store = await load(STORE_FILE, { defaults: {} });
        return {
          get: async <T>(key: string) => store.get<T>(key),
          set: async (key, value) => {
            await store.set(key, value);
            await store.save();
          },
          delete: async (key) => {
            await store.delete(key);
            await store.save();
          },
        };
      } catch {
        // Plain-browser dev (no tauri runtime) — localStorage keeps the
        // model usable so `npm run dev` still boots to /servers.
        return {
          get: async <T>(key: string) => {
            try {
              const raw = localStorage.getItem(LS_PREFIX + key);
              return raw ? (JSON.parse(raw) as T) : undefined;
            } catch {
              return undefined;
            }
          },
          set: async (key, value) => {
            try {
              localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
            } catch {
              /* quota / private mode — model stays in-memory */
            }
          },
          delete: async (key) => {
            try {
              localStorage.removeItem(LS_PREFIX + key);
            } catch {
              /* private mode */
            }
          },
        };
      }
    })();
  }
  return backendPromise;
}

/** OPEN 12 condition 2: drop a leftover `passwords` key. Empty `{}` still
 *  names the key; delete it. Called on every hydrate, login or not. */
export async function purgeStoredPasswords(
  backend: Pick<Backend, "delete">
): Promise<void> {
  await backend.delete(PASSWORDS_STORE_KEY);
}

/** Always null. The password is not on disk and not used after login. */
export async function resolvePassword(_serverId: string): Promise<string | null> {
  return null;
}

/** OPEN 12 condition 1: never write a password. Forget-only. */
export async function setRememberedPassword(
  _serverId: string,
  _password: string | null
): Promise<void> {
  try {
    const backend = await getBackend();
    await purgeStoredPasswords(backend);
  } catch {
    /* store unavailable */
  }
}

// ─── Leave hooks (push unregister before a token is dropped) ───

/** May return a promise: the session revoke waits for it (bounded), so a
 *  hook's request (push unregister) still carries a live token. */
type LeaveHook = (server: ServerEntry, token: string) => void | Promise<unknown>;
const leaveHooks = new Set<LeaveHook>();

/** Run `fn(server, token)` just before a signed-in server is removed or
 *  signed out of, while its token is still known. Returns the remover. */
export function onServerLeave(fn: LeaveHook): () => void {
  leaveHooks.add(fn);
  return () => leaveHooks.delete(fn);
}

/** Revoke this device's session on the daemon (`POST /cli/auth/logout`,
 *  K2 0.46.1: Bearer = the session token, idempotent, other devices stay
 *  signed in). Fire and forget: an unreachable server just keeps the
 *  token until it expires; the phone forgets it either way. */
export function revokeSession(serverUrl: string, token: string): void {
  const base = serverUrl.replace(/\/+$/, "");
  void Promise.race([
    tauriFetch(`${base}/cli/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
  ]).catch(() => {});
}

/** Hooks first (they still need the token), then the revoke. */
const LEAVE_HOOKS_WAIT_MS = 4000;

function announceLeave(server: ServerEntry | undefined, token: string | undefined): Promise<void> {
  if (!server || !token) return Promise.resolve();
  const pending: Promise<unknown>[] = [];
  for (const fn of leaveHooks) {
    try {
      const r = fn(server, token);
      if (r && typeof (r as Promise<unknown>).then === "function") pending.push(r as Promise<unknown>);
    } catch {
      /* a hook never blocks the removal */
    }
  }
  const url = server.url;
  if (!pending.length) {
    revokeSession(url, token);
    return Promise.resolve();
  }
  return Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, LEAVE_HOOKS_WAIT_MS)),
  ]).then(() => revokeSession(url, token));
}

// ─── Store ───

interface ServersState {
  /** True once `hydrate()` finished (persisted model + migration applied). */
  hydrated: boolean;
  servers: ServerEntry[];
  activeServerId: string | null;
  /** Per-server cached session token (from POST /cli/auth/login). */
  tokens: Record<string, string>;
  /** Per-server connection/recovery state (drives dots + the footer). */
  recovery: Record<string, RecoveryState>;

  hydrate: () => Promise<void>;
  setActive: (id: string) => void;
  /** Save (insert or replace by id). Returns false, saving nothing, when
   *  another entry already uses the new address's host key (MS2). An entry
   *  that already shared its key before this rule keeps saving. */
  upsertServer: (entry: ServerEntry) => boolean;
  removeServer: (id: string) => void;
  setToken: (id: string, token: string) => void;
  clearToken: (id: string) => void;
  setRecovery: (id: string, state: RecoveryState) => void;
}

function persistModel(state: Pick<ServersState, "servers" | "activeServerId" | "tokens">): void {
  void getBackend().then(async (backend) => {
    await backend.set("servers", state.servers);
    await backend.set("activeServerId", state.activeServerId);
    await backend.set("tokens", state.tokens);
  });
}

export const useServersStore = create<ServersState>((set, get) => ({
  hydrated: false,
  servers: [],
  activeServerId: null,
  tokens: {},
  recovery: {},

  hydrate: async () => {
    try {
      const backend = await getBackend();
      // OPEN 12 condition 2: drop leftover passwords before anything else,
      // including when there are no servers and the user does not log in.
      try {
        await purgeStoredPasswords(backend);
      } catch {
        /* still load the rest of the model */
      }
      let servers = (await backend.get<ServerEntry[]>("servers"))?.map(withHostKey);
      let tokens = (await backend.get<Record<string, string>>("tokens")) ?? {};
      let activeServerId =
        (await backend.get<string | null>("activeServerId")) ?? null;

      if (!servers) {
        // First boot on the multi-server model — migrate the legacy
        // single-session world. Persisting (even an empty list) marks the
        // migration done.
        const migrated = await migrateLegacy();
        servers = migrated.servers.map(withHostKey);
        tokens = migrated.tokens;
        activeServerId = migrated.activeServerId;
        await backend.set("servers", servers);
        await backend.set("tokens", tokens);
        await backend.set("activeServerId", activeServerId);
      }

      if (activeServerId && !servers.some((s) => s.id === activeServerId)) {
        activeServerId = servers[0]?.id ?? null;
      }
      if (!activeServerId && servers.length > 0) {
        activeServerId = servers[0].id;
      }

      // Optimistic restore (same stance as the old auth store): a persisted
      // token counts as connected; the first failing `/cli/*` call routes
      // through the revive path and corrects the state.
      const recovery: Record<string, RecoveryState> = {};
      for (const s of servers) {
        recovery[s.id] = tokens[s.id] ? "connected" : "signin-required";
      }
      set({ hydrated: true, servers, tokens, activeServerId, recovery });
    } catch {
      set({ hydrated: true });
    }
  },

  setActive: (id) => {
    if (!get().servers.some((s) => s.id === id)) return;
    set({ activeServerId: id });
    persistModel(get());
  },

  upsertServer: (input) => {
    const entry = withHostKey(input);
    const newKey = serverHostKey(entry);
    const servers = get().servers.slice();
    const idx = servers.findIndex((s) => s.id === entry.id);
    const prevKey = idx >= 0 ? serverHostKey(servers[idx]) : null;
    const dup = servers.find((s) => s.id !== entry.id && serverHostKey(s) === newKey);
    if (dup && prevKey !== newKey) {
      console.warn(`[servers] refused a duplicate saved server: ${newKey} is ${dup.nickname}`);
      return false;
    }
    if (idx >= 0) servers[idx] = entry;
    else servers.push(entry);
    set({ servers });
    persistModel(get());
    // MS3 / MA2: a new host key may be a different daemon — drop what the
    // app holds for this id (it keys by id, so nothing needs re-keying).
    if (prevKey !== null && prevKey !== newKey) fireForget(entry.id, "rekeyed");
    return true;
  },

  removeServer: (id) => {
    void announceLeave(get().servers.find((s) => s.id === id), get().tokens[id]);
    const servers = get().servers.filter((s) => s.id !== id);
    const tokens = { ...get().tokens };
    delete tokens[id];
    const recovery = { ...get().recovery };
    delete recovery[id];
    let activeServerId = get().activeServerId;
    if (activeServerId === id) activeServerId = servers[0]?.id ?? null;
    set({ servers, tokens, recovery, activeServerId });
    persistModel(get());
    void setRememberedPassword(id, null);
    fireForget(id, "removed");
  },

  setToken: (id, token) => {
    set({ tokens: { ...get().tokens, [id]: token } });
    persistModel(get());
  },

  clearToken: (id) => {
    const tokens = { ...get().tokens };
    delete tokens[id];
    set({ tokens });
    persistModel(get());
  },

  setRecovery: (id, state) => {
    if (get().recovery[id] === state) return;
    set({ recovery: { ...get().recovery, [id]: state } });
  },
}));

/** The active server entry, or null. */
export function getActiveServer(): ServerEntry | null {
  const s = useServersStore.getState();
  return s.servers.find((x) => x.id === s.activeServerId) ?? null;
}

// ─── One-time legacy migration ───

interface LegacyConn {
  id?: string;
  nickname?: string;
  serverUrl?: string;
  username?: string;
}

async function migrateLegacy(): Promise<{
  servers: ServerEntry[];
  tokens: Record<string, string>;
  activeServerId: string | null;
}> {
  const servers: ServerEntry[] = [];
  const tokens: Record<string, string> = {};
  let activeServerId: string | null = null;

  // 1. The saved-server list the old Login page kept in localStorage.
  try {
    const raw = localStorage.getItem("k2_connections");
    if (raw) {
      for (const c of JSON.parse(raw) as LegacyConn[]) {
        if (!c?.serverUrl || !c?.username) continue;
        servers.push({
          id: c.id || newId(),
          nickname: c.nickname || c.serverUrl,
          url: normalizeServerUrl(c.serverUrl),
          username: c.username,
          rememberPassword: false,
        });
      }
    }
  } catch {
    /* unreadable legacy list — nothing to migrate from it */
  }

  // 2. The single persisted session from plugin-store auth.json — the
  //    previously-signed-in server becomes the active one, token intact.
  try {
    const authStore = await load("auth.json", { defaults: {} });
    const s = await authStore.get<{
      serverUrl?: string;
      username?: string;
      token?: string;
    }>("session");
    if (s?.serverUrl && s.token) {
      const url = normalizeServerUrl(s.serverUrl);
      const username = s.username ?? "";
      let entry = servers.find((e) => e.url === url && e.username === username);
      if (!entry) {
        entry = {
          id: newId(),
          nickname: hostLabel(url),
          url,
          username,
          rememberPassword: false,
        };
        servers.unshift(entry);
      }
      tokens[entry.id] = s.token;
      activeServerId = entry.id;
    }
  } catch {
    /* no tauri store (browser dev) or no legacy session */
  }

  if (!activeServerId && servers.length > 0) activeServerId = servers[0].id;
  return { servers, tokens, activeServerId };
}

// ─── Login (the raw mint flow — shared by the add-server page + revive) ───

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; kind: "auth" | "forbidden" | "network" | "not-found"; error: string };

/**
 * `POST /cli/auth/login {username,password}` against a server. Rides
 * `withNetRetry` so a dead pooled WKWebView socket (thrown network error)
 * is evicted and immediately retried — the desktop's proven login-retry
 * idiom. Does NOT touch the store; callers commit the token.
 *
 * Hosted apex `https://<label>.k2.dev` POSTs through
 * `https://<label>.app.k2.dev` (desktop `loginUrlFor`). Token-bearing
 * traffic stays on `server.url`.
 */
export async function loginToServer(
  server: Pick<ServerEntry, "url" | "username">,
  password: string
): Promise<LoginResult> {
  const url = loginUrlFor(server.url);
  const viaEdge = k2DevApexLabel(server.url) !== null;
  try {
    const res = await withNetRetry(() =>
      Promise.race([
        tauriFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: server.username, password }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), 10000)
        ),
      ])
    );
    if (!res.ok) {
      const bodyText = await res.text();
      const fail = loginErrorFromStatus(
        res.status,
        bodyText,
        viaEdge,
        LOGIN_404_K2DEV_MESSAGE,
        res.headers?.get?.("retry-after") ?? null
      );
      if (fail) return { ok: false, ...fail };
      return { ok: false, kind: "network", error: `Login failed (HTTP ${res.status})` };
    }
    const data = (await res.json()) as { token?: string };
    if (!data?.token) {
      return { ok: false, kind: "network", error: "Login response missing token" };
    }
    return { ok: true, token: data.token };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, kind: "network", error: `Could not connect: ${msg}` };
  }
}

/**
 * The add/edit-server flow: log in, then commit the server entry + token
 * and (by default) make it the active server. Returns the saved server id
 * on success.
 *
 * Dedupe is by host key (MS2 / MA1), checked BEFORE the login so no token
 * is minted for a save that would be refused:
 *   - editing `id` onto another saved server's address → refused;
 *   - adding a server already saved under the same username → that entry is
 *     signed in again (today's re-login), not duplicated;
 *   - adding it under another username → refused.
 * `activate: false` (MA3) saves and signs in without switching the active
 * server (a row's "Sign in" in the multi-server list).
 */
export async function loginAndSaveServer(input: {
  id?: string;
  nickname: string;
  url: string;
  username: string;
  password: string;
  rememberPassword: boolean;
  /** Make it the active server after sign-in. Default true. */
  activate?: boolean;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const url = normalizeServerUrl(input.url);
  const username = input.username.trim();
  if (!tryHostKey(url)) return { ok: false, error: "Enter a server address like name.k2.dev" };

  const before = useServersStore.getState();
  let id = input.id;
  const dup = duplicateServer(before.servers, url, id ?? null);
  if (dup) {
    const editingSharedKey =
      id !== undefined &&
      before.servers.some((s) => s.id === id && serverHostKey(s) === serverHostKey(dup));
    if (!id && dup.username === username) id = dup.id;
    else if (!editingSharedKey) return { ok: false, error: duplicateServerMessage(dup) };
  }

  const result = await loginToServer({ url, username }, input.password);
  if (!result.ok) return { ok: false, error: result.error };

  const store = useServersStore.getState();
  if (!id) id = newId();
  const saved = store.upsertServer({
    id,
    nickname: input.nickname.trim() || hostLabel(url),
    url,
    username,
    rememberPassword: false,
  });
  if (!saved) {
    // Raced with another save of the same address while signing in.
    const other = duplicateServer(useServersStore.getState().servers, url, id);
    return { ok: false, error: other ? duplicateServerMessage(other) : "Could not save the server" };
  }
  store.setToken(id, result.token);
  store.setRecovery(id, "connected");
  await setRememberedPassword(id, null);
  if (input.activate !== false) store.setActive(id);
  return { ok: true, id };
}

/** Deliberate sign-out of one server: drop its token AND its remembered
 *  password (otherwise the revive path would silently log straight back
 *  in, making sign-out a no-op). Other servers are untouched. */
export function signOutServer(id: string): void {
  const store = useServersStore.getState();
  void announceLeave(store.servers.find((s) => s.id === id), store.tokens[id]);
  store.clearToken(id);
  store.setRecovery(id, "signin-required");
  void setRememberedPassword(id, null);
}

/**
 * Commit a device session from a pairing code (K2 0.46.4
 * `companion-pairing-v1`; the request itself is `api/pairing.ts`).
 *
 * `replaceId` is the saved server this pairing takes over: a "Pair again",
 * a "Switch to pairing", or an add the user confirmed over a server already
 * saved at that address. Without it, an address that is already saved is
 * refused: a pairing never silently replaces a server (K2's security
 * review). The old login, if any, leaves first (push unregister with its
 * token, then `/cli/auth/logout`), and only then does the new token land,
 * so the push watcher registers it afresh. A different login on the same
 * server drops what the app holds for that id.
 */
export async function commitPairedSession(input: {
  replaceId?: string | null;
  url: string;
  nickname: string;
  username: string;
  token: string;
  activate?: boolean;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const url = normalizeServerUrl(input.url);
  if (!tryHostKey(url)) return { ok: false, error: "Enter a server address like name.k2.dev" };
  const before = useServersStore.getState();
  const old = input.replaceId ? before.servers.find((s) => s.id === input.replaceId) : undefined;
  if (input.replaceId && !old) return { ok: false, error: "That server was removed from this phone." };
  const dup = duplicateServer(before.servers, url, old?.id ?? null);
  if (dup) return { ok: false, error: duplicateServerMessage(dup) };

  const id = old?.id ?? newId();
  const oldToken = old ? before.tokens[id] : undefined;
  if (old && oldToken && oldToken !== input.token) await announceLeave(old, oldToken);

  const store = useServersStore.getState();
  const saved = store.upsertServer({
    id,
    nickname: input.nickname.trim() || old?.nickname || hostLabel(url),
    url,
    username: input.username,
    rememberPassword: false,
    auth: "paired",
  });
  if (!saved) {
    const other = duplicateServer(useServersStore.getState().servers, url, id);
    return { ok: false, error: other ? duplicateServerMessage(other) : "Could not save the server" };
  }
  if (old && old.username !== input.username && serverHostKey(old) === serverHostKey({ url })) {
    fireForget(id, "rekeyed");
  }
  store.setToken(id, input.token);
  store.setRecovery(id, "connected");
  if (input.activate !== false) store.setActive(id);
  return { ok: true, id };
}
