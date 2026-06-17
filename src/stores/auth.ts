import { create } from "zustand";
import * as api from "../api/client";
import { ws } from "../api/websocket";
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
      // Data calls go over HTTP to the daemon's `/cli/*` routes. The
      // legacy companion RPC WebSocket (`/companion/ws`) no longer
      // exists; live terminal streaming uses a dedicated per-session
      // grid-WS (`/cli/sessions/grid`) opened by TerminalView (Phase 4).
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
    set({ isAuthenticated: false, serverUrl: "", username: "", error: null });
  },

  // No stored credentials yet — just show login screen
  restoreSession: async () => {
    return false;
  },
}));
