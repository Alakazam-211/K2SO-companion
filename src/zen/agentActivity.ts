// Agent status for the Chats list: a pulse and counts per row.
//
// Source: `GET /cli/activity/snapshot` (K2 0.45.0+). One row per live v2
// session (`sessionId` = the PTY id) and one rollup per workspace (the
// highest display: waiting > working > monitoring > unverifiable > idle).
// `counts {subagents, tools, commands}` arrived in 0.45.2; missing = zeros.
//
// A main chat row reads its workspace rollup, with counts summed over the
// workspace's busy sessions (desktop Zen Agents widget, `zen-counts.ts`).
// A sidecar row reads its own session by `terminalId`.

export type ActivityDisplay = "working" | "monitoring" | "waiting" | "unverifiable" | "idle";

export type ActivityCounts = { subagents: number; tools: number; commands: number };

export type RowActivity = { display: ActivityDisplay; counts: ActivityCounts };

export type ActivitySnapshot = {
  byPath: Record<string, RowActivity>;
  bySession: Record<string, RowActivity>;
};

export const EMPTY_ACTIVITY: ActivitySnapshot = { byPath: {}, bySession: {} };

const DISPLAYS: readonly ActivityDisplay[] = [
  "working",
  "monitoring",
  "waiting",
  "unverifiable",
  "idle",
];

function display(v: unknown): ActivityDisplay | null {
  return DISPLAYS.find((d) => d === v) ?? null;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function countsOf(v: unknown): ActivityCounts {
  const c = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { subagents: n(c.subagents), tools: n(c.tools), commands: n(c.commands) };
}

export function isBusy(d: ActivityDisplay): boolean {
  return d === "working" || d === "monitoring" || d === "waiting";
}

function trimPath(p: string): string {
  return p.replace(/\/+$/, "");
}

export function parseActivitySnapshot(body: unknown): ActivitySnapshot {
  if (!body || typeof body !== "object") return EMPTY_ACTIVITY;
  const b = body as { rows?: unknown; workspaces?: unknown };
  const bySession: Record<string, RowActivity> = {};
  const summed: Record<string, ActivityCounts> = {};
  for (const raw of Array.isArray(b.rows) ? b.rows : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const d = display(r.display);
    if (!d) continue;
    const counts = countsOf(r.counts);
    if (typeof r.sessionId === "string" && r.sessionId) {
      bySession[r.sessionId] = { display: d, counts };
    }
    // An idle session's finished turn is not "now".
    if (isBusy(d) && typeof r.workspacePath === "string" && r.workspacePath) {
      const key = trimPath(r.workspacePath);
      const s = summed[key] ?? { subagents: 0, tools: 0, commands: 0 };
      summed[key] = {
        subagents: s.subagents + counts.subagents,
        tools: s.tools + counts.tools,
        commands: s.commands + counts.commands,
      };
    }
  }
  const byPath: Record<string, RowActivity> = {};
  for (const raw of Array.isArray(b.workspaces) ? b.workspaces : []) {
    if (!raw || typeof raw !== "object") continue;
    const w = raw as Record<string, unknown>;
    const d = display(w.display);
    if (!d || typeof w.workspacePath !== "string" || !w.workspacePath) continue;
    const key = trimPath(w.workspacePath);
    byPath[key] = {
      display: d,
      counts: summed[key] ?? { subagents: 0, tools: 0, commands: 0 },
    };
  }
  return { byPath, bySession };
}

/** The activity a Chats row shows, or null (idle or unknown). */
export function activityForRow(
  row: { path?: string; terminalId?: string | null; addr?: string | null },
  snap: ActivitySnapshot,
  isExtra: boolean
): RowActivity | null {
  const hit = isExtra
    ? row.terminalId
      ? snap.bySession[row.terminalId]
      : undefined
    : row.path
      ? snap.byPath[trimPath(row.path)]
      : undefined;
  return hit && isBusy(hit.display) ? hit : null;
}

/** "2 subagents · 14 tools · 5 commands"; zero parts left out; null if none. */
export function countsText(c: ActivityCounts | null | undefined): string | null {
  if (!c) return null;
  const part = (v: number, one: string) => (v > 0 ? `${v} ${one}${v === 1 ? "" : "s"}` : null);
  const parts = [
    part(c.subagents, "subagent"),
    part(c.tools, "tool"),
    part(c.commands, "command"),
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : null;
}

/** The row's status line: "Working · 14 tools · 5 commands", "Needs you". */
export function activityRowText(a: RowActivity): string {
  const word =
    a.display === "waiting" ? "Needs you" : a.display === "monitoring" ? "Monitoring" : "Working";
  const counts = countsText(a.counts);
  return counts ? `${word} · ${counts}` : word;
}
