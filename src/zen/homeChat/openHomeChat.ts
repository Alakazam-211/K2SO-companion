// The seams to the Home chat view and to DM calls (4.3.0). Both are built
// on their own branches (`home-chat-view`: the chat view; `home-dm-calls`:
// `callPersonFromRow`); the rows and the hold menu here call through these
// two settable handlers, wired when the branches merge:
//
//   setOpenHomeChatHandler((t) => …open the chat view…)
//   setCallPersonHandler((serverId, person) => …ring…)
//
// Until a handler is set, the request is kept (`useHomeChatSeams`) so a
// late-mounted chat view can pick it up and the preview/tests can see it.

import { create } from "zustand";

/** What the chat view opens: a DM (by its Sew conversation, the person's
 *  ext beside it) or a channel, on one server. */
export interface OpenHomeChatTarget {
  serverId: string;
  kind: "person" | "channel";
  /** Sew's conversation id (the DM's, or the channel's). */
  conversationId: string;
  /** The row's name: the person's display name, or the channel's. */
  title: string;
  /** A DM's other person (`k2:owner` / `k2:connect:…`). */
  ext?: string;
  /** The Home row it came from (`<handle>::<host>`). */
  address?: string;
}

/** Who a person row's Call rings. */
export interface CallPersonTarget {
  ext: string;
  displayName: string;
  username: string;
  /** The DM's conversation when this phone already knows it. */
  conversationId?: string | null;
  address?: string;
}

type OpenHandler = (t: OpenHomeChatTarget) => void;
type CallHandler = (serverId: string, person: CallPersonTarget) => void;

let openHandler: OpenHandler | null = null;
let callHandler: CallHandler | null = null;

interface SeamsState {
  /** The last open asked for while no chat view was wired. */
  pendingOpen: OpenHomeChatTarget | null;
  /** The last Call asked for while no call handler was wired. */
  pendingCall: { serverId: string; person: CallPersonTarget } | null;
  takePendingOpen: () => OpenHomeChatTarget | null;
}

export const useHomeChatSeams = create<SeamsState>((set, get) => ({
  pendingOpen: null,
  pendingCall: null,
  takePendingOpen: () => {
    const t = get().pendingOpen;
    if (t) set({ pendingOpen: null });
    return t;
  },
}));

/** Wire the chat view (null unwires). Returns the unwire. */
export function setOpenHomeChatHandler(fn: OpenHandler | null): () => void {
  openHandler = fn;
  return () => {
    if (openHandler === fn) openHandler = null;
  };
}

/** Wire DM calls (null unwires). Returns the unwire. */
export function setCallPersonHandler(fn: CallHandler | null): () => void {
  callHandler = fn;
  return () => {
    if (callHandler === fn) callHandler = null;
  };
}

/** Open a Home chat (the chat view's entry). */
export function openHomeChat(t: OpenHomeChatTarget): void {
  if (openHandler) {
    openHandler(t);
    return;
  }
  useHomeChatSeams.setState({ pendingOpen: t });
}

/** Ring a person from their Home row (the DM calls entry). */
export function callPersonFromRow(serverId: string, person: CallPersonTarget): void {
  if (callHandler) {
    callHandler(serverId, person);
    return;
  }
  useHomeChatSeams.setState({ pendingCall: { serverId, person } });
}

/** Tests only. */
export function __resetHomeChatSeamsForTests(): void {
  openHandler = null;
  callHandler = null;
  useHomeChatSeams.setState({ pendingOpen: null, pendingCall: null });
}
