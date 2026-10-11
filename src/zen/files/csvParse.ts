// Port of desktop `FileViewerPane/csvParse.ts`. RFC4180-ish: quoted
// fields, doubled quotes, CRLF. Not a streaming CSV library; good enough
// for agent artifacts.

export interface ParseDelimitedOptions {
  /** Field separator. Default comma. Use "\t" for TSV. */
  delimiter?: string;
  /** Max rows to return (header included). 0 = unlimited. */
  maxRows?: number;
}

export interface ParseDelimitedResult {
  rows: string[][];
  /** True when the input had more rows than maxRows allowed. */
  truncated: boolean;
}

/** Parse delimited text into a 2D string array. Empty input → no rows. */
export function parseDelimited(
  text: string,
  options: ParseDelimitedOptions = {}
): ParseDelimitedResult {
  const delimiter = options.delimiter ?? ",";
  const maxRows = options.maxRows ?? 0;

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let truncated = false;
  const len = text.length;

  const pushRow = (): boolean => {
    // A final newline leaves one empty row: drop it.
    if (row.length === 0 && field === "" && rows.length > 0 && !inQuotes) {
      return true;
    }
    if (maxRows > 0 && rows.length >= maxRows) {
      truncated = true;
      row = [];
      field = "";
      return false;
    }
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    return true;
  };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // CRLF or a bare CR/LF ends the row.
      if (ch === "\r" && i + 1 < len && text[i + 1] === "\n") i += 1;
      if (!pushRow()) break;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Final row of a file without a trailing newline.
  if (!truncated && (field.length > 0 || row.length > 0 || inQuotes)) {
    pushRow();
  }

  return { rows, truncated };
}

/** Table preview row cap (desktop PRD: ~5k). Phones get fewer. */
export const CSV_PREVIEW_MAX_ROWS = 2000;
