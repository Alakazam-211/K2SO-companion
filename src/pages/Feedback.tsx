import { useEffect, useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { useServersStore } from "../stores/servers";
import { useFeedbackStore } from "../stores/feedback";
import {
  collectAssignees,
  filterByAssignee,
  filterBySearch,
  filterByStatus,
  groupByStatus,
  relativeAge,
  sortRows,
  type AssigneeFilter,
  type FeedbackKind,
  type FeedbackListRow,
  type FeedbackSortKey,
  type FeedbackStatus,
  type FeedbackStatusFilter,
} from "../api/feedback";
import { FeedbackThread } from "./FeedbackThread";

// Feedback C3 — the `/feedback` tab: every workspace's feedback items for
// the ACTIVE server, Waiting first (the items blocking an agent), then
// Answered, then Closed (resolved/dismissed). Tapping a card opens the
// thread sub-route (`/feedback/:id` — nested below), which hides the tab
// chrome like /chat/:id does. Live updates + the TabBar waiting badge ride
// the feedback store's own `/events` subscription.

export function Feedback() {
  return (
    <Routes>
      <Route index element={<FeedbackList />} />
      <Route path=":id" element={<FeedbackThread />} />
    </Routes>
  );
}

// ─── Badges (desktop badges.tsx conventions on companion theme vars) ───

export function KindTag({ kind }: { kind: FeedbackKind }) {
  const color =
    kind === "approval"
      ? "text-[var(--warning)] border-[var(--warning)]/40"
      : kind === "fyi"
        ? "text-[var(--text-muted)] border-[var(--border-hover)]"
        : "text-[var(--accent)] border-[var(--accent-dim)]";
  return (
    <span className={`px-2 py-1 text-[10px] uppercase tracking-wide border ${color}`}>
      {kind}
    </span>
  );
}

export function StatusTag({ status }: { status: FeedbackStatus }) {
  const color =
    status === "waiting"
      ? "text-[var(--warning)] border-[var(--warning)]/40"
      : status === "answered"
        ? "text-[var(--success)] border-[var(--success)]/40"
        : "text-[var(--text-muted)] border-[var(--border-hover)]";
  return (
    <span className={`px-2 py-1 text-[10px] uppercase tracking-wide border ${color}`}>
      {status}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: number }) {
  const color =
    priority <= 1
      ? "text-[var(--error)]"
      : priority === 2
        ? "text-[var(--warning)]"
        : "text-[var(--text-muted)]";
  return <span className={`text-[11px] tabular-nums ${color}`}>P{priority}</span>;
}

// ─── List ───

function Card({ row, nowSec }: { row: FeedbackListRow; nowSec: number }) {
  const navigate = useNavigate();
  // Overflow containment: min-w-0 down the flex chain + line-clamps +
  // overflow-wrap:anywhere so unbroken strings (URLs, ids) wrap inside
  // the card instead of forcing horizontal page scroll.
  return (
    <button
      onClick={() => navigate(`/feedback/${row.id}`)}
      className="flex flex-col gap-2.5 w-full min-w-0 overflow-hidden px-4 py-4 bg-[var(--surface)] border border-[var(--border)] text-left hover:border-[var(--border-hover)] transition-colors"
    >
      <div className="flex items-baseline gap-3 w-full min-w-0">
        <span className="text-[var(--text)] text-[15px] font-medium leading-6 flex-1 min-w-0 line-clamp-2 break-words [overflow-wrap:anywhere]">
          {row.title}
        </span>
        <span className="text-[var(--text-muted)] text-[11px] tabular-nums shrink-0">
          {relativeAge(row.createdAt, nowSec)}
        </span>
      </div>
      {row.body && (
        <div className="w-full min-w-0 text-[var(--text-secondary)] text-[13px] leading-5 line-clamp-2 break-words [overflow-wrap:anywhere]">
          {row.body}
        </div>
      )}
      <div className="flex items-center gap-2 w-full min-w-0 flex-wrap pt-0.5">
        <span className="text-[var(--text-muted)] text-[11px] truncate min-w-0 flex-1 basis-32">
          {row.projectName} · {row.agentName}
          {(row.assignees?.length ?? 0) > 0 ? ` · → ${row.assignees!.join(", ")}` : ""}
          {row.commentCount > 1 ? ` · ${row.commentCount} msgs` : ""}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <PriorityTag priority={row.priority} />
          <KindTag kind={row.kind} />
          <StatusTag status={row.status} />
        </span>
      </div>
    </button>
  );
}

function Section({
  label,
  rows,
  nowSec,
}: {
  label: string;
  rows: FeedbackListRow[];
  nowSec: number;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="pt-5 pb-2.5 text-[var(--text-muted)] text-[11px] uppercase tracking-wide">
        {label} · {rows.length}
      </div>
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <Card key={row.id} row={row} nowSec={nowSec} />
        ))}
      </div>
    </>
  );
}

