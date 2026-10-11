import type { ReactNode } from "react";
import { activityColor, activityRowText, type RowActivity } from "./agentActivity";
import { StubMark } from "./StubMark";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { zenTextPx } from "./zenFont";

/**
 * The inside of one Agents-list row: glass-edged avatar with its activity
 * dot, the name over the status line (activity, else preview), and the
 * time + chevron. Shared by the Agents list and the Home list so both
 * look the same. `serverChip` names the row's server (Home rows with several
 * servers); it sits right after the name, not by the time.
 */
export function AgentRowContent({
  name,
  initial,
  color,
  iconUrl,
  busy,
  when,
  preview,
  stub = false,
  serverChip,
}: {
  name: string;
  initial: string;
  color?: string | null;
  iconUrl?: string | null;
  busy: RowActivity | null;
  when: string;
  /** Line two when idle (the list owns how a preview renders). */
  preview: ReactNode;
  stub?: boolean;
  serverChip?: string | null;
}) {
  const busyColor = busy ? activityColor(busy) : "var(--success)";
  return (
    <>
      <span className="relative shrink-0">
        <WorkspaceAvatar initial={initial} color={color} iconUrl={iconUrl} size={50} fontSize={18} />
        {busy ? (
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
              // The pulse ring starts outside the cutout border.
              ["--k2-pulse-edge" as string]: "2.5px",
            }}
          />
        ) : null}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex justify-between items-baseline gap-2">
          {/* Name group (owner 2026-10): the server chip sits right after
              the name, left-aligned; the time stays alone on the right. The
              name truncates first; the chip keeps its own width (capped,
              with its own ellipsis for long nicknames). */}
          <span className="flex items-baseline min-w-0" style={{ gap: 6 }} data-testid="row-name-group">
            <span
              className="min-w-0 truncate font-semibold"
              style={{ fontSize: zenTextPx(16), letterSpacing: "-0.2px" }}
              data-testid="row-name"
            >
              {name}
            </span>
            {serverChip ? (
              <span
                className="zen-glass zen-glass-pill shrink-0 truncate"
                style={{
                  minWidth: 32,
                  maxWidth: 96,
                  padding: "1px 8px",
                  fontSize: zenTextPx(12),
                  color: "#d1d1d6",
                  fontWeight: 400,
                }}
                data-testid="row-server-chip"
              >
                {serverChip}
              </span>
            ) : null}
          </span>
          {stub ? (
            <StubMark />
          ) : (
            <span
              className="shrink-0 flex items-center gap-1"
              style={{ color: "#8e8e93", fontWeight: 400, fontSize: zenTextPx(14) }}
              data-testid="row-when"
            >
              {when}
              {when ? " " : ""}
              ›
            </span>
          )}
        </span>
        {busy ? (
          <span
            className="block truncate"
            style={{ color: busyColor, lineHeight: 1.3, fontSize: zenTextPx(14) }}
            data-testid="row-activity"
          >
            {activityRowText(busy)}
          </span>
        ) : (
          <span
            className="block truncate"
            style={{ color: "#8e8e93", lineHeight: 1.3, fontSize: zenTextPx(14) }}
            data-testid="row-preview"
          >
            {preview}
          </span>
        )}
      </span>
    </>
  );
}
