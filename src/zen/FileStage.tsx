import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";

function Pane({ fileId }: { fileId: string }) {
  const file = STUB_FILES.find((f) => f.id === fileId);
  if (!file) return null;
  return (
    <pre className="flex-1 min-w-0 overflow-auto p-3 text-[12px] text-[var(--text-secondary)] leading-5 whitespace-pre-wrap">
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

  if (openFileIds.length === 0 || !focusId) return null;

  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const box = wrapRef.current;
    if (!box) return;
    const move = (ev: PointerEvent) => {
      const r = box.getBoundingClientRect();
      setSplitRatio((ev.clientX - r.left) / r.width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
              className={`flex items-center gap-1 px-2 h-8 border-r border-[var(--border)] text-[11px] ${
                on ? "text-[var(--text)] bg-[var(--surface)]" : "text-[var(--text-muted)]"
              }`}
            >
              <button onClick={() => focusFile(id)} className="truncate max-w-[120px]">
                {f?.name ?? id}
              </button>
              <button
                onClick={() => closeFile(id)}
                className="text-[var(--text-muted)] px-0.5"
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
              <Pane fileId={splitId!} />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onDividerDown}
              className="shrink-0 bg-[var(--border)] cursor-col-resize"
              style={{ width: 6 }}
            />
            <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
              <Pane fileId={focusId} />
            </div>
          </>
        ) : (
          <Pane fileId={focusId} />
        )}
      </div>
    </div>
  );
}
