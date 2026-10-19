import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  assigneeInitials,
  collapseWs,
  defaultTicketScope,
  filterByScope,
  groupByStatus,
  isUnlinked,
  myAssigneeNames,
  relativeAge,
  scopeWaitingCounts,
  STATUS_SECTIONS,
  TICKET_SCOPES,
  type FeedbackListRow,
  type TicketScope,
} from "../api/feedback";
import { useSessionIdentity } from "../lib/useSessionIdentity";
import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { StatusChip, TicketView } from "./TicketView";
import { underHeaderPadding, useMeasuredHeight, ZenHeaderBlur } from "./ZenHeaderBlur";
import { useTicketsScope } from "./zenScope";
import { useBackHandler } from "../lib/androidBack";

// Zen Tickets: the list (glass header + Done, scope tabs, status sections
// of `.k2-tile` cards) and the open ticket (TicketView, Layout A).
//
// Scope tabs are the desktop board's: Waiting on me (default) = assigned
// to me AND waiting; Mine = assigned to me; All. "Me" is whoami (owner →
// `owner`, a Connect user → their username) plus the active server's
// saved username, matched case-insensitively.
//
// Each tab carries a pill with its WAITING count (scopeWaitingCounts):
// the header badge says work is waiting, and the pills say where. The list
// opens on All instead of Waiting on me when nothing waits on me but
// something waits elsewhere (defaultTicketScope), decided once per open,
// after rows and whoami land, and never overriding a tap.
//
// Live: while this overlay is open the list and the open ticket refetch
// (plain `show`, never the brief) on `/cli/sessions/events` ticket frames
// (debounced 300 ms, ticketEvents.ts), every 15 s, and when the app comes
// back to the foreground.

export const TICKETS_POLL_MS = 15_000;
/** Resting floating-header height below the safe area: the 64px title
 *  row plus the 44px scope tabs. */
export const TICKETS_HEADER_PX = 108;

/** "Me" for ticket matching (whoami + the active server's username) and
 *  the waiting count per scope tab, live off the store's rows. Shared by
 *  this list and the Agents header badge (ChatsList) so they never
 *  disagree. `ready` = whoami has resolved (or fallen back). */
export function useTicketWaitingCounts(): {
  me: string[];
  counts: Record<TicketScope, number>;
  ready: boolean;
} {
  const rows = useFeedbackStore((s) => s.rows);
  const identity = useSessionIdentity(useTicketsScope());
  const serverUser = useServersStore(
    (s) => s.servers.find((x) => x.id === s.activeServerId)?.username ?? ""
  );
  const owner = identity?.owner === true;
  const username = identity?.username ?? null;
  const me = useMemo(
    () => myAssigneeNames({ owner, username }, serverUser ? [serverUser] : []),
    [owner, username, serverUser]
  );
  const counts = useMemo(() => scopeWaitingCounts(rows, me), [rows, me]);
  return { me, counts, ready: identity !== null };
}

function refetchLive(): void {
  void useFeedbackStore.getState().refresh();
  void useFeedbackStore.getState().refetchOpen();
}

/** Memoized (with a stable `onClose` from ChatsList): the Agents list's own
 *  re-renders — activity polls, unread, previews — skip the Tickets screen
 *  and the ticket open in it. */
