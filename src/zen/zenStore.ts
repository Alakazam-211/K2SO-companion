import { create } from "zustand";
import {
  getAgentList,
  getCliProjectsList,
  getFsReadDir,
  getFsReadFile,
  getThread,
  getToken,
  type FsDirEntry,
} from "../api/client";
import { getActiveServer } from "../stores/servers";
import {
  cliProjectOf,
  joinAgentsWithProjects,
  ownerAgentOf,
  parseCliProjects,
  parseOwnerAgents,
  skinInitials,
} from "./agentRow";
import { STUB_AGENTS, STUB_FILES, STUB_THREAD, STUB_THREAD_FALLBACK, type StubAgent, type StubFile } from "./stubData";
import { normaliseThreadItem, type ThreadMessage } from "./threadModel";
import {
  NO_WORKSPACE_PATH,
  PATH_NOT_OWNED,
  ROOT_LISTING_HIDDEN,
  isUnderWorkspace,
  looksLikeRootListing,
  ownedWorkspacePath,
  usableFsPath,
} from "./workspacePath";

export type DataSource = "stub" | "live" | "error" | "loading";

/** Signed-in empty list. Honest: 0 agents, and why. Do not invent a mapping. */
export const OWNER_LIST_HOLD =
  "No agents on this list. A fleet-sized owner list is not confirmed yet. /cli/skin/agents is grant-scoped. /cli/agents/list is the skills enumerator. This overlay does not invent a mapping.";

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
        path: String(e.path ?? e.name ?? ""),
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
  /** Overlay home is the chats list. A row opens the thread. */
  screen: "list" | "thread";
  agentId: string;
  filesOpen: boolean;
  openFileIds: string[];
  focusId: string | null;
  /** Other pane when two files are side by side. Null = single pane. */
  splitId: string | null;
  /** 0..1 width of the left split pane. */
  splitRatio: number;
  setAgent: (id: string) => void;
  closeChat: () => void;
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
        screen: "list",
        agentId: "",
        threadSource: "stub",
        threadError: null,
        thread: [],
      });
      return;
    }
    // Session exists: stub is unreachable. Owner fleet is GET /cli/agent/list
    // (singular). Address book is GET /cli/projects/list. Join on path.
    // Plural /cli/agents/list is the skills enumerator.
    set({
      agentSource: "loading",
      fileSource: "loading",
      agents: [],
      files: [],
      agentError: null,
      fileError: null,
      screen: "list",
      agentId: "",
      openFileIds: [],
      focusId: null,
      splitId: null,
      threadSource: "loading",
      threadError: null,
      thread: [],
    });
    try {
      const [rAgents, rProjects] = await Promise.all([
        getAgentList(),
        getCliProjectsList(),
      ]);
      const notices: string[] = [];
      let fleet: { name: string; path: string }[] = [];
      let book: { name: string; path: string; handle: string | null }[] = [];

      if (!rAgents.ok) {
        notices.push(rAgents.error || "GET /cli/agent/list failed");
      } else {
        const parsed = parseOwnerAgents(rAgents.data);
        if (!parsed) {
          notices.push(
            "GET /cli/agent/list returned an unrecognised shape. This overlay does not invent a mapping."
          );
        } else {
          for (const raw of parsed) {
            const row = ownerAgentOf(raw);
            if (row) fleet.push({ name: row.name, path: row.path });
          }
        }
      }

      if (!rProjects.ok) {
        notices.push(rProjects.error || "GET /cli/projects/list failed");
      } else {
        const parsed = parseCliProjects(rProjects.data);
        if (!parsed) {
          notices.push(
            "GET /cli/projects/list returned an unrecognised shape. This overlay does not invent a mapping."
          );
        } else {
          for (const raw of parsed) {
            const row = cliProjectOf(raw);
            if (row) book.push(row);
          }
        }
      }

      if (fleet.length === 0 && book.length === 0) {
        const msg =
          notices[0] ||
          "No agents on this list. This overlay does not invent a mapping.";
        set({
          agentSource: "error",
          fileSource: "error",
          agents: [],
          files: [],
          agentError: msg,
          fileError: msg,
          threadSource: "error",
          threadError: msg,
          thread: [],
        });
        return;
      }

      const agents: StubAgent[] = joinAgentsWithProjects(fleet, book).map(
        (row) => ({
          id: row.id,
          name: row.name,
          initial: skinInitials(row.name),
          path: row.path,
          addr: row.addr,
          joinMiss: row.joinMiss,
        })
      );
      set({
        agentSource: "live",
        agents,
        agentError: notices.length ? notices.join(" · ") : null,
        fileSource: "live",
        files: [],
        fileError: null,
        threadSource: "live",
        threadError: null,
        thread: [],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        agentSource: "error",
        fileSource: "error",
        agents: [],
        files: [],
        agentError: msg,
        fileError: msg,
        threadSource: "error",
        threadError: msg,
        thread: [],
      });
    }
  },

  hydrateFiles: async (dir) => {
    const gen = get().filesGen + 1;
    const agent = get().agents.find((a) => a.id === get().agentId);
    const owned = typeof agent?.path === "string" ? agent.path.trim() : "";
    const usable = ownedWorkspacePath(dir, owned);
    if (!usable) {
      const reason =
        owned && dir !== owned ? PATH_NOT_OWNED : NO_WORKSPACE_PATH;
      set({ filesGen: gen, ...failFiles(reason) });
      return;
    }
    set({ filesGen: gen, files: [], fileError: null, fileSource: "loading" });
    const apply = (patch: Partial<ZenState>) => {
      if (get().filesGen !== gen) return;
      set(patch);
    };
    try {
      const r = await getFsReadDir(usable);
      if (!r.ok || r.data === undefined) {
        apply(failFiles(r.error || "read-dir failed"));
        return;
      }
      const entries = dirEntries(r.data);
      if (looksLikeRootListing(entries)) {
        apply(failFiles(ROOT_LISTING_HIDDEN));
        return;
      }
      const files: StubFile[] = entries
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

  screen: "list",
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
    set({
      screen: "thread",
      agentId: id,
      openFileIds: [],
      focusId: null,
      splitId: null,
    });
    const row = get().agents.find((a) => a.id === id);
    const owned = typeof row?.path === "string" ? row.path.trim() : "";
    if (owned) void get().hydrateFiles(owned);
    else if (get().agentSource !== "stub") set(failFiles(NO_WORKSPACE_PATH));
    if (get().agentSource === "stub") {
      void get().hydrateThread(id);
      return;
    }
    if (row?.addr) void get().hydrateThread(row.addr);
    else {
      set({
        threadSource: "error",
        thread: [],
        threadError: row?.joinMiss || "Not chattable",
      });
    }
  },
  closeChat: () =>
    set({
      screen: "list",
      agentId: "",
      openFileIds: [],
      focusId: null,
      splitId: null,
      thread: [],
      threadError: null,
      files: [],
    }),
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
      const row = get().agents.find((a) => a.id === get().agentId);
      const owned = typeof row?.path === "string" ? row.path.trim() : "";
      const workspace = ownedWorkspacePath(owned, owned);
      const filePath = usableFsPath(id);
      if (!filePath || !workspace || !isUnderWorkspace(filePath, workspace)) return;
      void getFsReadFile(filePath).then((r) => {
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
