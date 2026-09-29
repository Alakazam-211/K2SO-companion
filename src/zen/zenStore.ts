import { create } from "zustand";
import { STUB_AGENTS, STUB_FILES } from "./stubData";

type ZenState = {
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
  agentId: STUB_AGENTS[0].id,
  filesOpen: true,
  openFileIds: [],
  focusId: null,
  splitId: null,
  splitRatio: 0.5,

  setAgent: (id) => set({ agentId: id }),
  toggleFiles: () => set({ filesOpen: !get().filesOpen }),

  openFile: (id) => {
    const { openFileIds, focusId } = get();
    if (!STUB_FILES.some((f) => f.id === id)) return;
    if (openFileIds.includes(id)) {
      set({ focusId: id, filesOpen: true });
      return;
    }
    const next = [...openFileIds, id];
    if (openFileIds.length === 0) {
      set({ openFileIds: next, focusId: id, splitId: null, filesOpen: true });
      return;
    }
    if (openFileIds.length === 1) {
      set({
        openFileIds: next,
        splitId: focusId,
        focusId: id,
        filesOpen: true,
      });
      return;
    }
    set({ openFileIds: next, focusId: id, filesOpen: true });
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
