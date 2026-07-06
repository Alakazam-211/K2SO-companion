import { useEffect, useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { useServersStore } from "../stores/servers";
import { useFeedbackStore } from "../stores/feedback";
import {
  groupByStatus,
  relativeAge,
  type FeedbackKind,
  type FeedbackListRow,
  type FeedbackStatus,
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
    <span className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wide border ${color}`}>
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
    <span className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wide border ${color}`}>
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
  return <span className={`text-[9px] tabular-nums ${color}`}>P{priority}</span>;
}

// ─── List ───

function Card({ row, nowSec }: { row: FeedbackListRow; nowSec: number }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(`/feedback/${row.id}`)}
      className="flex flex-col gap-1.5 mx-3 mb-2 px-4 py-3 bg-[var(--surface)] border border-[var(--border)] text-left hover:border-[var(--border-hover)] transition-colors"
    >
      <div className="flex items-baseline gap-2 w-full">
        <span className="text-[var(--text)] text-[13px] font-medium truncate flex-1">
          {row.title}
        </span>
        <span className="text-[var(--text-muted)] text-[10px] tabular-nums shrink-0">
          {relativeAge(row.createdAt, nowSec)}
        </span>
      </div>
      <div className="flex items-center gap-2 w-full">
        <span className="text-[var(--text-muted)] text-[10px] truncate flex-1">
          {row.projectName} · {row.agentName}
          {row.commentCount > 1 ? ` · ${row.commentCount} msgs` : ""}
        </span>
        <PriorityTag priority={row.priority} />
        <KindTag kind={row.kind} />
        <StatusTag status={row.status} />
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
      <div className="px-4 pt-3 pb-2 text-[var(--text-muted)] text-[10px] uppercase tracking-wide">
        {label} · {rows.length}
      </div>
      {rows.map((row) => (
        <Card key={row.id} row={row} nowSec={nowSec} />
      ))}
    </>
  );
}

function FeedbackList() {
  const activeServerId = useServersStore((s) => s.activeServerId);
  const rows = useFeedbackStore((s) => s.rows);
  const isLoading = useFeedbackStore((s) => s.isLoading);
  const error = useFeedbackStore((s) => s.error);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);

  // First load + events WS for the active server; refetch on server switch.
  useEffect(() => {
    useFeedbackStore.getState().ensureLive();
  }, [activeServerId]);

  // Keep the relative ages honest while the page sits open.
  useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now() / 1000), 30000);
    return () => clearInterval(t);
  }, []);

  const grouped = groupByStatus(rows);

  return (
    <div className="flex flex-col h-full">
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

      <div className="flex-1 overflow-y-auto pb-2">
        {error && (
          <div className="mx-3 mt-3 px-4 py-3 border border-[var(--error)]/40 text-[var(--error)] text-[11px] leading-5">
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
        ) : (
          <>
            <Section label="Waiting on you" rows={grouped.waiting} nowSec={nowSec} />
            <Section label="Answered" rows={grouped.answered} nowSec={nowSec} />
            <Section label="Closed" rows={grouped.closed} nowSec={nowSec} />
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
