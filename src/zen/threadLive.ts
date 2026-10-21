import { attachmentsKey } from "../api/threadAttachmentPure";
import type { ThreadMessage } from "./threadModel";

/** Append unseen items. Same array reference when nothing new. */
export function mergeThreadMessages(
  current: ThreadMessage[],
  incoming: ThreadMessage[],
  opts: { refreshFiles?: boolean } = {}
): ThreadMessage[] {
  if (!incoming.length) return current;
  const at = new Map<string, number>();
  current.forEach((m, i) => {
    if (m.id) at.set(m.id, i);
  });
  let next = current;
  // A re-read (`GET /cli/thread`) recomputes each file's state (ok /
  // changed / gone / hidden): take it for messages already on screen.
  // Live frames always say "ok" (post time), so they never overwrite.
  if (opts.refreshFiles) {
    for (const m of incoming) {
      const i = m.id ? at.get(m.id) : undefined;
      if (i == null) continue;
      const cur = next[i];
      if (attachmentsKey(cur.files) === attachmentsKey(m.files)) continue;
      if (next === current) next = [...current];
      next[i] = { ...cur, files: m.files };
    }
  }
  const extra = incoming.filter((m) => m.id && !at.has(m.id));
  if (!extra.length) return next;
  return [...next, ...extra].sort(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
  );
}

export function overlayEventsUrl(
  base: string,
  token: string,
  conversationId: string,
  opts: { cards2?: boolean } = {}
): string | null {
  const origin = (base || "").trim();
  const conv = (conversationId || "").trim();
  if (!origin || !conv) return null;
  const ws = origin.replace(/^http/i, (h) => (h.toLowerCase() === "https" ? "wss" : "ws"));
  const q = new URLSearchParams({ conversation: conv });
  if (token) q.set("token", token);
  // K2 0.46.3 permission cards: card rewrites as the rich doc.
  if (opts.cards2) q.set("cards", "2");
  return `${ws.replace(/\/$/, "")}/cli/overlay/events?${q.toString()}`;
}
