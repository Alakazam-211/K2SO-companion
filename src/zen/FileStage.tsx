import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";

function Pane({ fileId, dragging }: { fileId: string; dragging?: boolean }) {
  const file = STUB_FILES.find((f) => f.id === fileId);
  if (!file) return null;
  return (
    <pre
      className="flex-1 min-w-0 overflow-auto p-3 text-[12px] text-[var(--text-secondary)] leading-5 whitespace-pre-wrap"
      style={dragging ? { userSelect: "none", WebkitUserSelect: "none" } : undefined}
    >
      {file.body}
    </pre>
  );
}

export function FileStage() {
  const openFileIds = useZenStore((s) => s.openFileIds);
  const focusId = useZenStore((s) => s.focusId);
  const splitId = useZenStore((s) => s.splitId);
  const splitRatio = useZenStore((s) => s.splitRatio);
  const closeFile = useZenStore((s) => s.closeFile);
  const focusFile = useZenStore((s) => s.focusFile);
  const setSplitRatio = useZenStore((s) => s.setSplitRatio);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  if (openFileIds.length === 0 || !focusId) return null;

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onDividerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = wrapRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    setSplitRatio((e.clientX - r.left) / r.width);
  };
  const onDividerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };

  const split =
    splitId && splitId !== focusId && openFileIds.includes(splitId);

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-[var(--background)]">
      <div className="flex items-center gap-0 border-b border-[var(--border)] shrink-0 overflow-x-auto">
        {openFileIds.map((id) => {
          const f = STUB_FILES.find((x) => x.id === id);
          const on = id === focusId || id === splitId;
          return (
            <div
              key={id}
              className={`flex items-center gap-1 px-2 h-8 shrink-0 border-r border-[var(--border)] text-[11px] ${
                on ? "text-[var(--text)] bg-[var(--surface)]" : "text-[var(--text-muted)]"
              }`}
            >
              <button onClick={() => focusFile(id)} className="truncate max-w-[120px]">
                {f?.name ?? id}
              </button>
              <button
                onClick={() => closeFile(id)}
                className="text-[var(--text-muted)] px-2 shrink-0"
                aria-label={`Close ${f?.name ?? id}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div ref={wrapRef} className="flex flex-1 min-h-0 min-w-0">
        {split ? (
          <>
            <div
              className="flex flex-col min-h-0 min-w-0 overflow-hidden"
              style={{ width: `${splitRatio * 100}%` }}
            >
              <Pane fileId={splitId!} dragging={dragging} />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
              className="shrink-0 cursor-col-resize"
              style={{
                width: 24,
                margin: "0 -9px",
                zIndex: 2,
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                background: dragging ? "var(--accent-dim)" : "var(--border)",
              }}
            />
            <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
              <Pane fileId={focusId} dragging={dragging} />
            </div>
          </>
        ) : (
          <Pane fileId={focusId} dragging={dragging} />
        )}
      </div>
    </div>
  );
}