export const TicketsOverlay = memo(function TicketsOverlay({
  onClose,
  initialTicketId,
}: {
  onClose: () => void;
  /** Push-tap deep link (`/zen?ticket=<id>`): open straight on this ticket. */
  initialTicketId?: string | null;
}) {
  const rows = useFeedbackStore((s) => s.rows);
  const isLoading = useFeedbackStore((s) => s.isLoading);
  const error = useFeedbackStore((s) => s.error);
  const { me, counts, ready } = useTicketWaitingCounts();
  // null until the smart default is decided (rows + whoami in hand) or
  // the user taps a tab; renders as Waiting on me meanwhile.
  const [picked, setPicked] = useState<TicketScope | null>(() =>
    ready && rows.length > 0 ? defaultTicketScope(counts) : null
  );
  if (picked === null && ready && rows.length > 0) {
    setPicked(defaultTicketScope(counts));
  }
  const scope: TicketScope = picked ?? "waiting";
  const [openId, setOpenId] = useState<string | null>(() => initialTicketId?.trim() || null);
  const [headerRef, headerPx] = useMeasuredHeight(TICKETS_HEADER_PX);
  const nowSec = Math.floor(Date.now() / 1000);

  useEffect(() => {
    // MA9: the store rides the server's one shared sessions/events socket,
    // which refetches the list and the open ticket on a ticket frame — no
    // second subscription here (one refetch per change, not two).
    useFeedbackStore.getState().ensureLive({ via: "hub" });
    const deepId = initialTicketId?.trim();
    if (deepId) {
      // Cold start may not have the row yet, so its hasBrief is unknown:
      // ask for the brief unless the row says there is none.
      const row = useFeedbackStore.getState().rows.find((r) => r.id === deepId);
      void useFeedbackStore
        .getState()
        .openThread(deepId, { withBrief: row ? row.hasBrief === true : true });
    }
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
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVis);
      // Done with a ticket still open: stop refetching it.
      useFeedbackStore.getState().closeThread();
    };
  }, []);

  const visible = filterByScope(rows, scope, me);
  const grouped = groupByStatus(visible);
  const openRow = openId ? rows.find((r) => r.id === openId) : undefined;

  // Stable, so a refresh (new row objects, same tickets) re-renders no
  // card that did not change (TicketCard is memoized) and not the open
  // ticket.
  const open = useCallback((row: FeedbackListRow) => {
    setOpenId(row.id);
    void useFeedbackStore.getState().openThread(row.id, { withBrief: row.hasBrief === true });
  }, []);

  const back = useCallback(() => {
    setOpenId(null);
    useFeedbackStore.getState().closeThread();
  }, []);
  // Android Back = Done. Off while a ticket is open: TicketView takes
  // Back itself (a deep link mounts both at once, and the child's
  // handler would otherwise register first and lose).
  useBackHandler(!openId, onClose);

  const emptyText =
    scope === "waiting"
      ? "Nothing is waiting on you"
      : scope === "mine"
        ? "Nothing is assigned to you"
        : "No tickets yet";

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6 }}
      data-testid="overlay-tickets"
    >
      {/* Floats over the cards from y=0 with the chat / Agents header's
          progressive blur; only Done and the tabs take touches. Below an
          open TicketView (zIndex 8). */}
      <header
        className="absolute top-0 left-0 right-0 w-full min-w-0"
        data-testid="tickets-header"
        style={{
          zIndex: 3,
          paddingTop: "env(safe-area-inset-top)",
          pointerEvents: "none",
        }}
      >
      <ZenHeaderBlur testId="tickets-header-blur" />
      <div ref={headerRef} className="relative w-full min-w-0" data-testid="tickets-header-content">
      <div
        className="grid items-center"
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
          style={{ minHeight: 34, padding: "0 14px", color: "#fff", pointerEvents: "auto" }}
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="text-[17px] font-semibold pointer-events-none zen-header-text">Tickets</h1>
        <span />
      </div>
      <div className="px-3 pb-2">
        <div
          role="tablist"
          aria-label="Ticket scope"
          className="flex zen-glass zen-glass-pill"
          style={{ padding: 3, pointerEvents: "auto" }}
          data-testid="ticket-scopes"
        >
          {TICKET_SCOPES.map((s) => {
            const on = s.value === scope;
            const n = counts[s.value];
            return (
              <button
                key={s.value}
                type="button"
                role="tab"
                aria-selected={on}
                data-testid={`scope-${s.value}`}
                aria-label={n > 0 ? `${s.label}, ${n} waiting` : s.label}
                onClick={() => setPicked(s.value)}
                className="flex-auto min-w-0 inline-flex items-center justify-center gap-[5px] whitespace-nowrap text-[14px] font-medium border-0 rounded-full"
                style={{
                  height: 30,
                  padding: "0 8px",
                  color: on ? "#fff" : "#a1a1aa",
                  background: on ? "rgba(255,255,255,0.18)" : "transparent",
                }}
              >
                <span className="truncate">{s.label}</span>
                {n > 0 ? (
                  <span
                    aria-hidden
                    data-testid={`scope-count-${s.value}`}
                    className="shrink-0 tabular-nums"
                    style={{
                      minWidth: 18,
                      height: 18,
                      padding: "0 5px",
                      borderRadius: 9,
                      background: "#f59e0b",
                      color: "#000",
                      fontSize: 11,
                      fontWeight: 700,
                      lineHeight: "18px",
                      textAlign: "center",
                    }}
                  >
                    {n > 99 ? "99+" : n}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      </div>
      </header>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          // Starts under the floating header; cards scroll up behind it.
          paddingTop: underHeaderPadding(headerPx),
          paddingLeft: 12,
          paddingRight: 12,
          // The last card scrolls clear of the home indicator / nav bar
          // (same as ZenSettings).
          paddingBottom: "calc(24px + var(--safe-bottom))",
          WebkitOverflowScrolling: "touch",
        }}
        data-testid="tickets-scroller"
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
});

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
          <TicketCard key={row.id} row={row} age={relativeAge(row.createdAt, nowSec)} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/** What a card draws of its row: a refresh hands over new objects for the
 *  same tickets, and only a change here re-renders the card. */
function sameCard(
  a: { row: FeedbackListRow; age: string; onOpen: unknown },
  b: { row: FeedbackListRow; age: string; onOpen: unknown }
): boolean {
  const x = a.row;
  const y = b.row;
  return (
    a.age === b.age &&
    a.onOpen === b.onOpen &&
    (x === y ||
      (x.id === y.id &&
        x.title === y.title &&
        x.body === y.body &&
        x.status === y.status &&
        x.hasBrief === y.hasBrief &&
        (x.assignees ?? []).join("\n") === (y.assignees ?? []).join("\n")))
  );
}

/** Three lines at most: title / one-line body / status · HTML · people · age. */
const TicketCard = memo(function TicketCard({
  row,
  age,
  onOpen,
}: {
  row: FeedbackListRow;
  /** Relative age, already worded. */
  age: string;
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
        <span className="tabular-nums shrink-0">{age}</span>
      </span>
    </button>
  );
}, sameCard);
