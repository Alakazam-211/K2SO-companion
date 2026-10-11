import { useMemo } from "react";
import { CSV_PREVIEW_MAX_ROWS, parseDelimited } from "./csvParse";
import { isTsvPath } from "./fileCategory";
import { ViewerNote } from "./BinaryEmptyState";

/** CSV/TSV table (desktop `CsvViewer`): sticky header and row numbers,
 *  scrolls both ways inside the viewer. */
export function CsvView({ content, filePath }: { content: string; filePath: string }) {
  const tsv = isTsvPath(filePath);
  const kind = tsv ? "TSV" : "CSV";
  const { rows, truncated } = useMemo(
    () => parseDelimited(content, { delimiter: tsv ? "\t" : ",", maxRows: CSV_PREVIEW_MAX_ROWS }),
    [content, tsv]
  );

  if (rows.length === 0) return <ViewerNote title={`Empty ${kind} file`} />;

  const cols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const header = rows[0];
  const body = rows.slice(1);

  return (
    <div className="flex h-full w-full flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-auto fv-scroll" data-testid="file-csv">
        <table className="fv-table">
          <thead>
            <tr>
              <th className="fv-rownum">#</th>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c}>{header[c] ?? ""}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                <td className="fv-rownum">{ri + 2}</td>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>{row[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 px-4 pt-1.5 text-[11px] text-[var(--text-muted)] fv-safe-bottom">
        {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
        {truncated ? `+ (first ${CSV_PREVIEW_MAX_ROWS.toLocaleString()} shown)` : ""} · {cols} col
        {cols === 1 ? "" : "s"} · {kind}
      </div>
    </div>
  );
}
