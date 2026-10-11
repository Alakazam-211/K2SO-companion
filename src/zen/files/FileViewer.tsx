import { lazy, Suspense, useEffect, useState } from "react";
import { useSwipeBack } from "../../lib/useSwipeBack";
import { useBackHandler } from "../../lib/androidBack";
import { PaneErrorBoundary } from "../PaneErrorBoundary";
import { MiddleEllipsis } from "../MiddleEllipsis";
import { StubMark } from "../StubMark";
import { FileIcon } from "../fileIcons/EntryIcon";
import { useZenStore } from "../zenStore";
import { ViewerNote } from "./BinaryEmptyState";
import { getFileCategory, supportsSourceToggle } from "./fileCategory";
import "./fileViewer.css";

const FileBody = lazy(() => import("./FileBody"));

/** Muted line under the name: the resource's folder, or the file's folder
 *  relative to the workspace. Null at the workspace root. */
export function folderLine(id: string, hint: string | null | undefined, workspace: string): string | null {
  if (hint) return hint;
  if (!id.includes("/")) return null;
  const root = workspace.replace(/\/+$/, "");
  const dir = id.slice(0, id.lastIndexOf("/"));
  if (root && dir === root) return null;
  if (root && dir.startsWith(`${root}/`)) return dir.slice(root.length + 1);
  return dir || null;
}

const GLASS_BTN = {
  width: 34,
  height: 34,
  color: "#fff",
} as const;

/** Full-screen file viewer: name top-left, glass ✕ top-right, the file
 *  below. ✕ closes this file; the one under it shows, or the viewer
 *  returns to the Files list or the chat it was opened from. */
export function FileViewer() {
  const openFileIds = useZenStore((s) => s.openFileIds);
  const focusId = useZenStore((s) => s.focusId);
  const files = useZenStore((s) => s.files);
  const fileSource = useZenStore((s) => s.fileSource);
  const closeFile = useZenStore((s) => s.closeFile);
  const focusFile = useZenStore((s) => s.focusFile);
  const openFileFromPath = useZenStore((s) => s.openFileFromPath);
  const workspace = useZenStore((s) => {
    const row = s.agents.find((a) => a.id === s.agentId);
    return typeof row?.path === "string" ? row.path : "";
  });
  const [source, setSource] = useState(false);
  const [menu, setMenu] = useState(false);
  // Left-edge swipe closes the file, like the other full-screen pages.
  // FileStage mounts this only with a file to show, so the root exists
  // when the hook binds its listeners (once).
  const closeFocused = () => {
    const id = useZenStore.getState().focusId;
    if (id) closeFile(id);
  };
  const swipeRef = useSwipeBack(closeFocused);
  // Android Back: the ✕ (and the swipe) — this file closes. The open
  // file switcher shuts first.
  useBackHandler(true, closeFocused);
  useBackHandler(menu, () => setMenu(false));

  // A new file opens rendered, with the switcher shut.
  useEffect(() => {
    setSource(false);
    setMenu(false);
  }, [focusId]);

  const file = files.find((f) => f.id === focusId);
  if (!focusId || !file) return null;

  const stub = fileSource === "stub";
  const folder = folderLine(file.id, file.hint, workspace);
  const category = getFileCategory(file.id);
  const canToggle = supportsSourceToggle(category) && !stub && Boolean(file.body);
  const others = openFileIds.length > 1;

  return (
    <div
      ref={swipeRef}
      className="fixed inset-0 flex flex-col bg-[var(--background)] fv-root"
      style={{ zIndex: 60 }}
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      data-testid="file-viewer"
    >
      <header
        className="relative flex items-center gap-2 shrink-0 px-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 8px)", paddingBottom: 10 }}
        data-testid="file-viewer-header"
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          onClick={others ? () => setMenu((m) => !m) : undefined}
          disabled={!others}
          aria-haspopup={others ? "menu" : undefined}
          aria-expanded={others ? menu : undefined}
          data-testid="file-viewer-title"
        >
          <span className="flex w-full min-w-0 items-center gap-1 text-[16px] font-semibold text-[var(--text)]">
            {stub ? <StubMark /> : null}
            {/* Desktop's file tab shows the same Seti glyph. */}
            <span className="shrink-0 flex" data-testid="file-viewer-icon">
              <FileIcon name={file.name} size={18} />
            </span>
            {/* Cut in the middle, keeping the last 10 characters. */}
            <MiddleEllipsis text={file.name} testId="file-viewer-name" className="flex-1" />
            {others ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]" aria-hidden>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            ) : null}
          </span>
          {folder ? (
            <span className="max-w-full truncate text-[12px] text-[var(--text-muted)]" data-testid="file-viewer-folder">
              {folder}
            </span>
          ) : null}
        </button>
        {canToggle ? (
          <button
            type="button"
            className="shrink-0 px-3 text-[13px] zen-glass zen-glass-pill"
            style={{ height: 34, color: "#fff" }}
            onClick={() => setSource((v) => !v)}
            aria-pressed={source}
            data-testid="file-viewer-source"
          >
            {source ? "Preview" : "Source"}
          </button>
        ) : null}
        <button
          type="button"
          className="flex items-center justify-center shrink-0 zen-glass zen-glass-pill"
          style={GLASS_BTN}
          onClick={() => closeFile(file.id)}
          aria-label="Close"
          data-testid="file-viewer-close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        {menu && others ? (
          <div
            role="menu"
            className="absolute left-3 right-3 top-full z-10 k2-tile k2-tile-raised rounded-[14px] overflow-hidden"
            data-testid="file-viewer-menu"
          >
            {[...openFileIds].reverse().map((id) => {
              const f = files.find((x) => x.id === id);
              return (
                <div key={id} className="flex items-center border-b border-[var(--border)] last:border-b-0">
                  <button
                    type="button"
                    role="menuitem"
                    className={`min-w-0 flex-1 truncate px-3 py-2.5 text-left text-[14px] ${
                      id === focusId ? "text-[var(--accent)]" : "text-[var(--text)]"
                    }`}
                    onClick={() => {
                      focusFile(id);
                      setMenu(false);
                    }}
                  >
                    {f?.name ?? id}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 px-3 py-2.5 text-[var(--text-muted)]"
                    aria-label={`Close ${f?.name ?? id}`}
                    onClick={() => closeFile(id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </header>
      <div className="relative flex-1 min-h-0" onClick={menu ? () => setMenu(false) : undefined}>
        <PaneErrorBoundary key={file.id} name="file">
          <Suspense fallback={<ViewerNote title="Loading…" />}>
            <FileBody file={file} source={source} stub={stub} onFileLink={openFileFromPath} />
          </Suspense>
        </PaneErrorBoundary>
      </div>
    </div>
  );
}
