import { getLastSeen, setLastSeen } from "../stores/projectGroups";
import { lastAtKey, sortChatsByRecency } from "./lastAtFetch";

// Zen Projects sheet + the Agents header's Projects badge.
//
// A project chat is a project group's shared chat. Unread uses the same
// per-server last-seen cursors as the classic Projects page
// (`k2_pg_seen.<server>.<group>`): a group is unread when its newest
// message is newer than the cursor. The newest-message time is the
// Agents list's own group last-at, `<serverId>|g:<id>` (MA6; no extra
// request for the badge).

/** Newest message of one group, for the sheet's second line. */
export type GroupPreview = { at: number; author: string; body: string };

/** `{"kind":"project_groups_changed","reason":…}` on `/cli/sessions/events`:
 *  the app-level twin of every `project-group:*` hook (message, members,
 *  PoC, structure). A refetch signal; no payload worth reading. */
export function isProjectGroupsChangedFrame(frame: unknown): boolean {
  return (
    !!frame &&
    typeof frame === "object" &&
    (frame as { kind?: unknown }).kind === "project_groups_changed"
  );
}

export function groupLastAtOf(
  lastAtByKey: Record<string, number | null>,
  serverId: string | null | undefined,
  groupId: string
): number | null {
  if (!serverId) return null;
  const at = lastAtByKey[lastAtKey(serverId, "group", groupId)];
  return typeof at === "number" ? at : null;
}

export function isGroupUnread(
  serverId: string | null | undefined,
  groupId: string,
  lastAt: number | null | undefined
): boolean {
  if (!serverId || typeof lastAt !== "number") return false;
  return lastAt > getLastSeen(serverId, groupId);
}

/** How many project chats have a message newer than this device saw. */
export function unreadGroupCount(
  serverId: string | null | undefined,
  groupIds: string[],
  lastAtByKey: Record<string, number | null>
): number {
  let n = 0;
  for (const id of new Set(groupIds)) {
    if (isGroupUnread(serverId, id, groupLastAtOf(lastAtByKey, serverId, id))) n += 1;
  }
  return n;
}

/** The chat is on screen: everything up to `lastAt` (else now) is seen. */
export function markGroupSeenAt(
  serverId: string | null | undefined,
  groupId: string,
  lastAt?: number | null
): void {
  if (!serverId || !groupId) return;
  const now = Math.floor(Date.now() / 1000);
  setLastSeen(serverId, groupId, Math.max(now, typeof lastAt === "number" ? lastAt : 0));
}

/** Newest activity first; groups with no messages keep the daemon's order
 *  (pinned, then sort order) at the bottom. */
export function sortGroupsByRecency<T extends { id: string }>(
  groups: T[],
  lastAtByKey: Record<string, number | null>,
  serverId: string | null | undefined
): T[] {
  return sortChatsByRecency(groups, lastAtByKey, (g) =>
    serverId ? lastAtKey(serverId, "group", g.id) : null
  );
}

/** Second line: `author: body`, one line. */
export function groupPreviewText(p: GroupPreview | null | undefined): string {
  if (!p) return "";
  const body = p.body.replace(/\s+/g, " ").trim();
  if (!body) return "";
  const author = p.author.trim();
  return author ? `${author}: ${body}` : body;
}

export function memberCountText(n: number | null | undefined): string {
  const c = typeof n === "number" && n > 0 ? n : 0;
  return c === 1 ? "1 member" : `${c} members`;
}
