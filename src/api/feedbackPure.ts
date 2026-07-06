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
