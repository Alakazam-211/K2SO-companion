// Device settings for the multi-server list (MS35, MS40).
//
//   - `zen.multiServer` — "Show agents from all servers" (Zen Settings →
//     Experimental). Stored as "1" (on) / "0" (off). Default ON when nothing
//     is stored (owner override of PRD MS40's default-off, for now); an
//     explicit "0" keeps it off. Off, the Agents list shows the active
//     server only, exactly as before S2.
//
// The Agents tab is always the ACTIVE server (owner 2026-10: the pill
// opens the Servers sheet again; picking there switches the active server
// and so the Agents tab). The old per-device `zen.serverFilter` pick is
// gone; a leftover value is cleared on load so it can never disagree.
//
// Same synchronous localStorage idiom as the other Zen UI prefs.

import { create } from "zustand";

export const MULTI_SERVER_KEY = "zen.multiServer";
/** Retired (the Agents tab's own server pick); cleared on load. */
const LEGACY_SERVER_FILTER_KEY = "zen.serverFilter";
try {
  localStorage.removeItem(LEGACY_SERVER_FILTER_KEY);
} catch {
  /* nothing to clear */
}

/** Missing (never set) reads as ON; only an explicit "0" is off. */
export function readMultiServer(): boolean {
  try {
    return localStorage.getItem(MULTI_SERVER_KEY) !== "0";
  } catch {
    return true;
  }
}

type MultiServerPrefs = {
  multiServer: boolean;
  setMultiServer: (on: boolean) => void;
};

export const useMultiServerPrefs = create<MultiServerPrefs>((set) => ({
  multiServer: readMultiServer(),
  setMultiServer: (on) => {
    try {
      localStorage.setItem(MULTI_SERVER_KEY, on ? "1" : "0");
    } catch {
      /* the choice lasts this session */
    }
    set({ multiServer: on });
  },
}));
