// Pure logic for the mobile Projects page (slice C2) — the companion port
// of the desktop's `components/Projects/project-chat.ts` paging/merge/
// receipt semantics, plus the avatar-fallback + relative-time + html-doc
// grouping helpers the pages render from.
//
// IMPORT-SAFE: no tauri / DOM / store imports (type-only imports are
// erased at compile time), so everything here can run under a plain Node
// test runner later (the repo's future-vitest rule).

import type {
  ProjectGroupHtmlDoc,
  ProjectGroupMemberInfo,
  ProjectGroupMessage,
} from "../api/projectGroups";

// ── Paging (mirror of desktop project-chat.ts) ─────────────────────────

/** The chat-open tail (the daemon's no-`after` default). */
export const MESSAGES_DEFAULT_LIMIT = 20;
/** The daemon caps every page at 500. */
export const MESSAGES_MAX_LIMIT = 500;
/** Each "load earlier" widens the tail window by this much. */
export const EARLIER_PAGE_STEP = 100;

/** The next no-`after` window size after a load-earlier gesture. The
 *  route has no `before` param — earlier history is read by re-reading
 *  the LATEST-N tail with a bigger N, capped at the daemon's 500. */
export function nextEarlierLimit(current: number): number {
  return Math.min(current + EARLIER_PAGE_STEP, MESSAGES_MAX_LIMIT);
}

/** Whether load-earlier still has anywhere to go: the last page was
 *  truncated AND the window can still widen. At the 500 ceiling the
 *  screen shows its "earliest not shown" note instead. */
export function canLoadEarlier(limit: number, truncated: boolean): boolean {
  return truncated && limit < MESSAGES_MAX_LIMIT;
}

/** Merge a freshly-fetched page into what the screen already renders.
 *
 *  `incoming` is an AUTHORITATIVE oldest-first tail (the daemon's
 *  latest-N window), so it wins verbatim; existing rows survive only as
 *  a PREFIX — rows that slid out of the fetched window (the user had
 *  "loaded earlier", then a live refetch used a smaller window). A row
 *  already in `incoming` is deduped by id; the createdAt boundary keeps
 *  the prefix strictly at-or-before the window's head. An anomalous
 *  empty page never wipes loaded history. */
export function mergeMessages(
  existing: ProjectGroupMessage[],
  incoming: ProjectGroupMessage[]
): ProjectGroupMessage[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  const ids = new Set(incoming.map((m) => m.id));
  const head = incoming[0];
  const prefix = existing.filter(
    (m) => !ids.has(m.id) && m.createdAt <= head.createdAt
  );
  return [...prefix, ...incoming];
}

// ── PoC + delivered receipt (desktop §6.4 mapping) ─────────────────────

/** The PoC's display label: the member's agent display name, falling
 *  back to its workspace name; null when the group is memberless or the
 *  PoC row is missing/unregistered. */
export function pocLabel(
  members: ProjectGroupMemberInfo[],
  pocWorkspaceId: string | null
): string | null {
  if (!pocWorkspaceId) return null;
  const m = members.find((x) => x.workspaceId === pocWorkspaceId);
  if (!m) return null;
  return m.agentName ?? m.name ?? null;
}

/** The composer placeholder — "Message <PoC agent name>", or "Message
 *  the PoC" when the group has no PoC / the PoC row is unresolvable. */
export function composerPlaceholder(
  members: ProjectGroupMemberInfo[],
  pocWorkspaceId: string | null
): string {
  const label = pocLabel(members, pocWorkspaceId);
  return label !== null ? `Message ${label}` : "Message the PoC";
}

/** The receipt line under a just-sent message, from the msg response's
 *  delivery outcome. `author-is-poc` shouldn't occur for owner posts —
 *  handled gracefully as "nothing to report". */
export function deliveredLine(
  delivered: boolean,
  deliveryReason: string | null,
  poc: string | null
): string | null {
  if (delivered) return `delivered to ${poc ?? "the PoC"}`;
  if (deliveryReason === "author-is-poc") return null;
  if (deliveryReason === "no_poc") return "stored — no Point of Contact yet";
  return "PoC session unreachable";
}

// ── Avatar fallback (desktop ProjectGroupAvatar palette + hash) ────────

/** The same default palette workspaces offer, so projects and
 *  workspaces share one color language across desktop + mobile. */
export const GROUP_AVATAR_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#ec4899",
  "#06b6d4",
  "#64748b",
];

/** Stable per-group fallback color: FNV-ish hash of the group id →
 *  palette (identical to the desktop's, so both surfaces agree). */
export function groupAvatarColor(groupId: string): string {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) {
    h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  }
  return GROUP_AVATAR_COLORS[h % GROUP_AVATAR_COLORS.length];
}

/** The initials-fallback glyph: the group name's first character. */
export function groupInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

// ── Icon cache keying (host:group, the desktop group-icon-cache idiom) ─

/** Per-server icon cache key — a group's icon on server A must never
 *  render for the same UUID seen through server B. */
export function iconCacheKey(serverId: string, groupId: string): string {
  return `${serverId}:${groupId}`;
}

// ── Relative time (companion-local; desktop uses ops-api's) ────────────

/** Compact relative time for chat bubbles: "now", "5m", "3h", "2d",
 *  falling back to a date for anything older than a week. */
export function formatRelativeTime(tsSec: number, nowSec: number): string {
  const delta = Math.max(0, nowSec - tsSec);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d`;
  const d = new Date(tsSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// ── HTML-docs grouping (browser list sections) ─────────────────────────

export interface HtmlDocWorkspaceSection {
  workspaceId: string;
  workspaceName: string;
  docs: ProjectGroupHtmlDoc[];
}

/** Group the html-docs rows by workspace, preserving the daemon's
 *  member order (rows arrive member-ordered and deduped). */
export function groupHtmlDocsByWorkspace(
  docs: ProjectGroupHtmlDoc[]
): HtmlDocWorkspaceSection[] {
  const sections: HtmlDocWorkspaceSection[] = [];
  const byId = new Map<string, HtmlDocWorkspaceSection>();
  for (const doc of docs) {
    let section = byId.get(doc.workspaceId);
    if (!section) {
      section = {
        workspaceId: doc.workspaceId,
        workspaceName: doc.workspaceName ?? "Unknown workspace",
        docs: [],
      };
      byId.set(doc.workspaceId, section);
      sections.push(section);
    }
    section.docs.push(doc);
  }
  return sections;
}
