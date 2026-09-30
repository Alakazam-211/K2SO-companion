import { create } from "zustand";
import {
  getAgents,
  getFsReadDir,
  getFsReadFile,
  getProjectsSummary,
  getThread,
  getToken,
  type FsDirEntry,
} from "../api/client";
import { getActiveServer } from "../stores/servers";
import { STUB_AGENTS, STUB_FILES, STUB_THREAD, STUB_THREAD_FALLBACK, type StubAgent, type StubFile } from "./stubData";
import { normaliseThreadItem, type ThreadMessage } from "./threadModel";

export type DataSource = "stub" | "live" | "error" | "loading";

export function sourceWord(s: DataSource): "LIVE" | "STUB" | "ERROR" | "LOADING" {
  if (s === "live") return "LIVE";
  if (s === "error") return "ERROR";
  if (s === "loading") return "LOADING";
  return "STUB";
}

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
  /** Bumped at the start of every hydrateFiles; stale responses must not apply. */
  filesGen: number;
  threadSource: DataSource;
  threadError: string | null;
  thread: ThreadMessage[];
  threadGen: number;
  hydrateAgents: () => Promise<void>;
  hydrateFiles: (dir: string) => Promise<void>;
  hydrateThread: (addr: string) => Promise<void>;
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

function failFiles(message: string): Pick<ZenState, "fileSource" | "files" | "fileError"> {
  return { fileSource: "error", files: [], fileError: message };
}

function stubThread(agentId: string): ThreadMessage[] {
  const rows = STUB_THREAD[agentId] || STUB_THREAD_FALLBACK;
  return rows.map((m, i) => ({
    id: `stub-${agentId}-${i}`,
    seq: i,
    text: m.text,
    from: m.author,
    at: null,
    mine: m.mine,
    kind: "text",
    choice: null,
  }));
}

export const useZenStore = create<ZenState>((set, get) => ({
  // Never start on the stub catalogue. A signed-in first paint used to
  // show STUB_AGENTS until hydrateAgents resolved. Stub is only applied
  // when hydrateAgents sees no token.
  agentSource: "loading",
  fileSource: "loading",
  agents: [],
  files: [],
  agentError: null,
  fileError: null,
  filesGen: 0,
  threadSource: "loading",
  threadError: null,
  thread: [],
  threadGen: 0,

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
        threadSource: "stub",
        threadError: null,
        thread: stubThread(get().agentId || STUB_AGENTS[0].id),
      });
      return;
    }
    // Session exists: stub is unreachable for the whole in-flight window.
    set({
      agentSource: "loading",
      fileSource: "loading",
      agents: [],
      files: [],
      agentError: null,
      fileError: null,
      agentId: "",
      openFileIds: [],
      focusId: null,
      splitId: null,
      threadSource: "loading",
      threadError: null,
      thread: [],
    });
    try {
      const projects = await getProjectsSummary();
      if (!projects.ok || !projects.data) {
        const msg = projects.error || "projects.summary failed";
        set({
          agentSource: "error",
          agents: [],
          agentError: msg,
          agentId: "",
          openFileIds: [],
          focusId: null,
          splitId: null,
          threadSource: "error",
          thread: [],
          threadError: msg,
          ...failFiles(msg),
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
      else set(failFiles("live agents have no workspace path"));
      if (agentId) await get().hydrateThread(agentId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        agentSource: "error",
        agents: [],
        agentError: msg,
        agentId: "",
        openFileIds: [],
        focusId: null,
        splitId: null,
        threadSource: "error",
        thread: [],
        threadError: msg,
        ...failFiles(msg),
      });
    }
  },

  hydrateFiles: async (dir) => {
    const gen = get().filesGen + 1;
    set({ filesGen: gen, files: [], fileError: null, fileSource: "loading" });
    const apply = (patch: Partial<ZenState>) => {
      if (get().filesGen !== gen) return;
      set(patch);
    };
    try {
      const r = await getFsReadDir(dir);
      if (!r.ok || r.data === undefined) {
        apply(failFiles(r.error || "read-dir failed"));
        return;
      }
      const files: StubFile[] = dirEntries(r.data)
        .filter((e) => !e.isDirectory && !e.name.startsWith("."))
        .slice(0, 200)
        .map((e) => ({ id: e.path, name: e.name, body: "" }));
      apply({
        fileSource: "live",
        files,
        fileError: null,
      });
    } catch (e) {
      apply(failFiles(e instanceof Error ? e.message : String(e)));
    }
  },

  agentId: "",
  filesOpen: true,
  openFileIds: [],
  focusId: null,
  splitId: null,
  splitRatio: 0.5,

  hydrateThread: async (addr) => {
    if (get().agentSource === "stub") {
      set({ threadSource: "stub", threadError: null, thread: stubThread(addr) });
      return;
    }
    const gen = get().threadGen + 1;
    set({ threadGen: gen, thread: [], threadError: null, threadSource: "loading" });
    const username = getActiveServer()?.username ?? "";
    try {
      const r = await getThread(addr);
      if (get().threadGen !== gen) return;
      if (!r.ok || !r.data || !Array.isArray(r.data.items)) {
        set({
          threadSource: "error",
          thread: [],
          threadError:
            typeof r.error === "string" && r.error
              ? r.error
              : r.error
                ? JSON.stringify(r.error)
                : "thread failed",
        });
        return;
      }
      const items = r.data.items
        .map((it) => normaliseThreadItem(it, username))
        .filter((m): m is ThreadMessage => !!m)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      set({ threadSource: "live", thread: items, threadError: null });
    } catch (e) {
      if (get().threadGen !== gen) return;
      set({
        threadSource: "error",
        thread: [],
        threadError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  setAgent: (id) => {
    set({ agentId: id, openFileIds: [], focusId: null, splitId: null });
    const path = get().agents.find((a) => a.id === id)?.path;
    if (path) void get().hydrateFiles(path);
    void get().hydrateThread(id);
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
      const gen = get().filesGen;
      void getFsReadFile(id).then((r) => {
        if (get().filesGen !== gen) return;
        if (!get().files.some((f) => f.id === id)) return;
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
