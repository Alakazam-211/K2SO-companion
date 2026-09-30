/** DEBUG-only shape of GET /cli/companion/projects-summary.
 *  Never carries a token, an auth header, or the raw body. */

export type SummarySample = { name: string; path: string };

export type SummaryDump = {
  status: number | null;
  top: string;
  rowCount: number | null;
  rowKeys: string[];
  samples: SummarySample[];
  note: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function describeTop(data: unknown): string {
  if (data === undefined) return "none";
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  if (typeof data === "object") {
    const keys = Object.keys(data as object);
    return keys.length ? `object keys: ${keys.join(", ")}` : "object (no keys)";
  }
  return typeof data;
}

function pickRows(data: unknown): { rows: unknown[] | null; from: string | null } {
  if (Array.isArray(data)) return { rows: data, from: null };
  if (!isRecord(data)) return { rows: null, from: null };
  const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v)) as [
    string,
    unknown[],
  ][];
  if (arrays.length === 0) return { rows: null, from: null };
  arrays.sort((a, b) => b[1].length - a[1].length);
  const [from, rows] = arrays[0];
  return { rows, from };
}

function sampleOf(row: unknown): SummarySample {
  if (!isRecord(row)) return { name: "", path: "" };
  return {
    name: typeof row.name === "string" ? row.name : "",
    path: typeof row.path === "string" ? row.path : "",
  };
}

/** Summarise a parsed body. Drops every field except name/path on samples. */
export function summariseProjectsSummary(
  status: number | null,
  data: unknown,
  note: string | null = null
): SummaryDump {
  const top = describeTop(data);
  const { rows, from } = pickRows(data);
  const shaped = from ? `${top}; rows from ${from}` : top;
  const first = rows && rows.length > 0 ? rows[0] : null;
  const rowKeys = isRecord(first) ? Object.keys(first) : [];
  return {
    status,
    top: shaped,
    rowCount: rows ? rows.length : null,
    rowKeys,
    samples: rows ? rows.slice(0, 8).map(sampleOf) : [],
    note,
  };
}
