import { create } from "zustand";
import * as api from "../api/client";
import { ws } from "../api/websocket";
import type { Workspace, GlobalSession } from "../api/client";

interface WorkspacesState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  allSessions: GlobalSession[];
  isLoading: boolean;

  fetchWorkspaces: () => Promise<void>;
  fetchAllSessions: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  startListening: () => () => void;

  // Derived
  activeWorkspace: () => Workspace | undefined;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  allSessions: [],
  isLoading: false,

  fetchWorkspaces: async () => {
    const r = await api.getWorkspaces();
    if (r.ok && r.data) {
      set({ workspaces: r.data });
      // Auto-select first workspace if none active
      if (!get().activeWorkspaceId && r.data.length > 0) {
        set({ activeWorkspaceId: r.data[0].id });
      }
    }
  },

  fetchAllSessions: async () => {
    const r = await api.getAllSessions();
    if (r.ok && r.data) set({ allSessions: r.data });
  },

  setActive: async (id) => {
    set({ activeWorkspaceId: id });
    await api.setActiveWorkspace(id);
  },

  refreshAll: async () => {
    set({ isLoading: true });
    await Promise.all([get().fetchWorkspaces(), get().fetchAllSessions()]);
    set({ isLoading: false });
  },

  startListening: () => {
    const u1 = ws.on("sync:projects", () => get().fetchWorkspaces());
    const u2 = ws.on("agent:lifecycle", () => get().fetchAllSessions());
    return () => { u1(); u2(); };
  },

  activeWorkspace: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((w) => w.id === activeWorkspaceId);
  },
}));
