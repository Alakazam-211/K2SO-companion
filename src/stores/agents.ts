import { create } from "zustand";
import * as api from "../api/client";
import { ws } from "../api/websocket";
import type { Agent, RunningAgent } from "../api/client";

interface AgentsState {
  agents: Agent[];
  runningAgents: RunningAgent[];
  isLoading: boolean;

  fetchAgents: (project: string) => Promise<void>;
  fetchRunningAgents: (project: string) => Promise<void>;
  refreshForProject: (project: string) => Promise<void>;
  startListening: (project: string) => () => void;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  runningAgents: [],
  isLoading: false,

  fetchAgents: async (project) => {
    const r = await api.getAgents(project);
    if (r.ok && r.data) set({ agents: r.data });
  },

  fetchRunningAgents: async (project) => {
    const r = await api.getRunningAgents(project);
    if (r.ok && r.data) set({ runningAgents: r.data });
  },

  refreshForProject: async (project) => {
    set({ isLoading: true });
    await Promise.all([get().fetchAgents(project), get().fetchRunningAgents(project)]);
    set({ isLoading: false });
  },

  startListening: (project) => {
    const u1 = ws.on("agent:lifecycle", () => {
      get().fetchAgents(project);
      get().fetchRunningAgents(project);
    });
    return () => { u1(); };
  },
}));
