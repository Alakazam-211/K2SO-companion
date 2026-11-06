import { create } from "zustand";

// Whether the call screen (the Rooms overlay, in ChatsList) is open, and a
// request to open it from anywhere in the app (the mini video tile, which
// lives at the app's level so it shows on every screen).

type CallScreen = {
  open: boolean;
  /** Something asked for the call screen; ChatsList opens it and clears this. */
  pending: boolean;
  setOpen(open: boolean): void;
  ask(): void;
  /** True once, for the asker's request. */
  consume(): boolean;
};

export const useCallScreen = create<CallScreen>((set, get) => ({
  open: false,
  pending: false,
  setOpen: (open) => set({ open }),
  ask: () => set({ pending: true }),
  consume: () => {
    if (!get().pending) return false;
    set({ pending: false });
    return true;
  },
}));
