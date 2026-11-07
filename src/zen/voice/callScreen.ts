import { create } from "zustand";

// Whether the call screen (the Rooms overlay) is open. It lives at the app's
// level, over every screen (a chat, the terminal, Gardens), so opening it
// from the floating call tile anywhere shows it on top, and its back arrow
// returns to that same place.

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
  ask: () => {
    // The call screen covers the chat, so its composer's keyboard has to go
    // (the draft is kept per chat).
    const el = typeof document === "undefined" ? null : document.activeElement;
    if (el instanceof HTMLElement) el.blur();
    set({ open: true, pending: false });
  },
  consume: () => {
    if (!get().pending) return false;
    set({ pending: false });
    return true;
  },
}));