// ─── Search + sort controls (desktop FeedbackPage parity, mobile form) ───

const SORT_OPTIONS: Array<{ key: FeedbackSortKey; label: string }> = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "priority", label: "Priority" },
  { key: "workspace", label: "Workspace" },
];

const STATUS_CHIPS: Array<{ key: FeedbackStatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "waiting", label: "Waiting" },
  { key: "answered", label: "Answered" },
  { key: "resolved", label: "Resolved" },
  { key: "dismissed", label: "Dismissed" },
];

function PeopleFilter({
  value,
  options,
  onChange,
}: {
  value: AssigneeFilter;
  options: string[];
  onChange: (v: AssigneeFilter) => void;
}) {
  return (
    <select
      aria-label="Filter by person"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`flex-1 min-w-0 bg-[var(--background)] border px-3 py-2.5 text-[13px] ${
        value === "all"
          ? "border-[var(--border)] text-[var(--text-secondary)]"
          : "border-[var(--accent-dim)] text-[var(--accent)]"
      }`}
    >
      <option value="all">All people</option>
      <option value="unassigned">Unassigned</option>
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

function ListControls({
  query,
  onQuery,
  sortKey,
  onSortKey,
  assignee,
  onAssignee,
  assigneeOptions,
  status,
  onStatus,
  statusCounts,
}: {
  query: string;
  onQuery: (q: string) => void;
  sortKey: FeedbackSortKey;
  onSortKey: (k: FeedbackSortKey) => void;
  assignee: AssigneeFilter;
  onAssignee: (v: AssigneeFilter) => void;
  assigneeOptions: string[];
  status: FeedbackStatusFilter;
  onStatus: (s: FeedbackStatusFilter) => void;
  statusCounts: Record<FeedbackStatusFilter, number>;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 pt-3 pb-3 border-b border-[var(--border)] shrink-0">
      <div className="relative">
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search title, agent, workspace, person…"
          className="w-full bg-[var(--background)] border border-[var(--border)] px-3 py-2.5 pr-8 text-[var(--text)] text-[14px] focus:outline-none focus:border-[var(--accent-dim)]"
        />
        {query !== "" && (
          <button
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="absolute right-0 top-0 h-full w-8 flex items-center justify-center text-[var(--text-muted)]"
          >
            ✕
          </button>
        )}
      </div>
      <PeopleFilter
        value={assignee}
        options={assigneeOptions}
        onChange={onAssignee}
      />
      <div className="flex gap-1.5 flex-wrap">
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => onSortKey(opt.key)}
            className={`px-2.5 py-1.5 text-[11px] border transition-colors ${
              sortKey === opt.key
                ? "text-[var(--accent)] border-[var(--accent-dim)]"
                : "text-[var(--text-muted)] border-[var(--border)]"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {STATUS_CHIPS.map((chip) => {
          const active = status === chip.key;
          return (
            <button
              key={chip.key}
              onClick={() => onStatus(chip.key)}
              className={`px-2.5 py-1.5 text-[11px] border ${
                active
                  ? "text-[var(--accent)] border-[var(--accent-dim)]"
                  : "text-[var(--text-muted)] border-[var(--border)]"
              }`}
            >
              {chip.label}
              <span className="tabular-nums ml-1 opacity-70">
                {statusCounts[chip.key] ?? 0}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FeedbackList() {
  const activeServerId = useServersStore((s) => s.activeServerId);
  const rows = useFeedbackStore((s) => s.rows);
  const isLoading = useFeedbackStore((s) => s.isLoading);
  const error = useFeedbackStore((s) => s.error);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<FeedbackSortKey>("newest");
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [status, setStatus] = useState<FeedbackStatusFilter>("all");

  // First load + events WS for the active server; refetch on server switch.
  useEffect(() => {
    useFeedbackStore.getState().ensureLive();
  }, [activeServerId]);

  // Keep the relative ages honest while the page sits open.
  useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now() / 1000), 30000);
    return () => clearInterval(t);
  }, []);

  // Desktop pipeline: people → search → status chips; sections still
  // Waiting-first for the "all" chip.
  const byPerson = filterByAssignee(rows, assignee);
  const searched = filterBySearch(byPerson, query);
  const assigneeOptions = collectAssignees(rows);
  const statusCounts = {
    all: searched.length,
    waiting: searched.filter((r) => r.status === "waiting").length,
    answered: searched.filter((r) => r.status === "answered").length,
    resolved: searched.filter((r) => r.status === "resolved").length,
    dismissed: searched.filter((r) => r.status === "dismissed").length,
  };
  const filtered = filterByStatus(searched, status);
  const grouped = groupByStatus(filtered);

  return (
    <div className="flex flex-col h-full min-w-0 overflow-x-hidden">
      {/* Page header (Servers-page idiom) with the refresh affordance. */}
      <div className="flex items-center px-4 py-3 border-b border-[var(--border)] shrink-0">
        <h1 className="text-[var(--accent)] text-[15px] font-bold tracking-wide flex-1">
          Feedback
        </h1>
        <button
          onClick={() => void useFeedbackStore.getState().refresh()}
          className="w-8 h-8 flex items-center justify-center text-[var(--text-muted)]"
          style={isLoading ? { animation: "spin 1s linear infinite" } : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
        </button>
      </div>

      {activeServerId && rows.length > 0 && (
        <ListControls
          query={query}
          onQuery={setQuery}
          sortKey={sortKey}
          onSortKey={setSortKey}
          assignee={assignee}
          onAssignee={setAssignee}
          assigneeOptions={assigneeOptions}
          status={status}
          onStatus={setStatus}
          statusCounts={statusCounts}
        />
      )}

      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pb-6">
        {error && (
          <div className="mt-3 px-4 py-3 border border-[var(--error)]/40 text-[var(--error)] text-[11px] leading-5">
            {error}
            <button
              onClick={() => void useFeedbackStore.getState().refresh()}
              className="block mt-1 underline text-[var(--text-secondary)]"
            >
              Retry
            </button>
          </div>
        )}

        {!activeServerId ? (
          <EmptyState
            title="No server connected"
            detail="Pick a server on the Servers tab to see its feedback."
          />
        ) : rows.length === 0 && !error ? (
          isLoading ? (
            <div className="flex items-center justify-center pt-16 text-[var(--text-muted)] text-[11px]">
              Loading feedback…
            </div>
          ) : (
            <EmptyState
              title="No feedback yet"
              detail="Questions and approvals your agents raise with `k2 feedback ask` will land here."
            />
          )
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center pt-16 text-[var(--text-muted)] text-[11px] px-6 text-center">
            No feedback matches those filters
          </div>
        ) : (
          <>
            <Section
              label="Waiting on you"
              rows={sortRows(grouped.waiting, sortKey)}
              nowSec={nowSec}
            />
            <Section
              label="Answered"
              rows={sortRows(grouped.answered, sortKey)}
              nowSec={nowSec}
            />
            <Section
              label="Closed"
              rows={sortRows(grouped.closed, sortKey)}
              nowSec={nowSec}
            />
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center pt-20 px-8 gap-3">
      <svg
        width="36"
        height="36"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--text-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <h2 className="text-[var(--text)] text-[14px] font-semibold">{title}</h2>
      <p className="text-[var(--text-muted)] text-[11px] text-center leading-5">{detail}</p>
    </div>
  );
}
