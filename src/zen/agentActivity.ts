// Agent status for the Chats list: a pulse and counts per row.
//
// Source: `GET /cli/activity/snapshot` (K2 0.45.0+). One row per live v2
// session (`sessionId` = the PTY id) and one rollup per workspace (the
// highest display: waiting > working > monitoring > unverifiable > idle).
// `counts {subagents, tools, commands}` arrived in 0.45.2; missing = zeros.
//
// A main chat row reads only its main session(s): the `isMainChat` PTY ids
// from GET /cli/companion/sessions (`terminalId` = activity `sessionId`).
// Unknown ids fall back to the workspace's sessions minus the ones known
// not to be main (sidecars, desktop tabs, heartbeats). Counts are summed
// over busy sessions (desktop Zen Agents widget, `zen-counts.ts`).
// A sidecar row reads its own session: by `terminalId`, else by its addr
// suffix (the activity `agentName`) in the same workspace.

export type ActivityDisplay = "working" | "monitoring" | "waiting" | "unverifiable" | "idle";

export type ActivityCounts = { subagents: number; tools: number; commands: number };

export type RowActivity = { display: ActivityDisplay; counts: ActivityCounts };

/** `harness` is the snapshot's LLM id for that PTY (`claude`, `grok`, …). */
export type SessionActivity = RowActivity & { path?: string; agentName?: string; harness?: string };

