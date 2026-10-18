import { useState } from "react";
import type { FocusGroupLite } from "./serverPins";
import { CheckIcon } from "./icons";
import { useBackHandler } from "../lib/androidBack";

/**
 * "Move to group…" sheet (the agent menu): put one workspace in a
 * focus group (server-wide, like desktop), take it out ("No group"), or
 * make a new group and put it there. Groups arrive in `tabOrder`.
 * Sits inside the visualViewport-sized column, so the name field stays
 * above the iOS keyboard.
 */
export function FocusGroupPicker({
  agentName,
  groups,
  currentId,
  onPick,
  onCreate,
  onClose,
}: {
  agentName: string;
  groups: FocusGroupLite[];
  currentId: string | null;
  onPick: (groupId: string | null) => void;
  /** Resolves true once the group exists and the agent is in it. */
  onCreate: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Android Back = Cancel.
  useBackHandler(true, onClose);

  const submit = () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    void onCreate(clean).then((ok) => {
      setBusy(false);
      if (!ok) setError("Could not create group");
    });
  };

  const row = (
    key: string,
    label: string,
    on: boolean,
    dot: string | null | undefined,
    onClick: () => void
  ) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className="w-full flex items-center text-left bg-transparent border-0"
      style={{ gap: 12, padding: "10px 14px", minHeight: 48, color: "#fff" }}
      onClick={onClick}
      data-testid={`group-pick-${key}`}
    >
      <span
        aria-hidden
        className="shrink-0"
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: dot || "transparent",
          boxShadow: dot ? undefined : "inset 0 0 0 1.5px #8e8e93",
        }}
      />
      <span className="flex-1 min-w-0 truncate text-[16px]">{label}</span>
      <span aria-hidden className="shrink-0" style={{ width: 18, color: "#0a84ff" }}>
        {on ? (
          <CheckIcon size={18} strokeWidth={2.6} testId="group-pick-check" />
        ) : null}
      </span>
    </button>
  );

  return (
    <div
      className="absolute inset-0 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.45)", zIndex: 30 }}
      data-no-pin="1"
      data-testid="group-picker"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`Add ${agentName} to a group`}
        className="w-full k2-tile k2-tile-sheet flex flex-col"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "16px 0 max(12px, var(--safe-bottom))",
          maxHeight: "80%",
          color: "#fff",
        }}
      >
        <h2
          className="text-[15px] font-semibold text-center truncate shrink-0"
          style={{ padding: "0 20px 10px", lineHeight: 1.35 }}
          data-testid="group-picker-title"
        >
          Add {agentName} to a group
        </h2>
        <div role="menu" aria-label="Focus groups" className="min-h-0 overflow-y-auto">
          {groups.map((g) => row(g.id, g.name, g.id === currentId, g.color, () => onPick(g.id)))}
          {row("none", "No group", currentId === null, null, () => onPick(null))}
        </div>
        {naming ? (
          <form
            className="flex items-center shrink-0"
            style={{ gap: 8, padding: "8px 14px 4px" }}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Group name"
              aria-label="New group name"
              maxLength={60}
              className="flex-1 min-w-0 text-[16px] k2-tile k2-tile-raised outline-none"
              style={{ height: 40, borderRadius: 10, padding: "0 12px", color: "#fff" }}
              data-testid="group-new-name"
            />
            <button
              type="submit"
              className="shrink-0 font-semibold text-[16px] disabled:opacity-40"
              style={{ height: 40, borderRadius: 10, padding: "0 14px", background: "#0a84ff", color: "#fff" }}
              disabled={busy || !name.trim()}
              data-testid="group-new-add"
            >
              {busy ? "Adding…" : "Add"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="w-full flex items-center text-left bg-transparent border-0 shrink-0"
            style={{ gap: 12, padding: "10px 14px", minHeight: 48, color: "#0a84ff" }}
            onClick={() => setNaming(true)}
            data-testid="group-pick-new"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.6" strokeLinecap="round" aria-hidden className="shrink-0">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="text-[16px]">New Group…</span>
          </button>
        )}
        {error ? (
          <p
            role="status"
            className="text-[13px] text-center shrink-0"
            style={{ color: "#ff453a", padding: "4px 16px 0" }}
            data-testid="group-new-error"
          >
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="w-full text-[17px] bg-transparent border-0 shrink-0"
          style={{ minHeight: 44, color: "#8e8e93", marginTop: 4 }}
          onClick={onClose}
          data-testid="group-picker-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
