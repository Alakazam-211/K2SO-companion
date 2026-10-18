// The multi-server Agents list's own pieces (multi-server S2, MS35, MS39).
// Only rendered with `zen.multiServer` on. The active server's rows keep
// ChatsList's own row (swipe, pin drag, last-at); these are the rows of a
// NON-active server (only with no active server saved), a server's
// placeholder row and the "Loading {server}…" line.
//
// S3 (MS21): opening a row from another server opens a ROOM on that
// server (`zenStore.openRoom`); the active server never changes. A server
// known to be below the phone floor (0.41.6) opens the old way instead.

import { useEffect, useState, type ReactNode } from "react";
import { activityColor, activityRowText, type RowActivity } from "../agentActivity";
import { WorkspaceAvatar } from "../WorkspaceAvatar";
import { zenTextPx } from "../zenFont";
import type { MergedRow } from "./merge";
import type { RowFailure } from "./rowStatus";
import { LOADING_LINE_AFTER_MS } from "./remoteRows";
import type { RowUnread } from "../unread";
import { MutedGlyph, RowUnreadCount, UnreadDot } from "../UnreadMarks";

const MUTED = "#8e8e93";

/** Re-render every `ms` while `on` (countdowns, the loading line). */
export function useTicker(on: boolean, ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/** A failure's state word. A server that is down says "Reconnecting…"
 *  with a breathing dot (auto reconnect retries it on its own). */
export function FailureText({ failure }: { failure: RowFailure; nextAt?: number | null }) {
  // A server that is down is being retried on its own: a breathing dot
  // and "Reconnecting…", not a dead row.
  if (failure.state === "offline" || failure.state === "restarting") {
    return (
      <span className="inline-flex items-center" style={{ gap: 6 }}>
        <span aria-hidden className="k2-reconnect-dot" data-testid="row-reconnecting" />
        {failure.copy}
      </span>
    );
  }
  return <>{failure.copy}</>;
}

/** The trailing one-tap fix on a failure row. */
export function FailureAction({
  failure,
  serverLabel,
  onAction,
}: {
  failure: RowFailure;
  serverLabel: string;
  onAction: () => void;
}) {
  if (!failure.action || !failure.actionLabel) return null;
  const aria =
    failure.action === "sign-in"
      ? `Sign in to ${serverLabel}`
      : failure.action === "retry"
        ? `Retry ${serverLabel} now`
        : `Open the old way: switch to ${serverLabel}`;
  return (
    <button
      type="button"
      className="shrink-0 zen-glass zen-glass-pill text-[14px] font-semibold"
      style={{ minHeight: 32, padding: "0 12px", color: "#0a84ff", opacity: 1 }}
      onClick={(e) => {
        e.stopPropagation();
        onAction();
      }}
      aria-label={aria}
      data-testid="row-failure-action"
      data-action={failure.action}
      data-no-pin="1"
    >
      {failure.actionLabel}
    </button>
  );
}

function RowShell({
  inset,
  greyed,
  children,
  testId,
  serverId,
  rowKey,
}: {
  inset: string;
  greyed: boolean;
  children: ReactNode;
  testId: string;
  serverId: string;
  rowKey?: string;
}) {
  return (
    <div
      className="relative overflow-hidden flex items-center"
      data-testid={testId}
      data-server-id={serverId}
      data-row-key={rowKey}
      data-greyed={greyed ? "1" : undefined}
      style={{
        gap: 10,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: inset,
        paddingRight: inset,
      }}
    >
      {children}
    </div>
  );
}

/** A row from another saved server. Greyed (60%) with its state word and
 *  one action when that server is in trouble; else a normal row that
 *  opens on tap. */
export function RemoteAgentRow({
  row,
  failure,
  busy,
  when,
  lastKey,
  iconUrl,
  inset,
  onOpen,
  onAction,
  nextAt,
  unread = null,
}: {
  row: MergedRow;
  failure: RowFailure | null;
  busy: RowActivity | null;
  when: string;
  lastKey?: string;
  iconUrl: string | null;
  inset: string;
  onOpen: () => void;
  onAction: () => void;
  /** The pool's next check (offline countdown). */
  nextAt?: number | null;
  /** Unread marks on that server (K2 0.46.1); null = none. */
  unread?: RowUnread | null;
}) {
  const a = row.agent;
  const marks = failure ? null : unread;
  const strong = !!marks?.emphasis;
  const busyColor = busy ? activityColor(busy) : "var(--success)";
  const second = failure ? (
    <FailureText failure={failure} nextAt={nextAt} />
  ) : busy ? (
    activityRowText(busy)
  ) : (
    a.chatTitle || ""
  );
  const body = (
    <>
      <span className="relative shrink-0">
        <UnreadDot unread={marks} />
        <WorkspaceAvatar initial={a.initial} color={a.color} iconUrl={iconUrl} size={50} fontSize={18} />
        {busy && !failure ? (
          <span
            aria-hidden
            data-testid="row-activity-dot"
            className={`absolute rounded-full ${busy.display === "working" ? "k2-pulse" : ""}`}
            style={{
              right: -1,
              bottom: -1,
              width: 14,
              height: 14,
              background: busyColor,
              color: busyColor,
              border: "2.5px solid var(--root)",
              ["--k2-pulse-edge" as string]: "2.5px",
            }}
          />
        ) : null}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex justify-between items-baseline gap-2">
          <span className="flex items-baseline min-w-0" style={{ gap: 6 }}>
            <span
              className="min-w-0 truncate font-semibold"
              style={{
                fontSize: zenTextPx(16),
                letterSpacing: "-0.2px",
                ...(strong ? { fontWeight: 700 } : null),
              }}
              data-testid="row-name"
              data-unread={marks ? marks.tone : undefined}
            >
              {a.name}
            </span>
            {marks?.muted ? <MutedGlyph /> : null}
          </span>
          {failure ? null : (
            <span
              className="shrink-0 flex items-center gap-1"
              style={{ color: MUTED, fontWeight: 400, fontSize: zenTextPx(14) }}
              data-testid="row-when"
            >
              {when}
              {when ? " " : ""}›
            </span>
          )}
        </span>
        <span className="flex items-center min-w-0" style={{ gap: 8 }}>
          <span
            className="block truncate flex-1 min-w-0"
            style={{
              color: failure ? MUTED : busy ? busyColor : strong ? "#f2f2f7" : MUTED,
              lineHeight: 1.3,
              fontSize: zenTextPx(14),
              ...(strong && !busy ? { fontWeight: 600 } : null),
            }}
            data-testid={failure ? "row-failure" : busy ? "row-activity" : "row-preview"}
            data-state={failure?.state}
            title={failure?.detail ?? undefined}
          >
            {second}
          </span>
          <RowUnreadCount unread={marks} />
        </span>
      </span>
    </>
  );
  if (failure) {
    // A server that is down still opens: the chat shows what is cached and
    // reconnects (its banner says so).
    const opens = failure.state === "offline" || failure.state === "restarting";
    return (
      <RowShell inset={inset} greyed testId="remote-row" serverId={row.serverId} rowKey={row.key}>
        {opens ? (
          <button
            type="button"
            className="flex-1 min-w-0 flex items-center text-left"
            style={{ gap: 10, opacity: 0.6 }}
            aria-label={`${a.name}, ${row.serverLabel}, ${failure.copy}`}
            onClick={onOpen}
            data-no-pin="1"
          >
            {body}
          </button>
        ) : (
          <span
            className="flex-1 min-w-0 flex items-center"
            style={{ gap: 10, opacity: 0.6 }}
            aria-label={`${a.name}, ${row.serverLabel}, ${failure.copy}`}
            aria-disabled="true"
          >
            {body}
          </span>
        )}
        <FailureAction failure={failure} serverLabel={row.serverLabel} onAction={onAction} />
      </RowShell>
    );
  }
  return (
    <div
      className="relative overflow-hidden"
      data-testid="remote-row"
      data-server-id={row.serverId}
      data-row-key={row.key}
    >
      <button
        type="button"
        className="w-full flex items-center text-left relative"
        style={{
          gap: 10,
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: inset,
          paddingRight: inset,
        }}
        onClick={onOpen}
        aria-label={`${a.name}, ${row.serverLabel}` + (busy ? `, ${activityRowText(busy)}` : "")}
        data-last-at-key={lastKey}
        data-no-pin="1"
      >
        {body}
      </button>
    </div>
  );
}

/** One row for a server with no rows to show (never loaded, signed out,
 *  offline…): the server itself, with its state and its one action. */
export function ServerPlaceholderRow({
  serverId,
  label,
  failure,
  note,
  inset,
  onAction,
  nextAt,
}: {
  serverId: string;
  label: string;
  failure: RowFailure | null;
  /** When healthy: why there are no rows ("No agents", "Loading…"). */
  note: string;
  inset: string;
  onAction: () => void;
  nextAt?: number | null;
}) {
  const initial = (label.trim()[0] || "?").toUpperCase();
  return (
    <RowShell inset={inset} greyed={!!failure} testId="server-placeholder-row" serverId={serverId}>
      <span
        className="flex-1 min-w-0 flex items-center"
        style={{ gap: 10, opacity: failure ? 0.6 : 1 }}
        aria-label={`${label}, ${failure ? failure.copy : note}`}
      >
        <WorkspaceAvatar initial={initial} size={50} fontSize={18} fallback="#2c2c2e" />
        <span className="flex-1 min-w-0">
          <span
            className="block truncate font-semibold"
            style={{ fontSize: zenTextPx(16), letterSpacing: "-0.2px" }}
            data-testid="row-name"
          >
            {label}
          </span>
          <span
            className="block truncate"
            style={{ color: MUTED, lineHeight: 1.3, fontSize: zenTextPx(14) }}
            data-testid={failure ? "row-failure" : "row-preview"}
            data-state={failure?.state}
            title={failure?.detail ?? undefined}
          >
            {failure ? <FailureText failure={failure} nextAt={nextAt} /> : note}
          </span>
        </span>
      </span>
      {failure ? <FailureAction failure={failure} serverLabel={label} onAction={onAction} /> : null}
    </RowShell>
  );
}

/** MS39: "Loading {server}…" — only for a load running over 2 s. */
export function LoadingLines({
  loads,
  inset,
}: {
  loads: { serverId: string; label: string; startedAt: number }[];
  inset: string;
}) {
  const now = useTicker(loads.length > 0, 500);
  const slow = loads.filter((l) => now - l.startedAt >= LOADING_LINE_AFTER_MS);
  if (slow.length === 0) return null;
  return (
    <>
      {slow.map((l) => (
        <p
          key={l.serverId}
          className="truncate"
          style={{ paddingLeft: inset, paddingRight: inset, color: MUTED, fontSize: 12, lineHeight: "20px" }}
          data-testid="server-loading-line"
        >
          Loading {l.label}…
        </p>
      ))}
    </>
  );
}
