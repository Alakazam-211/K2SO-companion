// Where the Groups sheet is (this phone only): closed, on the list, or on a
// group's page. A long press on a group bar icon opens that group's page;
// Home's title menu opens the list. Also this phone's recently picked
// icons (desktop `k2.homes.recentIcons.v1`: up to 8, newest first, never
// synced).

import { create } from "zustand";
import { GROUP_ICON_NAME_RE } from "./groupIconName";

export const RECENT_ICONS_KEY = "k2.homes.recentIcons.v1";
export const RECENT_ICONS_MAX = 8;

export type GroupsSheetView = { view: "list" } | { view: "group"; groupId: string };

interface GroupsSheetState {
  open: GroupsSheetView | null;
  show: (at: GroupsSheetView) => void;
  close: () => void;
}

export const useGroupsSheet = create<GroupsSheetState>((set) => ({
  open: null,
  show: (at) => set({ open: at }),
  close: () => set({ open: null }),
}));

export function readRecentIcons(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_ICONS_KEY) ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && GROUP_ICON_NAME_RE.test(x)).slice(0, RECENT_ICONS_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Remember a pick (newest first, no repeats). Returns the new list. */
export function noteRecentIcon(name: string): string[] {
  const next = [name, ...readRecentIcons().filter((n) => n !== name)].slice(0, RECENT_ICONS_MAX);
  try {
    localStorage.setItem(RECENT_ICONS_KEY, JSON.stringify(next));
  } catch {
    /* kept for this session only */
  }
  return next;
}
