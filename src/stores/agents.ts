import { create } from "zustand";
import * as api from "../api/client";
import { ws } from "../api/websocket";
import type { Agent, RunningTerminal } from "../api/client";

interface AgentsState {
  agents: Agent[];
  runningTerminals: RunningTerminal[];
  isLoading: boolean;

  fetchAgents: (project: string) => Promise<void>;
  fetchRunningTerminals: (project: string) => Promise<void>;
  refreshForProject: (project: string) => Promise<void>;
  startListening: (project: string) => () => void;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  runningTerminals: [],
  isLoading: false,

  fetchAgents: async (project) => {
    const r = await api.getAgents(project);
    if (r.ok && r.data) set({ agents: r.data });
  },

  fetchRunningTerminals: async (project) => {
    const r = await api.getRunningTerminals(project);
    if (r.ok && r.data) set({ runningTerminals: r.data });
  },

  refreshForProject: async (project) => {
    set({ isLoading: true });
    await Promise.all([get().fetchAgents(project), get().fetchRunningTerminals(project)]);
    set({ isLoading: false });
  },

  startListening: (project) => {
    const u1 = ws.on("agent:lifecycle", () => {
      get().fetchAgents(project);
      get().fetchRunningTerminals(project);
    });
    return () => { u1(); };
  },
}));
