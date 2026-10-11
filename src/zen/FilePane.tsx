import { asErrorText } from "../lib/apiError";
import { StubMark } from "./StubMark";
import { RESOURCES_EMPTY_LINE, RESOURCES_EMPTY_TITLE } from "./workspaceResources";
import { useZenStore, sourceWord } from "./zenStore";

/** Workspace Resources: the files pinned in the desktop Files drawer.
 *  Not a folder listing. Chat-link files open in tabs but are not listed. */
export function FilePane() {
  const open = useZenStore((s) => s.filesOpen);
  const openFileIds = useZenStore((s) => s.openFileIds);
  const openFile = useZenStore((s) => s.openFile);
  const toggleFiles = useZenStore((s) => s.toggleFiles);
  const allFiles = useZenStore((s) => s.files);
  const source = useZenStore((s) => s.fileSource);
  const fileError = useZenStore((s) => s.fileError);
  const files = allFiles.filter((f) => !f.linked);
  const heading =
    source === "live" ? "Workspace Resources" : `${sourceWord(source)} resources`;

  if (!open) return null;

  return (
    <aside
      className="flex flex-col h-full min-h-0 border-l border-[var(--border)] bg-[var(--surface)] shrink-0"
      style={{ width: 168 }}
      aria-label="Files"
    >
      <div className="flex items-center px-2 h-9 border-b border-[var(--border)]">
        <span className={`flex-1 min-w-0 truncate text-[10px] text-[var(--text-muted)] tracking-widest ${source === "live" ? "" : "uppercase"}`}>
          {heading}
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
        {files.length === 0 && source === "live" ? (
          <div className="k2-tile rounded-[14px] m-2 px-3 py-3" data-testid="resources-empty">
            <div className="text-[12px] text-[var(--text)] font-medium">
              {RESOURCES_EMPTY_TITLE}
            </div>
            <div className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
              {RESOURCES_EMPTY_LINE}
            </div>
          </div>
        ) : files.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">
            {source === "loading" ? "loading" : asErrorText(fileError, "empty")}
          </div>
        ) : (
          files.map((f) => {
            const active = openFileIds.includes(f.id);
            const sub = f.missing ? "Unavailable" : f.hint;
            return (
              <button
                key={f.id}
                onClick={() => openFile(f.id)}
                disabled={f.missing}
                title={f.missing ? `${f.name} is no longer on disk` : undefined}
                className={`w-full flex items-center gap-1 text-left px-3 py-2 text-[12px] border-b border-[var(--border)] ${
                  f.missing
                    ? "text-[var(--text-muted)]"
                    : active
                      ? "text-[var(--accent)]"
                      : "text-[var(--text)]"
                }`}
              >
                {source === "stub" ? <StubMark /> : null}
                <span className="flex flex-col min-w-0">
                  <span className={`truncate ${f.missing ? "line-through" : ""}`}>{f.name}</span>
                  {sub ? (
                    <span className="truncate text-[10px] text-[var(--text-muted)]">{sub}</span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
