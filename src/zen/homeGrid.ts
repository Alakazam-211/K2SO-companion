import { create } from "zustand";

// The Home tab's top grid size, per Home (a user via K2, 2026-11-12: "only
// 2-3 instead of 9, without removing agents from that Home"). Off, 3, 6 or
// 9 (the default, as before); the rest of the Home stays as rows below.
// This phone only for now: Homes sync (homes-sync-v1) has no field for it.
// Same synchronous localStorage idiom as the other Zen UI prefs; every
// read and write is in try/catch (a failure keeps it in memory).

export const HOME_GRID_KEY = "k2.zen.homeGrid.v1";
export const HOME_GRID_CHOICES = [0, 3, 6, 9] as const;
export type HomeGridSize = (typeof HOME_GRID_CHOICES)[number];
export const HOME_GRID_DEFAULT: HomeGridSize = 9;

function isSize(v: unknown): v is HomeGridSize {
  return HOME_GRID_CHOICES.includes(v as HomeGridSize);
}

/** `{homeId: size}`; anything else reads as empty. */
export function readHomeGrid(): Record<string, HomeGridSize> {
  try {
    const raw = localStorage.getItem(HOME_GRID_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, HomeGridSize> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (isSize(n)) out[k] = n;
    return out;
  } catch {
    return {};
  }
}

/** A Home's grid size (9 when never set). */
export function homeGridSize(sizes: Record<string, HomeGridSize>, homeId: string | null | undefined): HomeGridSize {
  if (!homeId) return HOME_GRID_DEFAULT;
  const n = sizes[homeId];
  return n === undefined ? HOME_GRID_DEFAULT : n;
}

type HomeGridState = {
  sizes: Record<string, HomeGridSize>;
  setSize: (homeId: string, size: HomeGridSize) => void;
};

export const useHomeGridStore = create<HomeGridState>((set, get) => ({
  sizes: readHomeGrid(),
  setSize: (homeId, size) => {
    if (!homeId || !isSize(size)) return;
    const sizes = { ...get().sizes };
    if (size === HOME_GRID_DEFAULT) delete sizes[homeId];
    else sizes[homeId] = size;
    set({ sizes });
    try {
      localStorage.setItem(HOME_GRID_KEY, JSON.stringify(sizes));
    } catch {
      /* kept in memory */
    }
  },
}));

/** The label for a size in the Home menu. */
export function homeGridLabel(size: HomeGridSize): string {
  return size === 0 ? "Off" : String(size);
}
