// How Home's person and channel rows reach the chat view and DM calls
// (4.3.0).
//
//   - Open: a row's tap goes to the chat view's real `openHomeChat`
//     (`./homeChatStore`), mapping the row's kind (`person` → `dm`). A
//     handler set with `setOpenHomeChatHandler` wins (tests).
//   - Call: built on its own branch (`home-dm-calls`); until its handler
//     is wired (`setCallPersonHandler`), a Call is kept in
//     `useHomeChatSeams.pendingCall`.

import { create } from "zustand";
import { openHomeChat as openChatView } from "./homeChatStore";

/** What a row opens: a DM (by its Sew conversation, the person's ext
 *  beside it) or a channel, on one server. */
export interface OpenHomeChatTarget {
  serverId: string;
  kind: "person" | "channel";
  /** Sew's conversation id (the DM's, or the channel's). */
  conversationId: string;
  /** The row's name: the person's display name, or the channel's. */
  title: string;
  /** A DM's other person (`k2:owner` / `k2:connect:…`). */
  ext?: string;
  /** A channel: invite-only (lock) or open (#); null when not known. */
  inviteOnly?: boolean | null;
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
  /** The last Call asked for while no call handler was wired. */
  pendingCall: { serverId: string; person: CallPersonTarget } | null;
}

export const useHomeChatSeams = create<SeamsState>(() => ({ pendingCall: null }));

/** Override the open (tests); null goes back to the chat view. */
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

/** Open a row's chat in the chat view. */
export function openHomeChat(t: OpenHomeChatTarget): void {
  if (openHandler) {
    openHandler(t);
    return;
  }
  openChatView({
    serverId: t.serverId,
    kind: t.kind === "person" ? "dm" : "channel",
    conversationId: t.conversationId,
    title: t.title,
    ...(t.kind === "person" ? { ext: t.ext ?? null } : { inviteOnly: t.inviteOnly ?? null }),
  });
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
  useHomeChatSeams.setState({ pendingCall: null });
}
