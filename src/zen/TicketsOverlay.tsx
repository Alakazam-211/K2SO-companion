import { useEffect, useState } from "react";
import {
  groupByStatus,
  relativeAge,
  resolveFeedback,
  type FeedbackListRow,
} from "../api/feedback";
import { TicketSheet } from "../components/TicketSheet";
import { KindTag, PriorityTag, StatusTag } from "../pages/Feedback";
import { useFeedbackStore } from "../stores/feedback";

/** Overlay ticket tray. List + TicketSheet are the existing Feedback UI. */
export function TicketsOverlay({ onClose }: { onClose: () => void }) {
  const rows = useFeedbackStore((s) => s.rows);
  const isLoading = useFeedbackStore((s) => s.isLoading);
  const error = useFeedbackStore((s) => s.error);
  const openItem = useFeedbackStore((s) => s.openItem);
  const [sheet, setSheet] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  const grouped = groupByStatus(rows);

  useEffect(() => {
    useFeedbackStore.getState().ensureLive();
  }, []);

  const openRow = (id: string) => {
    setStatusError(null);
    void useFeedbackStore.getState().openThread(id).then(() => setSheet(true));
  };

  const setStatus = (status: "resolved" | "dismissed" | "waiting") => {
    const item = useFeedbackStore.getState().openItem;
    if (!item || statusBusy) return;
    setStatusBusy(true);
    setStatusError(null);
    void resolveFeedback(item.id, status)
      .then(() => {
        void useFeedbackStore.getState().refetchOpen();
        void useFeedbackStore.getState().refresh();
      })
      .catch((err) => {
        setStatusError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setStatusBusy(false));
  };

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-tickets"
    >
      <div
        className="flex items-center justify-between relative shrink-0"
        style={{
          minHeight: 44,
          padding: "12px 16px 8px",
        }}
      >
        <button
          type="button"
          className="text-[17px]"
          style={{
            minHeight: 34,
            padding: "0 14px",
            borderRadius: 17,
            background: "#1c1c1e",
          }}
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="absolute left-1/2 -translate-x-1/2 text-[17px] font-semibold pointer-events-none">
          Tickets
        </h1>
        <span style={{ width: 72 }} />
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "0 16px 24px", WebkitOverflowScrolling: "touch" }}
      >
        {error ? (
          <p className="py-6 text-[14px]" style={{ color: "#f59e0b" }}>
            {error}
          </p>
        ) : null}
        {isLoading && rows.length === 0 ? (
          <p className="py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            Loading tickets…
          </p>
        ) : null}
        {!isLoading && rows.length === 0 && !error ? (
          <p className="py-6 text-[14px]" style={{ color: "#8e8e93" }}>
            No tickets yet.
          </p>
        ) : null}
        <TicketSection label="Waiting" rows={grouped.waiting} nowSec={nowSec} onOpen={openRow} />
        <TicketSection label="Answered" rows={grouped.answered} nowSec={nowSec} onOpen={openRow} />
        <TicketSection label="Closed" rows={grouped.closed} nowSec={nowSec} onOpen={openRow} />
      </div>
      {sheet && openItem ? (
        <TicketSheet
          item={openItem}
          nowSec={nowSec}
          onClose={() => setSheet(false)}
          onAssigneesChanged={() => {
            void useFeedbackStore.getState().refetchOpen();
            void useFeedbackStore.getState().refresh();
          }}
          onSetStatus={setStatus}
          statusBusy={statusBusy}
          statusError={statusError}
        />
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
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="pt-4">
      <div className="pb-2 text-[11px] uppercase tracking-wide" style={{ color: "#8e8e93" }}>
        {label} · {rows.length}
      </div>
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="w-full text-left"
            style={{
              padding: 16,
              background: "#1c1c1e",
              border: "1px solid rgba(255,255,255,.12)",
            }}
            onClick={() => onOpen(row.id)}
          >
            <span className="flex items-baseline gap-3">
              <span className="flex-1 min-w-0 text-[13px] font-medium line-clamp-2">
                {row.title}
              </span>
              <span className="shrink-0 text-[10px]" style={{ color: "#8e8e93" }}>
                {relativeAge(row.createdAt, nowSec)}
              </span>
            </span>
            <span className="mt-2 flex items-center gap-1.5">
              <PriorityTag priority={row.priority} />
              <KindTag kind={row.kind} />
              <StatusTag status={row.status} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
