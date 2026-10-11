import { useEffect, useState } from "react";
import { getFsZipList, type FsZipEntry } from "../../api/client";
import { ViewerNote } from "./BinaryEmptyState";
import { formatBytes } from "./fileBytes";
import { useZenScope } from "../zenScope";

/** ZIP contents from the central directory (`GET /cli/fs/zip-list`), like
 *  desktop `ZipViewer`. No Extract: the phone is view-only. */
export function ZipView({ path }: { path: string | null }) {
  const scope = useZenScope();
  const [entries, setEntries] = useState<FsZipEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    if (!path) {
      setError("This file is not readable from here.");
      return;
    }
    void getFsZipList(scope, path).then((r) => {
      if (cancelled) return;
      if (!r.ok || !r.data) {
        setError(r.error || "zip-list failed");
        return;
      }
      setEntries(Array.isArray(r.data.entries) ? r.data.entries : []);
      setTruncated(Boolean(r.data.truncated));
    });
    return () => {
      cancelled = true;
    };
  }, [path, scope]);

  if (error) return <ViewerNote tone="error" title="Could not list the archive" detail={error} />;
  if (!entries) return <ViewerNote title="Reading archive…" />;
  if (entries.length === 0) return <ViewerNote title="Archive is empty" />;

  return (
    <div className="px-4 pt-1 pb-4" data-testid="file-zip">
      <div className="pb-2 text-[12px] text-[var(--text-muted)]">
        {entries.length} entr{entries.length === 1 ? "y" : "ies"}
        {truncated ? " (first ones only)" : ""}
      </div>
      <ul className="k2-tile rounded-[14px] overflow-hidden">
        {entries.map((e, i) => (
          <li
            key={`${e.name}-${i}`}
            className="flex items-center gap-2 px-3 py-2 text-[13px] border-b border-[var(--border)] last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text)]">
              {e.name}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--text-muted)] tabular-nums">
              {e.is_dir ? "folder" : formatBytes(e.size)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
