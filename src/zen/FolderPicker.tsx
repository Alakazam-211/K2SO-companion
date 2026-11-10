import { useEffect, useState } from "react";
import { getFsReadDir, type FsDirEntry } from "../api/client";
import type { ServerScope } from "../api/scope";
import { EntryIcon } from "./fileIcons/EntryIcon";
import { parentDir, treeEntries } from "./fileTreeModel";

/** Browse the workspace's folders: tap into one, Back out of it, never above
 *  `root`. A press keeps the keyboard up, so a sheet with a name field
 *  doesn't jump while the person chooses. */
export function FolderPicker({
  scope,
  root,
  dir,
  onDir,
  showHidden,
  disabled,
  maxHeight,
}: {
  scope: ServerScope;
  root: string;
  dir: string;
  onDir: (dir: string) => void;
  showHidden: boolean;
  disabled?: boolean;
  maxHeight: string;
}) {
  const [folders, setFolders] = useState<FsDirEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFolders(null);
    setLoadFailed(false);
    void getFsReadDir(scope, dir, showHidden)
      .then((r) => {
        if (!live) return;
        if (r.ok && Array.isArray(r.data)) setFolders(treeEntries(r.data, showHidden).filter((e) => e.isDirectory));
        else setLoadFailed(true);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [scope, dir, showHidden]);

  const rowClass = "w-full flex items-center gap-2 text-left px-3 text-[15px] bg-transparent border-0 text-[var(--text)]";
  return (
    <div
      className="k2-tile overflow-y-auto"
      style={{ borderRadius: 12, maxHeight, minHeight: 88 }}
      data-testid="folder-picker"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {dir !== root ? (
        <button
          type="button"
          className={rowClass}
          style={{ minHeight: 44 }}
          disabled={disabled}
          data-testid="folder-picker-up"
          onClick={() => onDir(parentDir(dir))}
        >
          <span aria-hidden="true">‹</span>
          <span>Back</span>
        </button>
      ) : null}
      {folders?.map((f) => (
        <button
          key={f.path}
          type="button"
          className={rowClass}
          style={{ minHeight: 44 }}
          disabled={disabled}
          data-testid="folder-picker-row"
          onClick={() => onDir(f.path)}
        >
          <EntryIcon name={f.name} isDirectory />
          <span className="min-w-0 truncate">{f.name}</span>
        </button>
      ))}
      {folders && !folders.length ? (
        <p className="px-3 py-3 text-[13px] text-[var(--text-muted)]" data-testid="folder-picker-empty">
          No folders inside this one.
        </p>
      ) : null}
      {loadFailed ? (
        <p className="px-3 py-3 text-[13px] text-[var(--text-muted)]" data-testid="folder-picker-failed">
          Couldn't read this folder.
        </p>
      ) : null}
    </div>
  );
}
