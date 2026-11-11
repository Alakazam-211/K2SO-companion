// The chat's views (Rosson 2026-11-11, a test): K2 Projects' agent-tile
// switch (prd-projects-threads-v1 P3, K2 5f6c68ee21 / d082de924d) on the
// phone's chat header: Terminal, Thread, Chatter, Heartbeats, Thread by
// default. The pure parts are ported from K2's
// src/renderer/components/SessionView/threadPanels.ts and overlayThread.ts
// (main, 2026-11-11) so both say the same.
//
// Data:
//   - Chatter: `GET /cli/chatter?addr=&limit=`, the agent's Chatter
//     collection (messages between this agent and other agents), oldest
//     first.
//   - Heartbeats: `GET /cli/heartbeat/fires-list?project=&limit=50`, no live
//     stream: re-read every 15 s while open (as K2 does).

export type ThreadView = "terminal" | "thread" | "chatter" | "heartbeats";

export const THREAD_VIEW_LABEL: Record<ThreadView, string> = {
  terminal: "Terminal",
  thread: "Thread",
  chatter: "Chatter",
  heartbeats: "Heartbeats",
};

/** One line under the panel's title: what it holds (K2's words). */
export const THREAD_PANEL_HINT: Record<"chatter" | "heartbeats", string> = {
  chatter: "Messages between this agent and other agents",
  heartbeats: "Heartbeats and other outside input that woke this workspace",
};

// ── Chatter ─────────────────────────────────────────────────────────────

export const CHATTER_PAGE = 50;
/** No push on the phone yet: re-read this often while Chatter is open. */
export const CHATTER_REFRESH_MS = 10_000;
export const CHATTER_LINE_MAX = 140;

export type ChatterItem = {
  id: string;
  seq: number;
  from: string;
  to: string | null;
  body: string;
  summary: string;
  /** Seconds since the epoch. */
  at: number | null;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `/cli/chatter`'s snapshot: the Chatter collection only, never Thread
 *  (K2's chatterItemsFromSnapshot), oldest first by seq. */
export function chatterFromSnapshot(raw: unknown): { items: ChatterItem[]; hasMore: boolean } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rows = Array.isArray(obj.items) ? obj.items : [];
  const items: ChatterItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.collection !== undefined && r.collection !== "chatter") continue;
    const doc = r.doc && typeof r.doc === "object" ? (r.doc as Record<string, unknown>) : null;
    const id = str(r.id) || str(doc?.id);
    const seq = typeof r.seq === "number" ? r.seq : typeof doc?.seq === "number" ? (doc.seq as number) : NaN;
    if (!doc || !id || !Number.isFinite(seq)) continue;
    const at = typeof doc.created_at === "number" && Number.isFinite(doc.created_at) ? doc.created_at : null;
    items.push({
      id,
      seq,
      from: str(doc.from).trim() || "unknown",
      to: str(doc.to).trim() || null,
      body: str(doc.body ?? doc.text),
      summary: str(doc.summary),
      at,
    });
  }
  items.sort((a, b) => a.seq - b.seq || (a.at ?? 0) - (b.at ?? 0));
  return { items, hasMore: obj.has_more === true };
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** The row's one line: the sender's summary, else the body's first line. */
export function chatterLine(item: Pick<ChatterItem, "summary" | "body">): string {
  const raw = item.summary.trim() || firstLine(item.body);
  if (!raw) return "(no text)";
  return raw.length > CHATTER_LINE_MAX ? `${raw.slice(0, CHATTER_LINE_MAX - 1).trimEnd()}…` : raw;
}

// ── Heartbeats ──────────────────────────────────────────────────────────

export const HEARTBEAT_FIRES_LIMIT = 50;
export const HEARTBEAT_FIRES_REFRESH_MS = 15_000;

export type HeartbeatTone = "ok" | "warn" | "error" | "muted";

export type HeartbeatRow = {
  id: string;
  /** Seconds since the epoch. */
  at: number;
  source: string;
  status: string;
  tone: HeartbeatTone;
  detail: string | null;
};

const DECISION_LABEL: Record<string, string> = {
  fired: "Ran",
  fired_catchup: "Ran late",
  no_work: "Nothing to do",
  error: "Failed",
  wakeup_file_missing: "Wakeup file missing",
  schedule_invalid: "Schedule invalid",
  auto_disabled: "Turned off",
  auto_disabled_failing: "Turned off after failures",
  tick_gap: "Missed while asleep",
};

export function heartbeatDecisionLabel(decision: string): string {
  if (DECISION_LABEL[decision]) return DECISION_LABEL[decision];
  if (decision.startsWith("skipped_")) return "Skipped";
  const plain = decision.replace(/_/g, " ").trim();
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : "Unknown";
}

export function heartbeatDecisionTone(decision: string): HeartbeatTone {
  if (decision === "fired") return "ok";
  if (decision === "fired_catchup") return "warn";
  if (decision.startsWith("skipped_") || decision === "no_work") return "muted";
  if (DECISION_LABEL[decision]) return "error";
  return "muted";
}

/** `firedAt` (ISO, or SQLite's `YYYY-MM-DD HH:MM:SS` in UTC) → seconds. */
export function firedAtSeconds(firedAt: string): number | null {
  const raw = firedAt.trim();
  if (!raw) return null;
  const iso =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** `/cli/heartbeat/fires-list` as rows, oldest first. A `changed` row is an
 *  edit to a heartbeat, not a wake: left out (K2's heartbeatInputRows). */
export function heartbeatRows(raw: unknown): HeartbeatRow[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { fires?: unknown }).fires)
      ? ((raw as { fires: unknown[] }).fires)
      : [];
  const rows: HeartbeatRow[] = [];
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    const decision = str(r.decision);
    if (!decision || decision === "changed") continue;
    const at = firedAtSeconds(str(r.firedAt));
    if (at === null) continue;
    const agent = str(r.agentName).trim();
    const schedule = str(r.scheduleName).trim();
    const reason = str(r.reason).trim();
    rows.push({
      id: String(r.id ?? `${at}-${schedule}`),
      at,
      source: agent && schedule ? `${agent} / ${schedule}` : schedule || agent || "Workspace",
      status: heartbeatDecisionLabel(decision),
      tone: heartbeatDecisionTone(decision),
      detail: reason || null,
    });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}
