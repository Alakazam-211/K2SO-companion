// Feedback C3 — pure wire types + list/thread helpers, Node-testable
// with zero imports (the gridConvert.ts idiom): sectioning, badge count,
// event filtering, ages, receipt lines. The fetch layer + fan-out live in
// feedback.ts, which re-exports everything here.

export type FeedbackKind = "question" | "approval" | "fyi";
export type FeedbackStatus = "waiting" | "answered" | "resolved" | "dismissed";

export interface FeedbackItem {
  id: string;
  projectId: string;
  sessionId: string | null;
  sessionKind: "canonical" | "sandbox" | null;
  agentName: string;
  kind: FeedbackKind;
  title: string;
  body: string | null;
  options: string[] | null;
  priority: number;
  status: FeedbackStatus;
  answer: string | null;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
  commentCount: number;
  /** Username snapshots for push targeting + the people filter. */
  assignees?: string[] | null;
}

/** A list row tagged with the workspace it was fetched for (the list
 *  route is project-scoped; the card shows the workspace name). */
export interface FeedbackListRow extends FeedbackItem {
  projectPath: string;
  projectName: string;
}

/** Thread entry (`show` serializes each comment's created_at as `at`). */
export interface FeedbackComment {
  author: string;
  body: string;
  at: number;
}

/** The `show` wire shape: the item flat + workspace/projectPath + thread. */
export interface FeedbackShow extends FeedbackItem {
  workspace: string | null;
  projectPath: string | null;
  comments: FeedbackComment[];
}

/** `POST /cli/feedback/comment` response for a HUMAN (author-less)
 *  comment. `answered` = this comment auto-answered a waiting
 *  question/approval; delivered/deliveryReason report the best-effort
 *  injection into the asking session. */
export interface CommentResponse {
  ok: boolean;
  id: string;
  commentId: string;
  author: string;
  answered?: boolean;
  status?: FeedbackStatus;
  delivered?: boolean;
  deliveryReason?: string | null;
  deliveredSessionId?: string | null;
}

/** Minimal slice of the workspaces store the fan-out needs. */
export interface FeedbackProjectRef {
  name: string;
  path: string;
}

// ─── Pure helpers (unit-checked in scripts/test-feedback-pure.mjs) ───

export function sortNewestFirst<T extends { createdAt: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt);
}

/** Page sectioning: Waiting is the prominent section; Answered and
 *  Closed (resolved/dismissed) stay accessible below — the desktop's
 *  groupByStatus, section-header form (simpler than filter chips). */
export interface GroupedFeedback<T> {
  waiting: T[];
  answered: T[];
  closed: T[];
}

export function groupByStatus<T extends { status: FeedbackStatus }>(
  rows: T[]
): GroupedFeedback<T> {
  const grouped: GroupedFeedback<T> = { waiting: [], answered: [], closed: [] };
  for (const row of rows) {
    if (row.status === "waiting") grouped.waiting.push(row);
    else if (row.status === "answered") grouped.answered.push(row);
    else grouped.closed.push(row);
  }
  return grouped;
}

/** Tokenized live search (the desktop feedback-api `filterBySearch`
 *  semantics, plus `body` — mobile has no separate detail pane, so the
 *  body must be findable from the list): every whitespace-separated term
 *  must appear somewhere in the row's haystack. Empty query = no filter. */
export function filterBySearch<
  T extends Pick<
    FeedbackListRow,
    "id" | "title" | "body" | "agentName" | "projectName" | "kind" | "status"
  > & { assignees?: string[] | null },
