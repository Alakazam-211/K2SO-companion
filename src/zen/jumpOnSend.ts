import { create } from "zustand";

// "Jump to newest when I send" (Zen Settings → Chats): a phone-only
// setting, never sent to a server. Default ON (today's behaviour: Send
// scrolls the chat to the newest and follows the reply). Off, a send made
// while reading earlier messages keeps the reader's place; a "Sent ↓" pill
// jumps down (ThreadPane `onSend`). At the newest already, a send follows
// as before either way. Rosson 2026-10-27.
//
// Same synchronous localStorage idiom as the other Zen UI prefs.

export const JUMP_ON_SEND_KEY = "k2.zen.jumpOnSend";

/** On unless "0" is stored. */
export function readJumpOnSend(): boolean {
  try {
    return localStorage.getItem(JUMP_ON_SEND_KEY) !== "0";
  } catch {
    return true;
  }
}

type JumpOnSendState = {
  on: boolean;
  setOn: (on: boolean) => void;
};

export const useJumpOnSendStore = create<JumpOnSendState>((set) => ({
  on: readJumpOnSend(),
  setOn: (on) => {
    try {
      localStorage.setItem(JUMP_ON_SEND_KEY, on ? "1" : "0");
    } catch {
      /* the choice lasts this session */
    }
    set({ on });
  },
}));
