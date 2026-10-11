import type { RoomFailure } from "./roomFailure";

/** MS36: the room's failure, above the composer. One action, scoped to
 *  the room's server (never another one). Input is off while it shows. */
export function RoomBanner({
  failure,
  onAction,
}: {
  failure: RoomFailure;
  onAction: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="room-banner"
      data-state={failure.state}
      className="flex items-center gap-2 mb-1.5 px-3 py-2 rounded-xl"
      style={{ background: "rgba(255,255,255,0.08)", color: "#fff" }}
    >
      <span className="min-w-0 flex-1 text-[13px] leading-snug">
        <span className="block truncate" data-testid="room-banner-copy">
          {failure.copy}
        </span>
        {failure.detail ? (
          <span className="block text-[11.5px]" style={{ color: "#8e8e93" }}>
            {failure.detail}
          </span>
        ) : null}
      </span>
      {failure.action && failure.actionLabel ? (
        <button
          type="button"
          data-testid="room-banner-action"
          className="shrink-0 text-[13px] font-semibold zen-glass zen-glass-pill"
          style={{ minHeight: 30, padding: "0 12px", color: "#fff" }}
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
        >
          {failure.actionLabel}
        </button>
      ) : null}
    </div>
  );
}
