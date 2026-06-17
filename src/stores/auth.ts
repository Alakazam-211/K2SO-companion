import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import * as api from "../api/client";
import { ws } from "../api/websocket";

// Session persistence (tauri-plugin-store). The K2 Connect session token
// from `/cli/auth/login` has a 30-day TTL; persisting it means the app
// reconnects on launch without re-entering credentials.
const STORE_FILE = "auth.json";
const SESSION_KEY = "session";

interface PersistedSession {
  serverUrl: string;
  username: string;
  token: string;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {} });
  return storePromise;
}

async function persistSession(s: PersistedSession | null): Promise<void> {
  try {
    const store = await getStore();
    if (s) await store.set(SESSION_KEY, s);
    else await store.delete(SESSION_KEY);
    await store.save();
  } catch {
    /* store unavailable (web preview) — session stays in-memory only */
  }
}

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  serverUrl: string;
  username: string;
  error: string | null;

  login: (serverUrl: string, username: string, password: string) => Promise<boolean>;
  logout: () => void;
  restoreSession: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  isLoading: false,
  serverUrl: "",
  username: "",
  error: null,

  login: async (serverUrl, username, password) => {
    set({ isLoading: true, error: null });

    const url = serverUrl.startsWith("http") ? serverUrl : `https://${serverUrl}`;
    const result = await api.login(url, username, password);

    if (result.ok && result.data) {
      // Data calls go over HTTP to the daemon's `/cli/*` routes; live
      // terminal streaming uses a per-session grid-WS opened by
      // TerminalView. Both authenticate with the session token (set in
      // api.login). Persist it for next launch.
      await persistSession({ serverUrl: url, username, token: result.data.token });
      set({
        isAuthenticated: true,
        isLoading: false,
        serverUrl: url,
        username,
        error: null,
      });
      return true;
    }

    set({ isLoading: false, error: result.error || "Login failed" });
    return false;
  },

  logout: () => {
    ws.disconnect();
    api.clearSession();
    void persistSession(null);
    set({ isAuthenticated: false, serverUrl: "", username: "", error: null });
  },

  // Optimistic restore: re-apply the persisted token so the app opens
  // straight to the sessions list. If the token has expired, the first
  // `/cli/*` call returns Unauthorized and the UI can prompt re-login.
  restoreSession: async () => {
    try {
      const store = await getStore();
      const s = await store.get<PersistedSession>(SESSION_KEY);
      if (s?.token && s.serverUrl) {
        api.configure(s.serverUrl);
        api.setToken(s.token);
        set({
          isAuthenticated: true,
          serverUrl: s.serverUrl,
          username: s.username ?? "",
        });
        return true;
      }
    } catch {
      /* no persisted session */
    }
    return false;
  },
}));