export type ActivitySnapshot = {
  byPath: Record<string, RowActivity>;
  bySession: Record<string, SessionActivity>;
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
  const bySession: Record<string, SessionActivity> = {};
  const summed: Record<string, ActivityCounts> = {};
  for (const raw of Array.isArray(b.rows) ? b.rows : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const d = display(r.display);
    if (!d) continue;
    const counts = countsOf(r.counts);
    if (typeof r.sessionId === "string" && r.sessionId) {
      bySession[r.sessionId] = {
        display: d,
        counts,
        ...(typeof r.workspacePath === "string" && r.workspacePath
          ? { path: trimPath(r.workspacePath) }
          : {}),
        ...(typeof r.agentName === "string" && r.agentName ? { agentName: r.agentName } : {}),
        ...(typeof r.harness === "string" && r.harness ? { harness: r.harness } : {}),
      };
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

/** Which live PTYs are main chats, from GET /cli/companion/sessions. */
export type ChatSessions = {
  /** Main-chat `terminalId`s per workspace path (`isMainChat: true`). */
  mainByPath: Record<string, string[]>;
  /** Every other `terminalId`: sidecars, desktop tabs, heartbeats. */
  notMain: Record<string, true>;
};

export const NO_CHAT_SESSIONS: ChatSessions = { mainByPath: {}, notMain: {} };

export function chatSessionsOf(
  sessions: { cwd?: unknown; isMainChat?: unknown; terminalId?: unknown }[]
): ChatSessions {
  const mainByPath: Record<string, string[]> = {};
  const notMain: Record<string, true> = {};
  for (const s of sessions) {
    const id = typeof s.terminalId === "string" ? s.terminalId.trim() : "";
    if (!id) continue;
    const path = typeof s.cwd === "string" ? trimPath(s.cwd.trim()) : "";
    if (s.isMainChat === true && path) (mainByPath[path] ??= []).push(id);
    else notMain[id] = true;
  }
  return { mainByPath, notMain };
}

const RANK: Record<ActivityDisplay, number> = {
  waiting: 4,
  working: 3,
  monitoring: 2,
  unverifiable: 1,
  idle: 0,
};

/** Rollup of some sessions: the highest display, counts of the busy ones. */
function rollup(rows: RowActivity[]): RowActivity {
  let d: ActivityDisplay = "idle";
  const counts = { subagents: 0, tools: 0, commands: 0 };
  for (const r of rows) {
    if (RANK[r.display] > RANK[d]) d = r.display;
    if (!isBusy(r.display)) continue;
    counts.subagents += r.counts.subagents;
    counts.tools += r.counts.tools;
    counts.commands += r.counts.commands;
  }
  return { display: d, counts };
}

function mainActivity(
  path: string,
  snap: ActivitySnapshot,
  sessions: ChatSessions
): RowActivity | undefined {
  const here = Object.entries(snap.bySession).filter(([, r]) => r.path === path);
  // No session rows for the workspace at all: only the rollup is left.
  if (!here.length) return snap.byPath[path];
  const mainIds = sessions.mainByPath[path] ?? [];
  let mine = here.filter(([id]) => mainIds.includes(id));
  if (!mine.length) mine = here.filter(([id]) => !sessions.notMain[id]);
  return mine.length ? rollup(mine.map(([, r]) => r)) : undefined;
}

function sidecarActivity(
  row: { path?: string; terminalId?: string | null; addr?: string | null },
  snap: ActivitySnapshot
): SessionActivity | undefined {
  const byId = row.terminalId ? snap.bySession[row.terminalId] : undefined;
  if (byId) return byId;
  // terminalId is often null at list time (remembered sidecars, a PTY
  // spawned later). The activity agentName is the addr suffix.
  const addr = (row.addr || "").trim();
  const suffix = addr.split("/").slice(1).join("/");
  if (!suffix || !row.path) return undefined;
  const path = trimPath(row.path);
  return Object.values(snap.bySession).find(
    (r) =>
      r.path === path &&
      (r.agentName === suffix || r.agentName === addr || !!r.agentName?.endsWith(`/${suffix}`))
  );
}

/** The LLM a chat row runs (its session's snapshot `harness`), busy or
 *  idle. Main: the main-chat PTY, else the workspace's one non-sidecar
 *  session. Null when unknown or ambiguous (several candidates). */
export function harnessForRow(
  row: { path?: string; terminalId?: string | null; addr?: string | null },
  snap: ActivitySnapshot,
  isExtra: boolean,
  sessions: ChatSessions = NO_CHAT_SESSIONS
): string | null {
  if (isExtra) return sidecarActivity(row, snap)?.harness ?? null;
  if (!row.path) return null;
  const path = trimPath(row.path);
  const here = Object.entries(snap.bySession).filter(([, r]) => r.path === path && !!r.harness);
  const mainIds = sessions.mainByPath[path] ?? [];
  let mine = here.filter(([id]) => mainIds.includes(id));
  if (!mine.length) mine = here.filter(([id]) => !sessions.notMain[id]);
  const kinds = new Set(mine.map(([, r]) => r.harness));
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/** The activity a Chats row shows, or null (idle or unknown). */
export function activityForRow(
  row: { path?: string; terminalId?: string | null; addr?: string | null },
  snap: ActivitySnapshot,
  isExtra: boolean,
  sessions: ChatSessions = NO_CHAT_SESSIONS
): RowActivity | null {
  const hit = isExtra
    ? sidecarActivity(row, snap)
    : row.path
      ? mainActivity(trimPath(row.path), snap, sessions)
      : undefined;
  return hit && isBusy(hit.display) ? hit : null;
}

function sameCounts(a: ActivityCounts, b: ActivityCounts): boolean {
  return a.subagents === b.subagents && a.tools === b.tools && a.commands === b.commands;
}

function sameRows(
  a: Record<string, SessionActivity>,
  b: Record<string, SessionActivity>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const x = a[k];
    const y = b[k];
    return (
      !!y &&
      x.display === y.display &&
      x.path === y.path &&
      x.agentName === y.agentName &&
      x.harness === y.harness &&
      sameCounts(x.counts, y.counts)
    );
  });
}

/** Cheap structural compare, so an unchanged poll does not re-render. */
export function sameActivity(a: ActivitySnapshot, b: ActivitySnapshot): boolean {
  return sameRows(a.byPath, b.byPath) && sameRows(a.bySession, b.bySession);
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

/** A pin's tiny status line: "Working · 20" (all counts summed), "Needs you". */
export function activityPinText(a: RowActivity): string {
  const word =
    a.display === "waiting" ? "Needs you" : a.display === "monitoring" ? "Monitoring" : "Working";
  const n = a.counts.subagents + a.counts.tools + a.counts.commands;
  return n > 0 ? `${word} · ${n}` : word;
}

/** Status colour for a busy agent: amber needs you, accent monitoring, green working. */
export function activityColor(a: RowActivity): string {
  return a.display === "waiting"
    ? "var(--warning)"
    : a.display === "monitoring"
      ? "var(--accent)"
      : "var(--success)";
}
