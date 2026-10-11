// Feedback C3 — pure wire types + list/thread helpers, Node-testable
// with zero imports (the gridConvert.ts idiom): sectioning, badge count,
// event filtering, ages, receipt lines. The fetch layer + fan-out live in
// feedback.ts, which re-exports everything here.

export type FeedbackKind = "question" | "approval" | "fyi";
/** Every status the daemon stores (0.40.95+). The open list is waiting,
 *  answered and needs_discussion; `planned` is closed-ish. A newer daemon
 *  may add more, so every switch below has a default arm. */
export type FeedbackStatus =
  | "waiting"
  | "needs_discussion"
  | "answered"
  | "planned"
  | "resolved"
  | "dismissed";

/** Statuses a person can set from the status menu (`resolve {id,status}`).
 *  `answered` also carries the agreed outcome (`resolve answered+answer`). */
export const SETTABLE_STATUSES: readonly FeedbackStatus[] = [
  "waiting",
  "needs_discussion",
  "answered",
  "planned",
  "resolved",
  "dismissed",
];

export interface FeedbackItem {
  id: string;
  projectId: string;
  sessionId: string | null;
  sessionKind: string | null;
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
  /** 0.43.2+: the ticket has a stored HTML brief. Missing = false. */
  hasBrief?: boolean;
  briefBytes?: number | null;
  /** `list-all` only: false when the workspace was removed (read-only,
   *  Resolve/Dismiss only). Missing = linked. */
  linked?: boolean;
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

/** `show?brief=1` → `brief`. Cleaned HTML, immutable once filed, so it is
 *  fetched once per ticket and cached by `sha256`. */
export interface FeedbackBrief {
  html: string;
  text: string;
  bytes: number;
  sha256: string;
  sanitizer: string;
  createdAt: number;
}

/** The `show` wire shape: the item flat + workspace/projectPath + thread. */
export interface FeedbackShow extends FeedbackItem {
  workspace: string | null;
  projectPath: string | null;
  comments: FeedbackComment[];
  canonicalSessionId?: string | null;
  /** Only with `brief=1`; null when the ticket has none. */
  brief?: FeedbackBrief | null;
}

/** `POST /cli/feedback/comment` response for a HUMAN (author-less)
 *  comment. `answered` = an option pick (`optionPick:true`) answered the
 *  ticket; free text leaves it `needs_discussion`. delivered/deliveryReason
 *  report the best-effort injection into the asking session. */
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

/** Page sectioning, desktop order: Waiting, Needs discussion, Answered,
 *  Planned, Unlinked workspace, then Closed (resolved/dismissed). An open
 *  ticket whose workspace is gone (`linked:false`) goes in `unlinked`, never
 *  `waiting`, so the waiting section still matches the badge. An unknown
 *  status lands in `closed` rather than vanishing. */
export interface GroupedFeedback<T> {
  waiting: T[];
  needs_discussion: T[];
  answered: T[];
  planned: T[];
  unlinked: T[];
  closed: T[];
}

/** True for a row whose workspace was removed (only `list-all` sets it). */
export function isUnlinked(row: { linked?: boolean }): boolean {
  return row.linked === false;
}

/** resolved / dismissed: options disabled, chip muted. */
export function isClosedStatus(status: string): boolean {
  return status === "resolved" || status === "dismissed";
}

export function groupByStatus<T extends { status: FeedbackStatus; linked?: boolean }>(
  rows: T[]
): GroupedFeedback<T> {
  const grouped: GroupedFeedback<T> = {
    waiting: [],
    needs_discussion: [],
    answered: [],
    planned: [],
    unlinked: [],
    closed: [],
  };
  for (const row of rows) {
    if (isUnlinked(row) && !isClosedStatus(row.status)) grouped.unlinked.push(row);
    else if (row.status === "waiting") grouped.waiting.push(row);
    else if (row.status === "needs_discussion") grouped.needs_discussion.push(row);
    else if (row.status === "answered") grouped.answered.push(row);
    else if (row.status === "planned") grouped.planned.push(row);
    else grouped.closed.push(row);
  }
  return grouped;
}

/** Section labels in render order (the Zen list and the classic page). */
export const STATUS_SECTIONS: ReadonlyArray<{
  key: keyof GroupedFeedback<unknown>;
  label: string;
}> = [
  { key: "waiting", label: "Waiting" },
  { key: "needs_discussion", label: "Needs discussion" },
  { key: "answered", label: "Answered" },
  { key: "planned", label: "Planned" },
  { key: "unlinked", label: "Unlinked workspace" },
  { key: "closed", label: "Closed" },
];

/** Human label for a status chip. Unknown values pass through. */
export function statusLabel(status: string): string {
  switch (status) {
    case "waiting":
      return "Waiting";
    case "needs_discussion":
      return "Needs discussion";
    case "answered":
      return "Answered";
    case "planned":
      return "Planned";
    case "resolved":
      return "Resolved";
    case "dismissed":
      return "Dismissed";
    default:
      return String(status || "unknown").replace(/_/g, " ");
  }
}

/** Chip colour: waiting amber, needs_discussion orange, answered green,
 *  planned accent, resolved/dismissed (and anything unknown) muted. */
export function statusColor(status: string): string {
  switch (status) {
    case "waiting":
      return "var(--warning)";
    case "needs_discussion":
      return "#fb923c";
    case "answered":
      return "var(--success)";
    case "planned":
      return "var(--accent)";
    default:
      return "var(--text-muted)";
  }
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
  return filterByAssignees(rows, [assignee]);
}

/** Multi-select people filter. Empty = all. `unassigned` matches empty
 *  assignee sets; other values match if the ticket lists that username. */
export function filterByAssignees<T extends { assignees?: string[] | null }>(
  rows: T[],
  selected: string[],
): T[] {
  const picks = selected.map((s) => s.trim()).filter(Boolean);
  if (picks.length === 0) return rows;
  const wantUnassigned = picks.includes("unassigned");
  const names = picks.filter((s) => s !== "unassigned");
  return rows.filter((r) => {
    const list = r.assignees ?? [];
    if (wantUnassigned && list.length === 0) return true;
    return names.some((n) => list.includes(n));
  });
}

/** Status chips (desktop AFSROW). Counted after search + people filter. */
export type FeedbackStatusFilter = FeedbackStatus | "all";

export function filterByStatus<T extends { status: FeedbackStatus }>(
  rows: T[],
  status: FeedbackStatusFilter,
): T[] {
  if (status === "all") return rows;
  return filterByStatuses(rows, [status]);
}

/** Multi-select status filter. Empty = all. */
export function filterByStatuses<T extends { status: FeedbackStatus }>(
  rows: T[],
  selected: FeedbackStatus[],
): T[] {
  if (selected.length === 0) return rows;
  const set = new Set(selected);
  return rows.filter((r) => set.has(r.status));
}

/** TabBar badge count = linked items still waiting on the human (the
 *  daemon's waiting-count skips unlinked tickets too, 0.43.0+). */
export function countWaiting<T extends { status: FeedbackStatus; linked?: boolean }>(
  rows: T[]
): number {
  return rows.reduce((n, r) => n + (r.status === "waiting" && !isUnlinked(r) ? 1 : 0), 0);
}

/** Option buttons stay live until the ticket is closed: a pick on an
 *  answered or needs_discussion ticket still (re)answers it (0.43.2). */
export function optionsActionable(item: {
  status: FeedbackStatus;
  options: string[] | null;
  linked?: boolean;
}): boolean {
  return (
    !isClosedStatus(item.status) &&
    !isUnlinked(item) &&
    (item.options?.length ?? 0) > 0
  );
}

// ─── Scope tabs (desktop TicketBoard: Waiting on me / Mine / All) ───

export type TicketScope = "waiting" | "mine" | "all";

export const TICKET_SCOPES: ReadonlyArray<{ value: TicketScope; label: string }> = [
  { value: "waiting", label: "Waiting on me" },
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
];

/** Lower-cased assignee names that mean "me". The owner is the wire
 *  literal `owner` plus any display name; a Connect user is their
 *  username. `extra` is the active server's saved username (the fallback
 *  when whoami fails). */
export function myAssigneeNames(
  identity: { owner?: boolean; username?: string | null } | null,
  extra: string[] = []
): string[] {
  const names: string[] = [];
  if (identity?.owner) names.push("owner");
  if (identity?.username) names.push(identity.username);
  for (const e of extra) names.push(e);
  return [
    ...new Set(names.map((n) => (n ?? "").trim().toLowerCase()).filter(Boolean)),
  ];
}

export function isAssignedToMe(
  row: { assignees?: string[] | null },
  me: readonly string[]
): boolean {
  if (me.length === 0) return false;
  return (row.assignees ?? []).some((a) => me.includes(a.trim().toLowerCase()));
}

/** Mine = assigned to me; Waiting on me = mine AND waiting (unlinked rows
 *  never count as waiting); All = everything. */
export function filterByScope<
  T extends { status: FeedbackStatus; assignees?: string[] | null; linked?: boolean },
>(rows: T[], scope: TicketScope, me: readonly string[]): T[] {
  if (scope === "all") return rows;
  const mine = rows.filter((r) => isAssignedToMe(r, me));
  return scope === "waiting"
    ? mine.filter((r) => r.status === "waiting" && !isUnlinked(r))
    : mine;
}

/** Waiting tickets per scope tab, so the tabs answer "where is the
 *  waiting work". Every count is linked `waiting` rows within that
 *  scope: Waiting on me and Mine are both mine ∩ waiting (the same
 *  number, by design); All is every linked waiting row, the server's
 *  `waiting-count` semantics. Unassigned waiting rows count under All
 *  only. Computed from the loaded list with the tabs' own "me" match. */
export function scopeWaitingCounts<
  T extends { status: FeedbackStatus; assignees?: string[] | null; linked?: boolean },
>(rows: T[], me: readonly string[]): Record<TicketScope, number> {
  const mine = filterByScope(rows, "waiting", me).length;
  return { waiting: mine, mine, all: countWaiting(rows) };
}

/** The tab the Tickets list opens on: Waiting on me, unless nothing is
 *  waiting on me but something is waiting elsewhere, so the header badge
 *  never leads to an empty tab. All zero → Waiting on me ("Nothing is
 *  waiting on you"). */
export function defaultTicketScope(counts: Record<TicketScope, number>): TicketScope {
  return counts.waiting === 0 && counts.all > 0 ? "all" : "waiting";
}

/** Header Tickets badge. Semantics: show Waiting on me (amber) when it is
 *  above zero; otherwise show the All waiting count muted (grey), so the
 *  badge still says there is work, just not yours; nothing when nothing
 *  waits. Matches the tab counts and the default tab exactly. */
export interface TicketsBadge {
  count: number;
  tone: "mine" | "others";
}

export function ticketsBadge(counts: Record<TicketScope, number>): TicketsBadge | null {
  if (counts.waiting > 0) return { count: counts.waiting, tone: "mine" };
  if (counts.all > 0) return { count: counts.all, tone: "others" };
  return null;
}

/** "Tickets, 2 waiting on you, 5 waiting in all" (plain "Tickets" when
 *  nothing waits). */
export function ticketsAriaLabel(counts: Record<TicketScope, number>): string {
  if (counts.all === 0 && counts.waiting === 0) return "Tickets";
  const mine = counts.waiting > 0 ? String(counts.waiting) : "none";
  return `Tickets, ${mine} waiting on you, ${counts.all} waiting in all`;
}

/** Up to two initials: "julie" → "J", "Rosson Long" → "RL", owner → "O". */
export function assigneeInitials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

/** Whitespace-collapsed one-liner (card summary, option labels). */
export function collapseWs(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** `/cli/sessions/events` frames that mean "a ticket changed": the
 *  desktop board's `feedback_changed` and the per-mutation
 *  `ticket_changed` (0.43.3+). Frames carry ids only — refetch `show`. */
export function isTicketEventFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  const kind = (frame as { kind?: unknown }).kind;
  return kind === "feedback_changed" || kind === "ticket_changed";
}

/** The delivery receipt after a human comment: null when the agent got
 *  it, else the desktop's "Saved. The agent did not receive it (…)". */
export function deliveryMissLine(res: {
  delivered?: boolean;
  deliveryReason?: string | null;
}): string | null {
  if (res.delivered !== false) return null;
  const reason = (res.deliveryReason ?? "unreachable").replace(/_/g, " ");
  return `Saved. The agent did not receive it (${reason}).`;
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
