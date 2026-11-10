import { create } from "zustand";
import type { ThreadMatch } from "./threadSearch";

// The open Thread's search (threadSearch.ts): the header's field writes the
// query and steps through matches; the Thread finds them, jumps to the
// current one and paints the highlights. One Thread is open at a time, so
// one state: a switch closes it.

export type ThreadSearchMatch = ThreadMatch & { seq: number | null };

type ThreadSearch = {
  open: boolean;
  query: string;
  /** The current match's key; null = the newest. */
  current: string | null;
  /** Published by the Thread, newest first. */
  matches: readonly ThreadSearchMatch[];
  /** Older messages are still loading to be searched. */
  searching: boolean;
  setOpen(open: boolean): void;
  setQuery(query: string): void;
  setCurrent(key: string | null): void;
  publish(matches: readonly ThreadSearchMatch[], searching: boolean): void;
};

const CLOSED = { open: false, query: "", current: null, matches: [], searching: false };

export const useThreadSearch = create<ThreadSearch>((set) => ({
  ...CLOSED,
  setOpen: (open) => set(open ? { open: true } : CLOSED),
  setQuery: (query) => set({ query, current: null }),
  setCurrent: (current) => set({ current }),
  publish: (matches, searching) => set({ matches, searching }),
}));
