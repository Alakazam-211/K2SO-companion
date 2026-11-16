import { create } from "zustand";

// "Open this DM": a call push's tap (and its ring card's tap) names a DM by
// its Sew conversation id on one server. The chat view is another builder's
// (its `openHomeChat` isn't on this branch yet), so the request waits here:
//
//   TODO(home-chat-view): wire `openHomeChat` — in the chat view's mount,
//     useEffect(() => onOpenHomeChat((r) => openHomeChat(r.serverId, r.conversationId)), [])
//   `onOpenHomeChat` hands over a request made before it was listening (a
//   cold start from the notification) once, then each new one.
//
// The same request also goes out as a DOM event `k2:open-home-chat` (detail
// `{serverId, conversationId}`) for anything outside React.

export interface OpenHomeChatRequest {
  serverId: string;
  conversationId: string;
  /** Why: a call notification's tap, a ring card's tap. */
  from: "call-push" | "ring-card";
  at: number;
}

type Store = {
  pending: OpenHomeChatRequest | null;
};

export const useHomeChatOpenRequest = create<Store>(() => ({ pending: null }));

const listeners = new Set<(r: OpenHomeChatRequest) => void>();

export const OPEN_HOME_CHAT_EVENT = "k2:open-home-chat";

/** Ask for the DM `conversationId` on `serverId` to open. */
export function requestOpenHomeChat(serverId: string, conversationId: string, from: OpenHomeChatRequest["from"]): void {
  const r: OpenHomeChatRequest = { serverId, conversationId, from, at: Date.now() };
  if (listeners.size > 0) {
    for (const fn of [...listeners]) {
      try {
        fn(r);
      } catch {
        /* a listener never breaks the others */
      }
    }
    useHomeChatOpenRequest.setState({ pending: null });
  } else {
    useHomeChatOpenRequest.setState({ pending: r });
  }
  try {
    window.dispatchEvent(new CustomEvent(OPEN_HOME_CHAT_EVENT, { detail: { serverId, conversationId } }));
  } catch {
    /* no window (tests without a DOM) */
  }
}

/** The chat view's hook-up point: hears each request, and the one waiting. */
export function onOpenHomeChat(fn: (r: OpenHomeChatRequest) => void): () => void {
  listeners.add(fn);
  const waiting = useHomeChatOpenRequest.getState().pending;
  if (waiting) {
    useHomeChatOpenRequest.setState({ pending: null });
    fn(waiting);
  }
  return () => {
    listeners.delete(fn);
  };
}

export function __resetHomeChatOpenForTests(): void {
  listeners.clear();
  useHomeChatOpenRequest.setState({ pending: null });
}
