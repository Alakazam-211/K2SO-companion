// Device settings for the multi-server list (MS35, MS40).
//
//   - `zen.multiServer` — "Show agents from all servers" (Zen Settings →
//     Experimental). Stored as "1" (on) / "0" (off). Default ON when nothing
//     is stored (owner override of PRD MS40's default-off, for now); an
//     explicit "0" keeps it off. Off, the Agents list shows the active
//     server only, exactly as before S2.
//   - `zen.serverFilter` — the nickname pill's pick: "all" (the default
//     when the flag is on) or one saved server's id.
//
// Same synchronous localStorage idiom as the other Zen UI prefs.

import { create } from "zustand";
import { onServerForget } from "../../stores/servers";
import type { ServerFilter } from "./merge";

export const MULTI_SERVER_KEY = "zen.multiServer";
export const SERVER_FILTER_KEY = "zen.serverFilter";

/** Missing (never set) reads as ON; only an explicit "0" is off. */
export function readMultiServer(): boolean {
  try {
    return localStorage.getItem(MULTI_SERVER_KEY) !== "0";
  } catch {
    return true;
  }
}

function readFilter(): ServerFilter {
  try {
    return (localStorage.getItem(SERVER_FILTER_KEY) || "").trim() || "all";
  } catch {
    return "all";
  }
}

type MultiServerPrefs = {
  multiServer: boolean;
  serverFilter: ServerFilter;
  setMultiServer: (on: boolean) => void;
  setServerFilter: (filter: ServerFilter) => void;
};

export const useMultiServerPrefs = create<MultiServerPrefs>((set) => ({
  multiServer: readMultiServer(),
  serverFilter: readFilter(),
  setMultiServer: (on) => {
    try {
      localStorage.setItem(MULTI_SERVER_KEY, on ? "1" : "0");
    } catch {
      /* the choice lasts this session */
    }
    set({ multiServer: on });
  },
  setServerFilter: (filter) => {
    try {
      if (filter === "all") localStorage.removeItem(SERVER_FILTER_KEY);
      else localStorage.setItem(SERVER_FILTER_KEY, filter);
    } catch {
      /* the choice lasts this session */
    }
    set({ serverFilter: filter });
  },
}));

// A removed server can no longer be the filter.
onServerForget((id, reason) => {
  if (reason === "removed" && useMultiServerPrefs.getState().serverFilter === id) {
    useMultiServerPrefs.getState().setServerFilter("all");
  }
});
