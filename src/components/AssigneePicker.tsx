import { useEffect, useRef, useState } from "react";
import { assignFeedback, fetchTicketUsers } from "../api/feedback";

// Desktop FeedbackItemView AssigneePicker — multi-select Connect users
// plus synthetic `owner`. Save POSTs /cli/feedback/assign.

export function AssigneePicker({
  ticketId,
  assignees,
  busy,
  onChanged,
}: {
  ticketId: string;
  assignees: string[];
  busy?: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<string[]>(["owner"]);
  const [local, setLocal] = useState<string[]>(assignees);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLocal(assignees);
  }, [assignees, ticketId]);

  useEffect(() => {
    let cancelled = false;
    void fetchTicketUsers()
      .then((names) => {
        if (!cancelled) setCandidates(names);
      })
      .catch(() => {
        if (!cancelled) setCandidates(["owner"]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toggle = (name: string) => {
    setLocal((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      await assignFeedback(ticketId, local);
      onChanged();
      setOpen(false);
    } catch (e) {
      console.warn("[tickets] assign failed", e);
    } finally {
      setSaving(false);
    }
  };

  const chips = local.length === 0 ? ["Unassigned"] : local;

  return (
    <div ref={rootRef} className="mb-4 relative">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          Assignees
        </span>
        {chips.map((a) => (
          <span
            key={a}
            className="text-[11px] text-[var(--text-secondary)]"
            style={{
              padding: "3px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border-hover)",
            }}
          >
            {a}
          </span>
        ))}
        <button
          type="button"
          disabled={busy || saving}
          onClick={() => setOpen((o) => !o)}
          className="text-[12px] text-[var(--accent)] disabled:opacity-50"
          style={{ padding: "4px 8px" }}
        >
          Edit
        </button>
      </div>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-30 min-w-[200px] max-h-56 overflow-y-auto"
          style={{
            background: "var(--background)",
            border: "1px solid var(--border-hover)",
          }}
        >
          {candidates.map((name) => {
            const on = local.includes(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                className="flex w-full items-center gap-2 text-left text-[13px]"
                style={{
                  padding: "10px 12px",
                  color: on ? "var(--text)" : "var(--text-secondary)",
                  background: on ? "rgba(34, 211, 238, 0.08)" : "transparent",
                }}
              >
                <span
                  className="shrink-0"
                  style={{
                    width: 14,
                    color: on ? "var(--accent)" : "transparent",
                  }}
                >
                  ✓
                </span>
                {name}
              </button>
            );
          })}
          <div
            className="flex justify-end gap-3"
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border-hover)",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setLocal(assignees);
                setOpen(false);
              }}
              className="text-[12px] text-[var(--text-muted)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="text-[12px] text-[var(--accent)] disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
