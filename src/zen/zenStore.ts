import { create } from "zustand";
import {
  getAgents,
  getFsReadDir,
  getFsReadFile,
  getProjectsSummary,
  getToken,
  type FsDirEntry,
} from "../api/client";
import { STUB_AGENTS, STUB_FILES, type StubAgent, type StubFile } from "./stubData";

export type DataSource = "stub" | "live";

function dirEntries(data: unknown): FsDirEntry[] {
  const arr = Array.isArray(data)
    ? data
    : data &&
        typeof data === "object" &&
        Array.isArray((data as { entries?: unknown }).entries)
      ? ((data as { entries: unknown[] }).entries)
      : [];
  return arr
    .map((raw) => {
      const e = raw as Record<string, unknown>;
      return {
        name: String(e.name ?? ""),
        path: String(e.path ?? ""),
        isDirectory: Boolean(e.isDirectory ?? e.is_directory),
        size: typeof e.size === "number" ? e.size : undefined,
      };
    })
    .filter((e) => e.name && e.path);
}

type ZenState = {
  agentSource: DataSource;
  fileSource: DataSource;
  agents: StubAgent[];
  files: StubFile[];
  agentError: string | null;
  fileError: string | null;
  hydrateAgents: () => Promise<void>;
  hydrateFiles: (dir: string) => Promise<void>;
  agentId: string;
  filesOpen: boolean;
  openFileIds: string[];
  focusId: string | null;
  /** Other pane when two files are side by side. Null = single pane. */
  splitId: string | null;
  /** 0..1 width of the left split pane. */
  splitRatio: number;
  setAgent: (id: string) => void;
  toggleFiles: () => void;
  openFile: (id: string) => void;
  closeFile: (id: string) => void;
  focusFile: (id: string) => void;
  setSplitRatio: (n: number) => void;
};

export const useZenStore = create<ZenState>((set, get) => ({
  agentSource: "stub",
  fileSource: "stub",
  agents: STUB_AGENTS,
  files: STUB_FILES,
  agentError: null,
  fileError: null,

  hydrateAgents: async () => {
    if (!getToken()) {
      set({
        agentSource: "stub",
        fileSource: "stub",
        agents: STUB_AGENTS,
        files: STUB_FILES,
        agentError: null,
        fileError: null,
        agentId: get().agentId || STUB_AGENTS[0].id,
      });
      return;
    }
    try {
      const projects = await getProjectsSummary();
      if (!projects.ok || !projects.data) {
        set({
          agentSource: "stub",
          agents: STUB_AGENTS,
          agentError: projects.error || "projects.summary failed",
        });
        return;
      }
      const seen = new Map<string, StubAgent>();
      for (const p of projects.data) {
        const r = await getAgents(p.path);
        if (!r.ok || !r.data) continue;
        for (const a of r.data) {
          if (seen.has(a.name)) continue;
          seen.set(a.name, {
            id: a.name,
            name: a.name,
            initial: (a.name[0] || "?").toUpperCase(),
            path: p.path,
          });
        }
      }
      const agents = [...seen.values()];
      const agentId = agents.some((a) => a.id === get().agentId)
        ? get().agentId
        : agents[0]?.id ?? "";
      set({
        agentSource: "live",
        agents,
        agentError: agents.length ? null : "live: 0 agents",
        agentId,
        openFileIds: [],
        focusId: null,
        splitId: null,
      });
      const path = agents.find((a) => a.id === agentId)?.path;
      if (path) await get().hydrateFiles(path);
      else {
        set({
          fileSource: "stub",
          files: STUB_FILES,
          fileError: "live agents have no workspace path",
        });
      }
    } catch (e) {
      set({
        agentSource: "stub",
        agents: STUB_AGENTS,
        agentError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  hydrateFiles: async (dir) => {
    try {
      const r = await getFsReadDir(dir);
      if (!r.ok || r.data === undefined) {
        set({
          fileSource: "stub",
          files: STUB_FILES,
          fileError: r.error || "read-dir failed",
        });
        return;
      }
      const files: StubFile[] = dirEntries(r.data)
        .filter((e) => !e.isDirectory && !e.name.startsWith("."))
        .slice(0, 200)
        .map((e) => ({ id: e.path, name: e.name, body: "" }));
      set({
        fileSource: "live",
        files,
        fileError: null,
      });
    } catch (e) {
      set({
        fileSource: "stub",
        files: STUB_FILES,
        fileError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  agentId: STUB_AGENTS[0].id,
  filesOpen: true,
  openFileIds: [],
  focusId: null,
  splitId: null,
  splitRatio: 0.5,

  setAgent: (id) => {
    set({ agentId: id, openFileIds: [], focusId: null, splitId: null });
    const path = get().agents.find((a) => a.id === id)?.path;
    if (path) void get().hydrateFiles(path);
  },
  toggleFiles: () => set({ filesOpen: !get().filesOpen }),

  openFile: (id) => {
    const { files, openFileIds, focusId, fileSource } = get();
    const file = files.find((f) => f.id === id);
    if (!file) return;
    if (openFileIds.includes(id)) {
      set({ focusId: id, filesOpen: true });
    } else if (openFileIds.length === 0) {
      set({ openFileIds: [id], focusId: id, splitId: null, filesOpen: true });
    } else if (openFileIds.length === 1) {
      set({
        openFileIds: [...openFileIds, id],
        splitId: focusId,
        focusId: id,
        filesOpen: true,
      });
    } else {
      set({ openFileIds: [...openFileIds, id], focusId: id, filesOpen: true });
    }
    if (fileSource === "live" && !file.body) {
      void getFsReadFile(id).then((r) => {
        const body =
          r.ok && r.data
            ? r.data.content
            : `read-file failed: ${r.error || "unknown"}`;
        set({
          files: get().files.map((f) => (f.id === id ? { ...f, body } : f)),
        });
      });
    }
  },

  closeFile: (id) => {
    const { openFileIds, focusId, splitId } = get();
    const next = openFileIds.filter((x) => x !== id);
    if (next.length === 0) {
      set({ openFileIds: next, focusId: null, splitId: null });
      return;
    }
    const nextFocus = focusId === id ? next[next.length - 1] : focusId;
    let nextSplit = splitId === id ? null : splitId;
    if (next.length < 2) nextSplit = null;
    set({ openFileIds: next, focusId: nextFocus, splitId: nextSplit });
  },

  focusFile: (id) => set({ focusId: id }),
  setSplitRatio: (n) => set({ splitRatio: Math.min(0.8, Math.max(0.2, n)) }),
}));
