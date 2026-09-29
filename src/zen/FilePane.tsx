import { useZenStore } from "./zenStore";

export function FilePane() {
  const open = useZenStore((s) => s.filesOpen);
  const openFileIds = useZenStore((s) => s.openFileIds);
  const openFile = useZenStore((s) => s.openFile);
  const toggleFiles = useZenStore((s) => s.toggleFiles);
  const files = useZenStore((s) => s.files);
  const source = useZenStore((s) => s.fileSource);

  if (!open) {
    return (
      <button
        onClick={toggleFiles}
        className="shrink-0 border-l border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] text-[10px] tracking-widest uppercase"
        style={{ width: 28, writingMode: "vertical-rl" }}
        aria-label="Open files"
      >
        Files
      </button>
    );
  }

  return (
    <aside
      className="flex flex-col border-l border-[var(--border)] bg-[var(--surface)] shrink-0"
      style={{ width: 168 }}
      aria-label="Files"
    >
      <div className="flex items-center px-2 h-9 border-b border-[var(--border)]">
        <span className="flex-1 text-[10px] text-[var(--text-muted)] tracking-widest uppercase">
          {source === "live" ? "LIVE files" : "STUB files"}
        </span>
        <button
          onClick={toggleFiles}
          className="text-[var(--text-muted)] text-[11px] px-1"
          aria-label="Hide files"
        >
          ›
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">empty</div>
        ) : files.map((f) => {
          const active = openFileIds.includes(f.id);
          return (
            <button
              key={f.id}
              onClick={() => openFile(f.id)}
              className={`w-full text-left px-3 py-2 text-[12px] truncate border-b border-[var(--border)] ${
                active ? "text-[var(--accent)]" : "text-[var(--text)]"
              }`}
            >
              {f.name}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
