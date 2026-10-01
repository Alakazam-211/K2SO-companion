import type { ThreadMessage } from "./threadModel";

/** Append unseen items. Same array reference when nothing new. */
export function mergeThreadMessages(
  current: ThreadMessage[],
  incoming: ThreadMessage[]
): ThreadMessage[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map((m) => m.id));
  const extra = incoming.filter((m) => m.id && !seen.has(m.id));
  if (!extra.length) return current;
  return [...current, ...extra].sort(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
  );
}

export function overlayEventsUrl(
  base: string,
  token: string,
  conversationId: string
): string | null {
  const origin = (base || "").trim();
  const conv = (conversationId || "").trim();
  if (!origin || !conv) return null;
  const ws = origin.replace(/^http/i, (h) => (h.toLowerCase() === "https" ? "wss" : "ws"));
  const q = new URLSearchParams({ conversation: conv });
  if (token) q.set("token", token);
  return `${ws.replace(/\/$/, "")}/cli/overlay/events?${q.toString()}`;
}
