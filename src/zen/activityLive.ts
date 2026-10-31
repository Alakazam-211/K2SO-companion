// Agent activity from the hub's `activity_changed` frames (Plan - Phone
// Speed and Battery PRD, A2). The daemon already sends one frame per row
// change on the shared sessions/events socket (at most one per row per
// 100 ms, plus a trailing frame), each with a store-wide gap-free `seq` and
// its `instanceId`:
//   {kind:"activity_changed", seq, instanceId, row|null, removed|null,
//    turnEnded|null, workspace|null}
// and `GET /cli/activity/snapshot` is every row and rollup at a `seq`, so a
// client that seeds from it and then sees `seq + 1` has missed nothing
// (K2 activity_events.rs RL3/RL4). The phone used to drop these frames and
// re-read the snapshot every 5 s.
//
// This keeps a raw mirror of the snapshot per server and applies frames to
// it; the store re-parses the mirror with `parseActivitySnapshot`. A frame
// that doesn't follow on (a gap, another `instanceId`, no mirror yet) asks
// for a snapshot; so does a removal without a rollup (K2 adds the rollup
// to removals in 0.46.8).

type Raw = Record<string, unknown>;

type Mirror = {
  instanceId: string | null;
  seq: number;
  rows: Map<string, Raw>;
  /** Rollups by workspace path (else project id). */
  workspaces: Map<string, Raw>;
  rest: Raw;
};

const mirrors = new Map<string, Mirror>();

function obj(v: unknown): Raw | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

function seqOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function workspaceKey(w: Raw): string | null {
  if (typeof w.workspacePath === "string" && w.workspacePath) return `p:${w.workspacePath}`;
  if (typeof w.projectId === "string" && w.projectId) return `id:${w.projectId}`;
  return null;
}

export function isActivityChangedFrame(frame: unknown): boolean {
  return obj(frame)?.kind === "activity_changed";
}

/** Seed (or replace) a server's mirror from a snapshot body. False when
 *  the body has no usable `seq` (an older daemon): frames can't follow on. */
export function seedActivityMirror(serverId: string, body: unknown): boolean {
  const b = obj(body);
  const seq = seqOf(b?.seq);
  if (!b || seq === null) {
    mirrors.delete(serverId);
    return false;
  }
  const rows = new Map<string, Raw>();
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    const row = obj(r);
    if (row && typeof row.sessionId === "string" && row.sessionId) rows.set(row.sessionId, row);
  }
  const workspaces = new Map<string, Raw>();
  for (const w of Array.isArray(b.workspaces) ? b.workspaces : []) {
    const ws = obj(w);
    const k = ws && workspaceKey(ws);
    if (ws && k) workspaces.set(k, ws);
  }
  const { rows: _r, workspaces: _w, ...rest } = b;
  mirrors.set(serverId, {
    instanceId: typeof b.instanceId === "string" ? b.instanceId : null,
    seq,
    rows,
    workspaces,
    rest,
  });
  return true;
}

export type FrameResult =
  /** Applied; the mirror changed. */
  | "applied"
  /** Applied, but the rollups may be stale (a removal): read a snapshot soon. */
  | "applied-resync"
  /** Already covered (seq at or below the mirror's). */
  | "old"
  /** Doesn't follow on: read a snapshot. */
  | "resync";

export function applyActivityFrame(serverId: string, frame: unknown): FrameResult {
  const f = obj(frame);
  const m = mirrors.get(serverId);
  const seq = seqOf(f?.seq);
  if (!f || !m || seq === null) return "resync";
  const inst = typeof f.instanceId === "string" ? f.instanceId : null;
  if (inst && m.instanceId && inst !== m.instanceId) return "resync";
  if (seq <= m.seq) return "old";
  if (seq !== m.seq + 1) return "resync";
  m.seq = seq;
  const row = obj(f.row);
  if (row && typeof row.sessionId === "string" && row.sessionId) m.rows.set(row.sessionId, row);
  const ws = obj(f.workspace);
  const k = ws && workspaceKey(ws);
  if (ws && k) m.workspaces.set(k, ws);
  if (typeof f.removed === "string" && f.removed) {
    m.rows.delete(f.removed);
    // Before K2 0.46.8 a removal carries no rollup, so its workspace's
    // may now be wrong; with one, the frame is complete.
    return ws && k ? "applied" : "applied-resync";
  }
  return "applied";
}

/** The mirror as a snapshot body (for `parseActivitySnapshot`). */
export function activityMirrorBody(serverId: string): Raw | null {
  const m = mirrors.get(serverId);
  if (!m) return null;
  return { ...m.rest, seq: m.seq, instanceId: m.instanceId, rows: [...m.rows.values()], workspaces: [...m.workspaces.values()] };
}

export function activityMirrorSeq(serverId: string): number | null {
  return mirrors.get(serverId)?.seq ?? null;
}

export function dropActivityMirror(serverId: string): void {
  mirrors.delete(serverId);
}

export function __resetActivityLiveForTests(): void {
  mirrors.clear();
}
