import { create } from "zustand";
import * as api from "../api/client";
import { ws } from "../api/websocket";
import type { Agent, RunningAgent, WorkspaceStatus } from "../api/client";

interface AgentsState {
  agents: Agent[];
  runningAgents: RunningAgent[];
  status: WorkspaceStatus | null;
  isLoading: boolean;

  fetchAgents: () => Promise<void>;
  fetchRunningAgents: () => Promise<void>;
  fetchStatus: () => Promise<void>;
  refreshAll: () => Promise<void>;
  wakeAgent: (name: string) => Promise<boolean>;
  startListening: () => () => void;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  runningAgents: [],
  status: null,
  isLoading: false,

  fetchAgents: async () => {
    const r = await api.getAgents();
    if (r.ok && r.data) set({ agents: r.data });
  },

  fetchRunningAgents: async () => {
    const r = await api.getRunningAgents();
    if (r.ok && r.data) set({ runningAgents: r.data });
  },

  fetchStatus: async () => {
    const r = await api.getStatus();
    if (r.ok && r.data) set({ status: r.data });
  },

  refreshAll: async () => {
    set({ isLoading: true });
    await Promise.all([get().fetchAgents(), get().fetchRunningAgents(), get().fetchStatus()]);
    set({ isLoading: false });
  },

  wakeAgent: async (name) => {
    const r = await api.wakeAgent(name);
    if (r.ok) {
      // Give K2SO a moment to spin up the terminal, then refresh
      setTimeout(() => get().refreshAll(), 2000);
      return true;
    }
    return false;
  },

  startListening: () => {
    const u1 = ws.on("agent:lifecycle", () => {
      get().fetchAgents();
      get().fetchRunningAgents();
    });
    const u2 = ws.on("sync:projects", () => get().refreshAll());
    return () => { u1(); u2(); };
  },
}));
