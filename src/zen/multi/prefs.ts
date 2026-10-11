// Device settings for the multi-server list (MS35, MS40).
//
//   - `zen.multiServer` — "Show agents from all servers" (Zen Settings →
//     Experimental). Default OFF: the Agents list shows the active server
//     only, exactly as before S2.
//   - `zen.serverFilter` — the nickname pill's pick: "all" (the default
//     when the flag is on) or one saved server's id.
//
// Same synchronous localStorage idiom as the other Zen UI prefs.

import { create } from "zustand";
import { onServerForget } from "../../stores/servers";
import type { ServerFilter } from "./merge";

export const MULTI_SERVER_KEY = "zen.multiServer";
export const SERVER_FILTER_KEY = "zen.serverFilter";

export function readMultiServer(): boolean {
  try {
    return localStorage.getItem(MULTI_SERVER_KEY) === "1";
  } catch {
    return false;
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
      if (on) localStorage.setItem(MULTI_SERVER_KEY, "1");
      else localStorage.removeItem(MULTI_SERVER_KEY);
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
