// Chat open timing (diagnostics): for each open, how long from the tap to
// the cached paint, to the server's answer, and from that answer to the
// frame that drew it, plus the payload size and item count. In memory
// only (a ring buffer, readable from Server settings → Diagnostics);
// `console.debug` in dev builds.

export const TIMING_RING_MAX = 50;
/** An open with no server answer after this long is closed as is. */
const OPEN_STALE_MS = 60_000;

export type ChatOpenTiming = {
  id: number;
  serverId: string;
  /** Room key without the server (`t:<addr>` / `g:<groupId>`). */
  room: string;
  kind: "thread" | "project";
  /** Wall clock at the tap (ms since epoch). */
  at: number;
  /** Tap → cached messages on screen; null = no cached copy. */
  cachedMs: number | null;
  cachedFrom: "memory" | "device" | null;
  cachedCount: number | null;
  /** Tap → server answer; null = none yet. */
  responseMs: number | null;
  /** Server answer → next frame drawn with it. */
  paintMs: number | null;
  /** Answer size (JSON length; approximate when the transport hides it). */
  bytes: number | null;
  /** Items in the answer. */
  items: number | null;
  ok: boolean | null;
  error: string | null;
};

const ring: ChatOpenTiming[] = [];
const listeners = new Set<() => void>();
let nextId = 1;
const clock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
const startedAt = new Map<number, number>();

function emit(): void {
  for (const fn of listeners) fn();
}

function devLog(t: ChatOpenTiming, phase: string): void {
  if (!import.meta.env?.DEV) return;
  console.debug(`[chat-open] ${phase} ${t.kind} ${t.room}`, {
    cachedMs: t.cachedMs,
    cachedFrom: t.cachedFrom,
    responseMs: t.responseMs,
    paintMs: t.paintMs,
    bytes: t.bytes,
    items: t.items,
  });
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function find(id: number): ChatOpenTiming | undefined {
  return ring.find((t) => t.id === id);
}

/** An open began (the tap). Reuses a fresh, unanswered open of the same
 *  room (a room's list load hands over to the chat's own read). */
export function beginChatOpen(serverId: string, roomKey: string, kind: "thread" | "project"): number {
  const room = roomKey.slice(roomKey.indexOf("|") + 1);
  const t0 = clock();
  const open = ring.find(
    (t) =>
      t.serverId === serverId &&
      t.room === room &&
      t.responseMs == null &&
      t0 - (startedAt.get(t.id) ?? -Infinity) < OPEN_STALE_MS
  );
  if (open) return open.id;
  const t: ChatOpenTiming = {
    id: nextId++,
    serverId,
    room,
    kind,
    at: Date.now(),
    cachedMs: null,
    cachedFrom: null,
    cachedCount: null,
    responseMs: null,
    paintMs: null,
    bytes: null,
    items: null,
    ok: null,
    error: null,
  };
  startedAt.set(t.id, t0);
  ring.unshift(t);
  while (ring.length > TIMING_RING_MAX) {
    const gone = ring.pop();
    if (gone) startedAt.delete(gone.id);
  }
  emit();
  return t.id;
}

export function noteCachedPaint(id: number, from: "memory" | "device", count: number): void {
  const t = find(id);
  const s = startedAt.get(id);
  if (!t || s == null || t.cachedMs != null) return;
  t.cachedMs = round(clock() - s);
  t.cachedFrom = from;
  t.cachedCount = count;
  devLog(t, "cached");
  emit();
}

/** The server answered (or failed). Then, after the store applied it,
 *  `notePainted` on the next frame. */
export function noteResponse(
  id: number,
  r: { ok: boolean; items?: number | null; bytes?: number | null; error?: string | null }
): void {
  const t = find(id);
  const s = startedAt.get(id);
  if (!t || s == null || t.responseMs != null) return;
  t.responseMs = round(clock() - s);
  t.ok = r.ok;
  t.items = r.items ?? null;
  t.bytes = r.bytes ?? null;
  t.error = r.error ?? null;
  emit();
}

/** Call right after the answer went into the store: records the next
 *  animation frame (≈ the paint that shows it). */
export function notePaintAfterResponse(id: number): void {
  const t = find(id);
  const s = startedAt.get(id);
  if (!t || s == null || t.responseMs == null) return;
  const answeredAt = s + t.responseMs;
  const done = () => {
    if (t.paintMs != null) return;
    t.paintMs = round(clock() - answeredAt);
    devLog(t, "painted");
    emit();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(done);
  else setTimeout(done, 0);
}

/** Newest first. */
export function chatOpenTimings(serverId?: string | null): ChatOpenTiming[] {
  const all = ring.map((t) => ({ ...t }));
  return serverId ? all.filter((t) => t.serverId === serverId) : all;
}

export function subscribeChatTimings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only. */
export function resetChatTimings(): void {
  ring.length = 0;
  startedAt.clear();
  nextId = 1;
  emit();
}

/** Payload size when the transport does not say: the parsed body's JSON
 *  length (close to the wire size for these bodies). */
export function approxBytes(data: unknown): number | null {
  try {
    const s = JSON.stringify(data);
    return typeof s === "string" ? s.length : null;
  } catch {
    return null;
  }
}
