// Device settings for the multi-server list (MS35, MS40).
//
//   - `zen.multiServer` — "Show agents from all servers" (Zen Settings →
//     Experimental). Stored as "1" (on) / "0" (off). Default ON when nothing
//     is stored (owner override of PRD MS40's default-off, for now); an
//     explicit "0" keeps it off. Off, the Agents list shows the active
//     server only, exactly as before S2.
//   - `zen.serverFilter` — the Agents tab's server (the nickname pill's
//     pick): one saved server's id. Nothing stored (or a server no longer
//     saved) means the active/default server. The Agents tab is always ONE
//     server; Home is the cross-server list and its pill reads "All". A
//     legacy "all" from before reads as nothing stored.
//
// Same synchronous localStorage idiom as the other Zen UI prefs.

import { create } from "zustand";
import { onServerForget } from "../../stores/servers";

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

function readFilter(): string | null {
  try {
    const v = (localStorage.getItem(SERVER_FILTER_KEY) || "").trim();
    return v && v !== "all" ? v : null;
  } catch {
    return null;
  }
}

type MultiServerPrefs = {
  multiServer: boolean;
  /** The Agents tab's server id; null = the active/default server. */
  serverFilter: string | null;
  setMultiServer: (on: boolean) => void;
  setServerFilter: (serverId: string | null) => void;
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
  setServerFilter: (serverId) => {
    try {
      if (!serverId) localStorage.removeItem(SERVER_FILTER_KEY);
      else localStorage.setItem(SERVER_FILTER_KEY, serverId);
    } catch {
      /* the choice lasts this session */
    }
    set({ serverFilter: serverId });
  },
}));

// A removed server can no longer be the Agents tab's: back to the default.
onServerForget((id, reason) => {
  if (reason === "removed" && useMultiServerPrefs.getState().serverFilter === id) {
    useMultiServerPrefs.getState().setServerFilter(null);
  }
});
