import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { withNetRetry } from "../lib/netRetry";

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
//   "passwords"      → Record<serverId, password> — ONLY servers where the
//                      user opted into "Remember password". (Keychain
//                      hardening is a tracked follow-up; see PRD §1.)
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
  /** Whether the user opted into storing the password for silent re-login. */
  rememberPassword: boolean;
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

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}`;
}

// ─── Persistence backend (plugin-store with localStorage fallback) ───

interface Backend {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
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
        };
      }
    })();
  }
  return backendPromise;
}

// ─── Remembered passwords (opt-in only; never held in zustand state) ───

export async function resolvePassword(serverId: string): Promise<string | null> {
  try {
    const backend = await getBackend();
    const map = (await backend.get<Record<string, string>>("passwords")) ?? {};
    return map[serverId] ?? null;
  } catch {
    return null;
  }
}

/** Persist (password given) or forget (null) a server's remembered
 *  password. Only called with a password when the user opted in. */
export async function setRememberedPassword(
  serverId: string,
  password: string | null
): Promise<void> {
  try {
    const backend = await getBackend();
    const map = (await backend.get<Record<string, string>>("passwords")) ?? {};
    if (password !== null) map[serverId] = password;
    else delete map[serverId];
    await backend.set("passwords", map);
  } catch {
    /* store unavailable — silent re-login just won't survive relaunch */
  }
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
  upsertServer: (entry: ServerEntry) => void;
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
      let servers = await backend.get<ServerEntry[]>("servers");
      let tokens = (await backend.get<Record<string, string>>("tokens")) ?? {};
      let activeServerId =
        (await backend.get<string | null>("activeServerId")) ?? null;

      if (!servers) {
        // First boot on the multi-server model — migrate the legacy
        // single-session world. Persisting (even an empty list) marks the
        // migration done.
        const migrated = await migrateLegacy();
        servers = migrated.servers;
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

  upsertServer: (entry) => {
    const servers = get().servers.slice();
    const idx = servers.findIndex((s) => s.id === entry.id);
    if (idx >= 0) servers[idx] = entry;
    else servers.push(entry);
    set({ servers });
    persistModel(get());
  },

  removeServer: (id) => {
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
  | { ok: false; kind: "auth" | "network"; error: string };

/**
 * `POST /cli/auth/login {username,password}` against a server. Rides
 * `withNetRetry` so a dead pooled WKWebView socket (thrown network error)
 * is evicted and immediately retried — the desktop's proven login-retry
 * idiom. Does NOT touch the store; callers commit the token.
 */
export async function loginToServer(
  server: Pick<ServerEntry, "url" | "username">,
  password: string
): Promise<LoginResult> {
  try {
    const res = await withNetRetry(() =>
      Promise.race([
        tauriFetch(`${server.url}/cli/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: server.username, password }),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out")), 10000)
        ),
      ])
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", error: "Invalid username or password" };
    }
    if (!res.ok) {
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
 * (+ opted-in password) and make it the active server. Returns the saved
 * server id on success.
 */
export async function loginAndSaveServer(input: {
  id?: string;
  nickname: string;
  url: string;
  username: string;
  password: string;
  rememberPassword: boolean;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const url = normalizeServerUrl(input.url);
  const username = input.username.trim();
  const result = await loginToServer({ url, username }, input.password);
  if (!result.ok) return { ok: false, error: result.error };

  const store = useServersStore.getState();
  let id = input.id;
  if (!id) {
    id = store.servers.find((s) => s.url === url && s.username === username)?.id ?? newId();
  }
  store.upsertServer({
    id,
    nickname: input.nickname.trim() || hostLabel(url),
    url,
    username,
    rememberPassword: input.rememberPassword,
  });
  store.setToken(id, result.token);
  store.setRecovery(id, "connected");
  await setRememberedPassword(id, input.rememberPassword ? input.password : null);
  store.setActive(id);
  return { ok: true, id };
}

/** Deliberate sign-out of one server: drop its token AND its remembered
 *  password (otherwise the revive path would silently log straight back
 *  in, making sign-out a no-op). Other servers are untouched. */
export function signOutServer(id: string): void {
  const store = useServersStore.getState();
  store.clearToken(id);
  store.setRecovery(id, "signin-required");
  void setRememberedPassword(id, null);
}
