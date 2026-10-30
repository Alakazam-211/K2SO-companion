// Prompt stash sync wire adapter (K2 0.46.7 `stash-sync-v1`, the pinned
// contract, 2026-10-30). Records travel in the shared stash shape
// (`zen/stash/stashModel`, snake_case, v:1); this module only knows the
// routes, the replies and the frame.
//
//   GET  /cli/me/stash?deviceId=<id>&since=<cursor>
//        → {ok, cursor:<int>, full, changes:[record…]}
//        `full:true` (no / stale / ahead `since`): the whole live set, no
//        tombstones. Otherwise every change after `since`, tombstones
//        included, oldest first.
//   POST /cli/me/stash/push {deviceId, changes:[record…]}
//        → {ok, cursor, applied:<count>, superseded:<count>,
//           rejected:[{item, reason}]}
//        ≤ 200 records and < 4 MiB a push (413 above). Tombstones apply
//        first. 409 `device_not_registered`, 410 `device_removed` (the
//        Homes registry: there is no stash one).
// Frame on the person's `/cli/sessions/events` sockets:
// `{kind:"stash_changed", cursor}` (no content).

import type { ServerScope } from "./scope";
import { syncCall, type SyncResult } from "./homesSync";
import { parseStashItem, type StashItem } from "../zen/stash/stashModel";

export const FEATURE_STASH_SYNC = "stash-sync-v1";

/** A push's limits (§5): records, and the body (under 4 MiB, with room). */
export const STASH_PUSH_MAX_RECORDS = 200;
export const STASH_PUSH_MAX_BYTES = 3.5 * 1024 * 1024;

export type StashPullReply = { cursor: number | null; full: boolean; changes: StashItem[] };
export type StashPushReply = {
  cursor: number | null;
  applied: number;
  superseded: number;
  /** Refused records by id, with the server's reason (`cap_reached`, …). */
  rejected: { id: string | null; reason: string }[];
};

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function parseStashPull(raw: unknown): StashPullReply {
  const o = obj(raw) ?? {};
  const changes = Array.isArray(o.changes)
    ? o.changes.flatMap((c) => {
        const item = parseStashItem(c);
        return item ? [item] : [];
      })
    : [];
  return { cursor: int(o.cursor), full: o.full === true, changes };
}

export function parseStashPush(raw: unknown): StashPushReply {
  const o = obj(raw) ?? {};
  const rejected = Array.isArray(o.rejected)
    ? o.rejected.map((r) => {
        const x = obj(r) ?? {};
        const item = obj(x.item);
        return {
          id: item && typeof item.id === "string" ? item.id : null,
          reason: typeof x.reason === "string" ? x.reason : "rejected",
        };
      })
    : [];
  return { cursor: int(o.cursor), applied: int(o.applied) ?? 0, superseded: int(o.superseded) ?? 0, rejected };
}

export function pullStash(scope: ServerScope, deviceId: string, since: number | null): Promise<SyncResult<StashPullReply>> {
  const query: Record<string, string> = { deviceId };
  if (since !== null && Number.isInteger(since) && since >= 0) query.since = String(since);
  return syncCall(scope, "/cli/me/stash", parseStashPull, { query });
}

export function pushStash(scope: ServerScope, deviceId: string, changes: StashItem[]): Promise<SyncResult<StashPushReply>> {
  return syncCall(scope, "/cli/me/stash/push", parseStashPush, { method: "POST", body: { deviceId, changes } });
}

/** Split records into pushes under the limits (§5), in order. */
export function stashPushBatches(records: StashItem[]): StashItem[][] {
  const out: StashItem[][] = [];
  let batch: StashItem[] = [];
  let bytes = 0;
  for (const r of records) {
    const size = JSON.stringify(r).length;
    if (batch.length && (batch.length >= STASH_PUSH_MAX_RECORDS || bytes + size > STASH_PUSH_MAX_BYTES)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(r);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

// ─── Frame ───

/** `{kind:"stash_changed", cursor}` → its cursor (null when absent);
 *  undefined for any other frame. */
export function parseStashFrame(frame: unknown): { cursor: number | null } | undefined {
  const o = obj(frame);
  if (!o) return undefined;
  const name = o.kind ?? o.type ?? o.t ?? o.event;
  if (name !== "stash_changed") return undefined;
  const data = obj(o.data) ?? obj(o.payload) ?? {};
  return { cursor: int(o.cursor ?? data.cursor) };
}

type FrameListener = (serverId: string, cursor: number | null) => void;
const frameListeners = new Set<FrameListener>();

/** Sockets call this for every frame; true when it was `stash_changed`. */
export function emitStashFrame(serverId: string, frame: unknown): boolean {
  const parsed = parseStashFrame(frame);
  if (!parsed || !serverId) return false;
  for (const fn of [...frameListeners]) {
    try {
      fn(serverId, parsed.cursor);
    } catch {
      /* never breaks a socket */
    }
  }
  return true;
}

export function onStashFrame(fn: FrameListener): () => void {
  frameListeners.add(fn);
  return () => {
    frameListeners.delete(fn);
  };
}
