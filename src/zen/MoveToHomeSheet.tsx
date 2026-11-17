import { useEffect } from "react";
import { homeHasAddress, type Home } from "./homes";
import { CheckIcon } from "./icons";
import { GroupGlyph } from "./groups/GroupGlyph";
import { useBackHandler } from "../lib/androidBack";

/**
 * A Home row's "Move to group…" sheet (Riley): the Home groups (in
 * code, Homes) on this phone, in their order, each with its icon (or its
 * number). The agent's own group is checked and can't be picked; a group
 * that already has the agent says so and can't be picked either. A pick
 * moves it (`useHomesStore.moveRowToHome`, synced like every Home edit)
 * and closes. Cancel, the backdrop, Escape and Android Back close it.
 * Same bottom sheet as the Agents tab's focus-group picker.
 */
export function MoveToHomeSheet({
  agentName,
  address,
  homes,
  fromId,
  onPick,
  onClose,
}: {
  agentName: string;
  /** The row's address (a Home that already has it can't be picked). */
  address: string;
  homes: Home[];
  /** The group (Home) the agent is on now. */
  fromId: string;
  onPick: (homeId: string) => void;
  onClose: () => void;
}) {
  // Android Back = Cancel.
  useBackHandler(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ background: "var(--color-scrim)", zIndex: 30 }}
      data-no-pin="1"
      data-testid="move-home-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-home-title"
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 0 max(12px, var(--safe-bottom))",
          maxHeight: "80%",
          color: "var(--color-text-primary)",
        }}
      >
        <h2
          id="move-home-title"
          className="text-[15px] font-semibold text-center truncate shrink-0"
          style={{ padding: "0 20px 10px", lineHeight: 1.35 }}
          data-testid="move-home-title"
        >
          Move {agentName} to a group
        </h2>
        <ul aria-label="Groups" className="min-h-0 overflow-y-auto list-none m-0 p-0">
          {homes.map((h, i) => {
            const current = h.id === fromId;
            const has = !current && homeHasAddress(h, address);
            const off = current || has;
            const note = current ? "Current" : has ? "Already in it" : null;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  disabled={off}
                  aria-current={current || undefined}
                  aria-label={note ? `${h.name}, ${note.toLowerCase()}` : h.name}
                  className="w-full flex items-center text-left bg-transparent border-0"
                  style={{
                    gap: 12,
                    padding: "10px 14px",
                    minHeight: 48,
                    color: "var(--color-text-primary)",
                    opacity: has ? 0.45 : 1,
                  }}
                  onClick={() => onPick(h.id)}
                  data-testid={`move-home-${h.id}`}
                >
                  <span
                    aria-hidden
                    className="shrink-0 flex items-center justify-center"
                    style={{ width: 20, color: current ? "var(--color-accent-text)" : "var(--color-text-muted)" }}
                  >
                    <GroupGlyph icon={h.icon} n={i + 1} size={18} />
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[16px]">{h.name}</span>
                  {note ? (
                    <span className="shrink-0 text-[13px]" style={{ color: "var(--color-text-muted)" }}>
                      {note}
                    </span>
                  ) : null}
                  <span aria-hidden className="shrink-0" style={{ width: 18, color: "var(--color-accent-text)" }}>
                    {current ? <CheckIcon size={18} strokeWidth={2.6} testId="move-home-check" /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="w-full text-[17px] bg-transparent border-0 shrink-0"
          style={{ minHeight: 44, color: "var(--color-text-muted)", marginTop: 4 }}
          onClick={onClose}
          data-testid="move-home-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
