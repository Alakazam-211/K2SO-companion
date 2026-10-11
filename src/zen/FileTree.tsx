import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getFsReadDir, type FsDirEntry, type ServerScope } from "../api/client";
import { MiddleEllipsis } from "./MiddleEllipsis";
import { TREE_ROW_CAP, baseName, isHeavyDir, isHiddenName, treeEntries } from "./fileTreeModel";
import { isUnderWorkspace } from "./workspacePath";

type DirState =
  | { status: "loading"; entries: FsDirEntry[] }
  | { status: "ok"; entries: FsDirEntry[] }
  | { status: "error"; entries: FsDirEntry[]; error: string };

/** Under the workspace folder (or the folder itself). The phone's jail:
 *  an owner token reads any absolute path, so the client keeps to root. */
export function inTree(path: string, root: string | null): boolean {
  return Boolean(root) && (path === root || isUnderWorkspace(path, root as string));
}

/** One lazily-read folder tree rooted at `root` on `scope`'s server (the
 *  room's). Every folder is read with hidden entries; the eye filters on
 *  the phone (no refetch). Another server is another tree, even when the
 *  root path is the same. */
export function useFileTree(scope: ServerScope, root: string | null) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async (dir: string) => {
    const at = rootRef.current;
    const on = scopeRef.current;
    if (!inTree(dir, at)) return;
    setDirs((d) => ({ ...d, [dir]: { status: "loading", entries: d[dir]?.entries ?? [] } }));
    let next: DirState;
    try {
      const r = await getFsReadDir(on, dir, true);
      next =
        r.ok && Array.isArray(r.data)
          ? {
              status: "ok",
              // Only children of this folder (the daemon's own paths).
              entries: r.data.filter((e) => e && typeof e.path === "string" && inTree(e.path, at)),
            }
          : { status: "error", entries: [], error: r.error || "Could not read this folder" };
    } catch (e) {
      next = { status: "error", entries: [], error: e instanceof Error ? e.message : String(e) };
    }
    if (rootRef.current !== at || scopeRef.current.id !== on.id) return;
    setDirs((d) => ({ ...d, [dir]: next }));
  }, []);

  // A different workspace (or server) is a different tree.
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    if (root) void load(root);
  }, [root, scope.id, load]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const toggle = useCallback(
    (dir: string) => {
      setSelected(dir);
      const next = new Set(expandedRef.current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      setExpanded(next);
    },
    [load]
  );

  const expand = useCallback(
    (dir: string) => {
      setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
    },
    []
  );

  /** Child names of `dir` as last read (for duplicate checks). */
  const namesIn = useCallback(
    (dir: string) => (dirs[dir]?.entries ?? []).map((e) => e.name),
    [dirs]
  );

  return { root, dirs, expanded, selected, setSelected, load, toggle, expand, namesIn };
}

export type FileTreeModel = ReturnType<typeof useFileTree>;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

const ROW_CLASS =
  "w-full flex items-center gap-1 text-left text-[12px] py-[7px] pr-2 select-none";
const ROW_STYLE = { WebkitTouchCallout: "none", WebkitUserSelect: "none" } as const;

/** The workspace folder/file tree. Rows carry `data-file-*` for the
 *  drawer's hold gesture (menu / drag); taps open files and toggle folders. */
export function FileTree({
  tree,
  showHidden,
  activeIds,
  onOpenFile,
  consumeSkipClick,
}: {
  tree: FileTreeModel;
  showHidden: boolean;
  activeIds: string[];
  onOpenFile: (path: string) => void;
  consumeSkipClick: () => boolean;
}) {
  const { root, dirs, expanded, selected, toggle, setSelected } = tree;
  if (!root) return null;

  const renderDir = (dir: string, depth: number): ReactNode => {
    const st = dirs[dir];
    if (!st || (st.status === "loading" && st.entries.length === 0)) {
      return (
        <div
          className="py-1 text-[11px] text-[var(--text-muted)]"
          style={{ paddingLeft: 10 + depth * 12 }}
          data-testid="tree-loading"
        >
          loading
        </div>
      );
    }
    if (st.status === "error") {
      return (
        <div
          className="py-1 pr-2 text-[11px] text-[var(--text-muted)] break-words"
          style={{ paddingLeft: 10 + depth * 12 }}
          data-testid="tree-error"
        >
          {st.error}
        </div>
      );
    }
    const rows = treeEntries(st.entries, showHidden);
    if (rows.length === 0) {
      return (
        <div
          className="py-1 text-[11px] text-[var(--text-muted)]"
          style={{ paddingLeft: 10 + depth * 12 }}
        >
          Empty
        </div>
      );
    }
    const shown = rows.slice(0, TREE_ROW_CAP);
    return (
      <>
        {shown.map((e) => {
          const open = e.isDirectory && expanded.has(e.path);
          const dim = isHiddenName(e.name) || isHeavyDir(e);
          const active = !e.isDirectory && activeIds.includes(e.path);
          const sel = e.isDirectory && selected === e.path;
          return (
            <div key={e.path} role="treeitem" aria-expanded={e.isDirectory ? open : undefined}>
              <button
                type="button"
                className={ROW_CLASS}
                style={{
                  ...ROW_STYLE,
                  paddingLeft: 6 + depth * 12,
                  touchAction: "pan-y",
                  background: sel ? "rgba(255,255,255,0.08)" : undefined,
                  color: active ? "var(--accent)" : dim ? "var(--text-muted)" : "var(--text)",
                }}
                data-file-path={e.path}
                data-file-name={e.name}
                data-file-dir={e.isDirectory ? "1" : "0"}
                data-file-section="tree"
                data-testid={e.isDirectory ? "tree-dir" : "tree-file"}
                aria-label={e.name}
                title={e.name}
                onClick={() => {
                  if (consumeSkipClick()) return;
                  if (e.isDirectory) toggle(e.path);
                  else onOpenFile(e.path);
                }}
              >
                <span className="shrink-0 w-[10px] flex justify-center text-[var(--text-muted)]">
                  {e.isDirectory ? <Chevron open={open} /> : null}
                </span>
                <span className="shrink-0 flex text-[var(--text-muted)]" style={e.isDirectory ? { color: "#64a8ff" } : undefined}>
                  {e.isDirectory ? <FolderIcon /> : <FileIcon />}
                </span>
                <MiddleEllipsis text={e.name} className="flex-1" />
              </button>
              {open ? renderDir(e.path, depth + 1) : null}
            </div>
          );
        })}
        {rows.length > shown.length ? (
          <div
            className="py-1 text-[11px] text-[var(--text-muted)]"
            style={{ paddingLeft: 10 + depth * 12 }}
            data-testid="tree-more"
          >
            {rows.length - shown.length} more
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div role="tree" aria-label="Workspace files" data-testid="file-tree">
      <button
        type="button"
        className={`${ROW_CLASS} pl-2 text-[var(--text-muted)]`}
        style={ROW_STYLE}
        data-testid="tree-root"
        aria-label={`${baseName(root)} (workspace folder)`}
        title={root}
        onClick={() => setSelected(null)}
      >
        <span className="shrink-0 flex" style={{ color: "#64a8ff" }}>
          <FolderIcon />
        </span>
        <MiddleEllipsis text={baseName(root)} className="flex-1 text-[11px] tracking-wide" />
      </button>
      {renderDir(root, 0)}
    </div>
  );
}
