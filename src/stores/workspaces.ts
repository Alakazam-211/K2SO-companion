import { create } from "zustand";
import * as api from "../api/client";
import { ws } from "../api/websocket";
import type { Project, ProjectSummary, GlobalSession, FocusGroup } from "../api/client";

interface WorkspacesState {
  projects: Project[];
  summaries: ProjectSummary[];
  allSessions: GlobalSession[];
  activeProjectId: string | null;
  activeFocusGroupId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;

  fetchProjects: () => Promise<void>;
  fetchSummaries: () => Promise<void>;
  fetchAllSessions: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setActiveProject: (id: string) => void;
  setActiveFocusGroup: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  startListening: () => () => void;

  // Derived
  focusGroups: () => FocusGroup[];
  activeProject: () => Project | undefined;
  agentProjects: () => Project[];
  pinnedProjects: () => Project[];
  focusGroupProjects: () => Project[];
  filteredProjects: () => Project[];
  summaryFor: (id: string) => ProjectSummary | undefined;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  projects: [],
  summaries: [],
  allSessions: [],
  activeProjectId: null,
  activeFocusGroupId: null,
  searchQuery: "",
  isLoading: false,
  error: null,

  fetchProjects: async () => {
    // Summary endpoint now includes focusGroup, pinned, tabOrder — no need for the heavy /projects endpoint
    const r = await api.getProjectsSummary();
    if (r.ok && r.data) {
      const projects: Project[] = r.data.map((s) => ({
        id: s.id,
        name: s.name,
        path: s.path,
        color: s.color,
        iconUrl: null,
        agentMode: s.agentMode,
        pinned: s.pinned ?? false,
        tabOrder: s.tabOrder ?? 0,
        focusGroup: s.focusGroup ?? null,
      }));
      set({ projects, summaries: r.data, error: null });

      if (!get().activeProjectId && projects.length > 0) {
        set({ activeProjectId: projects[0].id });
      }

      // Auto-select first focus group
      if (!get().activeFocusGroupId) {
        const groups = new Map<string, boolean>();
        for (const p of projects) {
          if (p.focusGroup) groups.set(p.focusGroup.id, true);
        }
        const firstGroupId = Array.from(groups.keys())[0];
        if (firstGroupId) set({ activeFocusGroupId: firstGroupId });
      }
    } else {
      set({ error: r.error || "Failed to load projects" });
    }
  },

  fetchSummaries: async () => {
    const r = await api.getProjectsSummary();
    if (r.ok && r.data) set({ summaries: r.data });
  },

  fetchAllSessions: async () => {
    const r = await api.getAllSessions();
    if (r.ok && r.data) set({ allSessions: r.data });
  },

  refreshAll: async () => {
    set({ isLoading: true });
    // Sequential — companion server is single-threaded
    await get().fetchProjects();
    await get().fetchAllSessions();
    set({ isLoading: false });
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  setActiveFocusGroup: (id) => set({ activeFocusGroupId: id }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  startListening: () => {
    const u1 = ws.on("sync:projects", () => get().refreshAll());
    const u2 = ws.on("agent:lifecycle", () => {
      get().fetchSummaries();
      get().fetchAllSessions();
    });
    return () => { u1(); u2(); };
  },

  // Extract unique focus groups from projects
  focusGroups: () => {
    const groups = new Map<string, FocusGroup>();
    for (const p of get().projects) {
      if (p.focusGroup) {
        groups.set(p.focusGroup.id, p.focusGroup);
      }
    }
    return Array.from(groups.values());
  },

  activeProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId);
  },

  // Zone 1a: Agent workspaces (agentMode === 'agent' || 'custom')
  agentProjects: () => {
    return get().projects.filter((p) =>
      p.agentMode === "agent" || p.agentMode === "custom"
    );
  },

  // Zone 1b: Pinned (but not already agents)
  pinnedProjects: () => {
    const agentIds = new Set(get().agentProjects().map((p) => p.id));
    return get().projects.filter((p) => p.pinned && !agentIds.has(p.id));
  },

  // Zone 2: Workspaces in active focus group
  focusGroupProjects: () => {
    const { projects, activeFocusGroupId } = get();
    const agentIds = new Set(get().agentProjects().map((p) => p.id));
    const unpinned = projects.filter((p) => !p.pinned && !agentIds.has(p.id));

    if (!activeFocusGroupId) return unpinned;
    return unpinned.filter((p) => p.focusGroup?.id === activeFocusGroupId);
  },

  // Search-filtered projects (across all zones)
  filteredProjects: () => {
    const query = get().searchQuery.toLowerCase().trim();
    if (!query) return get().projects;
    return get().projects.filter((p) =>
      p.name.toLowerCase().includes(query) ||
      p.path.toLowerCase().includes(query)
    );
  },

  summaryFor: (id) => {
    return get().summaries.find((s) => s.id === id);
  },
}));