>(rows: T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((r) => {
    const haystack = [
      r.title,
      r.body ?? "",
      r.agentName,
      r.projectName,
      r.kind,
      r.status,
      r.id,
      ...(r.assignees ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** List sort orders (applied WITHIN each status section — the page's
 *  Waiting-first sectioning always wins over the chosen sort). */
export type FeedbackSortKey = "newest" | "oldest" | "priority" | "workspace";

export function sortRows<
  T extends Pick<FeedbackListRow, "createdAt" | "priority" | "projectName">,
>(rows: T[], key: FeedbackSortKey): T[] {
  const byNewest = (a: T, b: T) => b.createdAt - a.createdAt;
  const sorted = [...rows];
  switch (key) {
    case "oldest":
      return sorted.sort((a, b) => a.createdAt - b.createdAt);
    case "priority": // P1 first; newest breaks ties
      return sorted.sort((a, b) => a.priority - b.priority || byNewest(a, b));
    case "workspace": // A–Z case-insensitive; newest breaks ties
      return sorted.sort(
        (a, b) =>
          a.projectName.localeCompare(b.projectName, undefined, { sensitivity: "base" }) ||
          byNewest(a, b)
      );
    case "newest":
    default:
      return sorted.sort(byNewest);
  }
}

/** People-filter values for the board dropdown. */
export type AssigneeFilter = "all" | "unassigned" | string;

/** Unique assignee usernames across rows, sorted A–Z. */
export function collectAssignees<T extends { assignees?: string[] | null }>(
  rows: T[],
): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    for (const name of row.assignees ?? []) {
      const t = name.trim();
      if (t) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** `all` = no filter; `unassigned` = empty assignee set; else username. */
export function filterByAssignee<T extends { assignees?: string[] | null }>(
  rows: T[],
  assignee: AssigneeFilter,
): T[] {
  if (assignee === "all") return rows;
  if (assignee === "unassigned") {
    return rows.filter((r) => (r.assignees?.length ?? 0) === 0);
  }
  return rows.filter((r) => (r.assignees ?? []).includes(assignee));
}

/** Status chips (desktop AFSROW). Counted after search + people filter. */
export type FeedbackStatusFilter = FeedbackStatus | "all";

export function filterByStatus<T extends { status: FeedbackStatus }>(
  rows: T[],
  status: FeedbackStatusFilter,
): T[] {
  if (status === "all") return rows;
  return rows.filter((r) => r.status === status);
}

/** TabBar badge count = items still waiting on the human. */
export function countWaiting<T extends { status: FeedbackStatus }>(rows: T[]): number {
  return rows.reduce((n, r) => n + (r.status === "waiting" ? 1 : 0), 0);
}

/** One-tap option buttons are live only while the ask still waits. */
export function optionsActionable(item: {
  status: FeedbackStatus;
  options: string[] | null;
}): boolean {
  return item.status === "waiting" && (item.options?.length ?? 0) > 0;
}

/** Which surfaces a `/events` frame refreshes. `created` lands new list
 *  rows + the badge; `commented` only bumps the open thread;
 *  `answered`/`status-changed` move items between sections AND change
 *  the open thread's chip. Non-feedback events → null (ignored). */
export function feedbackEventTargets(
  event: string
): { list: boolean; thread: boolean } | null {
  switch (event) {
    case "feedback:created":
      return { list: true, thread: false };
    case "feedback:commented":
      return { list: false, thread: true };
    case "feedback:answered":
    case "feedback:status-changed":
      return { list: true, thread: true };
    default:
      return null;
  }
}

/** Compact relative age for cards/bubbles ("now", "5m", "3h", "2d").
 *  Timestamps are unix SECONDS (k2-core serde). */
export function relativeAge(atSec: number, nowSec: number = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor(nowSec - atSec));
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

/** The composer receipt line from a comment response's delivery fields:
 *  "sent to <agent>'s session" or the failure variant with the daemon's
 *  reason (session_gone / workspace_not_found / pty_died / …). */
export function deliveredLine(
  agentName: string,
  delivered: boolean | undefined,
  deliveryReason: string | null | undefined
): string {
  if (delivered) return `sent to ${agentName}'s session`;
  const reason = (deliveryReason ?? "unreachable").replace(/_/g, " ");
  return `saved to the thread — not delivered (${reason})`;
}
