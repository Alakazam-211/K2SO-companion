import { useEffect, useState } from "react";
import {
  assigneeInitials,
  collapseWs,
  filterByScope,
  groupByStatus,
  isUnlinked,
  myAssigneeNames,
  relativeAge,
  STATUS_SECTIONS,
  TICKET_SCOPES,
  type FeedbackListRow,
  type TicketScope,
} from "../api/feedback";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { connectTicketEvents } from "./ticketEvents";
import { StatusChip, TicketView } from "./TicketView";

// Zen Tickets: the list (glass header + Done, scope tabs, status sections
// of `.k2-tile` cards) and the open ticket (TicketView, Layout A).
//
// Scope tabs are the desktop board's: Waiting on me (default) = assigned
// to me AND waiting; Mine = assigned to me; All. "Me" is whoami (owner →
// `owner`, a Connect user → their username) plus the active server's
// saved username, matched case-insensitively.
//
// Live: while this overlay is open the list and the open ticket refetch
// (plain `show`, never the brief) on `/cli/sessions/events` ticket frames
// (debounced 300 ms, ticketEvents.ts), every 15 s, and when the app comes
// back to the foreground.

export const TICKETS_POLL_MS = 15_000;

function refetchLive(): void {
  void useFeedbackStore.getState().refresh();
  void useFeedbackStore.getState().refetchOpen();
}

export function TicketsOverlay({ onClose }: { onClose: () => void }) {
  const rows = useFeedbackStore((s) => s.rows);
  const isLoading = useFeedbackStore((s) => s.isLoading);
  const error = useFeedbackStore((s) => s.error);
  const identity = useSessionIdentity();
  const serverUser = useServersStore(
    (s) => s.servers.find((x) => x.id === s.activeServerId)?.username ?? ""
  );
  const [scope, setScope] = useState<TicketScope>("waiting");
  const [openId, setOpenId] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);

  useEffect(() => {
    useFeedbackStore.getState().ensureLive();
    const live = connectTicketEvents(refetchLive);
    const poll = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        refetchLive();
      }
    }, TICKETS_POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") refetchLive();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      live.stop();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVis);
      // Done with a ticket still open: stop refetching it.
      useFeedbackStore.getState().closeThread();
    };
  }, []);

  const me = myAssigneeNames(identity, serverUser ? [serverUser] : []);
  const visible = filterByScope(rows, scope, me);
  const grouped = groupByStatus(visible);
  const openRow = openId ? rows.find((r) => r.id === openId) : undefined;

  const open = (row: FeedbackListRow) => {
    setOpenId(row.id);
    void useFeedbackStore.getState().openThread(row.id, { withBrief: row.hasBrief === true });
  };

  const back = () => {
    setOpenId(null);
    useFeedbackStore.getState().closeThread();
  };

  const emptyText =
    scope === "waiting"
      ? "Nothing is waiting on you"
      : scope === "mine"
        ? "Nothing is assigned to you"
        : "No tickets yet";

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="overlay-tickets"
    >
      <div
        className="grid items-center shrink-0"
        style={{
          gridTemplateColumns: "1fr auto 1fr",
          minHeight: 44,
          padding: "12px 12px 8px",
          columnGap: 8,
        }}
      >
        <button
          type="button"
          className="text-[17px] justify-self-start zen-glass zen-glass-pill"
          style={{ minHeight: 34, padding: "0 14px", color: "#fff" }}
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="text-[17px] font-semibold pointer-events-none">Tickets</h1>
        <span />
      </div>
      <div className="shrink-0 px-3 pb-2">
        <div
          role="tablist"
          aria-label="Ticket scope"
          className="flex zen-glass zen-glass-pill"
          style={{ padding: 3 }}
          data-testid="ticket-scopes"
        >
          {TICKET_SCOPES.map((s) => {
            const on = s.value === scope;
            return (
              <button
                key={s.value}
                type="button"
                role="tab"
                aria-selected={on}
                data-testid={`scope-${s.value}`}
                onClick={() => setScope(s.value)}
                className="flex-1 text-[14px] font-medium border-0 rounded-full"
                style={{
                  height: 30,
                  color: on ? "#fff" : "#a1a1aa",
                  background: on ? "rgba(255,255,255,0.18)" : "transparent",
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "0 12px 24px", WebkitOverflowScrolling: "touch" }}
      >
        {error ? (
          <p className="py-4 text-[14px]" style={{ color: "#f59e0b" }}>
            {error}
          </p>
        ) : null}
        {isLoading && rows.length === 0 ? (
          <p className="py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            Loading tickets…
          </p>
        ) : null}
        {!(isLoading && rows.length === 0) && !error && visible.length === 0 ? (
          <p className="py-10 text-center text-[15px]" style={{ color: "#8e8e93" }} data-testid="tickets-empty">
            {emptyText}
          </p>
        ) : null}
        {STATUS_SECTIONS.map((sec) => (
          <TicketSection
            key={sec.key}
            label={sec.label}
            rows={grouped[sec.key]}
            nowSec={nowSec}
            onOpen={open}
          />
        ))}
      </div>
      {openId ? (
        <TicketView id={openId} linked={!openRow || !isUnlinked(openRow)} onBack={back} />
      ) : null}
    </div>
  );
}

function TicketSection({
  label,
  rows,
  nowSec,
  onOpen,
}: {
  label: string;
  rows: FeedbackListRow[];
  nowSec: number;
  onOpen: (row: FeedbackListRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="pt-3" data-testid="ticket-section" data-label={label}>
      <div className="pb-2 px-1 text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
        {label} · {rows.length}
      </div>
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <TicketCard key={row.id} row={row} nowSec={nowSec} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/** Three lines at most: title / one-line body / status · HTML · people · age. */
function TicketCard({
  row,
  nowSec,
  onOpen,
}: {
  row: FeedbackListRow;
  nowSec: number;
  onOpen: (row: FeedbackListRow) => void;
}) {
  const summary = collapseWs(row.body);
  const people = row.assignees ?? [];
  return (
    <button
      type="button"
      className="w-full min-w-0 text-left k2-tile flex flex-col gap-1"
      style={{ padding: "12px 14px", borderRadius: 14 }}
      onClick={() => onOpen(row)}
      data-testid="ticket-card"
    >
      <span className="w-full min-w-0 text-[15px] font-medium truncate">{row.title}</span>
      {summary ? (
        <span className="w-full min-w-0 text-[13px] truncate" style={{ color: "#a1a1aa" }}>
          {summary}
        </span>
      ) : null}
      <span className="w-full min-w-0 flex items-center gap-2 text-[12px]" style={{ color: "#8e8e93" }}>
        <StatusChip status={row.status} />
        {row.hasBrief ? (
          <span
            className="text-[10px] font-semibold tracking-wide"
            style={{
              padding: "1px 5px",
              borderRadius: 5,
              border: "1px solid rgba(255,255,255,0.22)",
              color: "#d1d1d6",
            }}
            data-testid="ticket-html-mark"
          >
            HTML
          </span>
        ) : null}
        <span className="flex-1" />
        {people.length ? (
          <span className="flex items-center gap-1" aria-label={`Assigned to ${people.join(", ")}`}>
            {people.slice(0, 3).map((p) => (
              <span
                key={p}
                className="inline-flex items-center justify-center text-[10px] font-semibold"
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  background: "#3a3a3c",
                  color: "#fff",
                }}
              >
                {assigneeInitials(p)}
              </span>
            ))}
          </span>
        ) : null}
        <span className="tabular-nums shrink-0">{relativeAge(row.createdAt, nowSec)}</span>
      </span>
    </button>
  );
}
