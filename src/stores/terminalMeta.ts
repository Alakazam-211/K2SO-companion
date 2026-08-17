import { create } from "zustand";

// Per-session terminal metadata surfaced OUT of TerminalView — the
// seam T3 (Safe/Direct input modes) consumes without touching the
// grid plumbing. TerminalView is the only writer: it mirrors its
// claim-state machine (lib/claimState.ts, fed by the grid-WS mode /
// pin_initial / pin_changed events) here on every change and clears
// its entry on unmount.
//
// T3 usage (read-only): daemon role. Watch keeps the composer
// (Safe send → terminal.write); viewer is not a messaging gate.
// Absent entry defaults to "claimer". Drive is the ChatSession
// header flag, not this store.

export interface TerminalMeta {
  /** Daemon-judged role for the live grid connection. */
  mode: "viewer" | "claimer";
  /** Claimer-capable per the daemon. */
  capable: boolean;
  /** This phone holds the ephemeral "Claim session" pin. */
  claimedByMe: boolean;
  /** Session is pinned to a fixed size by ANOTHER client. */
  pinnedByOther: boolean;
}

interface TerminalMetaState {
  meta: Record<string, TerminalMeta>;
  set: (sessionId: string, meta: TerminalMeta) => void;
  clear: (sessionId: string) => void;
}

export const useTerminalMetaStore = create<TerminalMetaState>((set) => ({
  meta: {},
  set: (sessionId, meta) =>
    set((s) => ({ meta: { ...s.meta, [sessionId]: meta } })),
  clear: (sessionId) =>
    set((s) => {
      const next = { ...s.meta };
      delete next[sessionId];
      return { meta: next };
    }),
}));

/** Selector: this session's input role ("claimer" when unknown). */
export const selectTerminalMode =
  (sessionId: string) =>
  (s: TerminalMetaState): "viewer" | "claimer" =>
    s.meta[sessionId]?.mode ?? "claimer";
