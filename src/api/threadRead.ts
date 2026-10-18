// thread-read-v1 (K2 0.46.1): a PERSON's unread counts, read cursors and
// mutes for Threads and project chats. Wire contract:
//   GET  /cli/thread/unread[?kind=thread|project]
//        → {ok, person, total, waitingTotal, byConversation:[State…], muted:[…]}
//   POST /cli/thread/read          {conversationId | addr, seq?}
//   POST /cli/project-group/read   {group, seq?}
//   POST /cli/thread/mute          {kind?, id | conversationId | addr | group, muted, until?}
//        → {ok, changed, …State, total, waitingTotal}
// `State` = {kind, id, projectId?, seq, lastReadSeq, lastSeq, unread,
// waiting, muted, mutedUntil?}. Only the owner token or a Connect login may
// call (agents 403). Callers gate on `/boot-status` `thread-read-v1`.
//
// Parsing lives in `zen/unread.ts`; this module only moves bytes on the
// scope it is given (never the active server's by accident).

import type { ApiResponse } from "./client";
import { NOT_CONNECTED, scopedFetch } from "./scopedFetch";
import type { ServerScope } from "./scope";

export const FEATURE_THREAD_READ = "thread-read-v1";

function errorOf(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string | { code?: string; hint?: string } };
    const e = j?.error;
    if (typeof e === "string" && e) return e;
    if (e && typeof e === "object") return e.hint || e.code || `HTTP ${status}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${status}`;
}

async function call(
  scope: ServerScope,
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; revive?: boolean } = {}
): Promise<ApiResponse<unknown>> {
  try {
    const out = await scopedFetch(scope, path, {
      method: opts.method ?? "GET",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      timeoutMs: 10_000,
      revive: opts.revive,
    });
    if (!out.ok) return { ok: false, error: errorOf(out.status, out.text), status: out.status };
    return { ok: true, data: JSON.parse(out.text) as unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg === NOT_CONNECTED) return { ok: false, error: NOT_CONNECTED };
    return { ok: false, error: `Could not reach server: ${msg}` };
  }
}

/** `GET /cli/thread/unread`. A background read: never revives (MA22). */
export function getThreadUnread(scope: ServerScope): Promise<ApiResponse<unknown>> {
  return call(scope, "/cli/thread/unread", { revive: false });
}

/** `POST /cli/thread/read`: a Thread by conversation id (else addr). */
export function postThreadRead(
  scope: ServerScope,
  target: { conversationId?: string | null; addr?: string | null },
  seq?: number
): Promise<ApiResponse<unknown>> {
  const body: Record<string, unknown> = target.conversationId
    ? { conversationId: target.conversationId }
    : { addr: target.addr };
  if (seq !== undefined) body.seq = seq;
  return call(scope, "/cli/thread/read", { method: "POST", body });
}

/** `POST /cli/project-group/read {group, seq?}`. */
export function postProjectRead(
  scope: ServerScope,
  group: string,
  seq?: number
): Promise<ApiResponse<unknown>> {
  return call(scope, "/cli/project-group/read", {
    method: "POST",
    body: seq !== undefined ? { group, seq } : { group },
  });
}

/** `POST /cli/thread/mute`. `until` is unix seconds (absent = until unmuted). */
export function postThreadMute(
  scope: ServerScope,
  target:
    | { kind: "thread"; conversationId?: string | null; addr?: string | null }
    | { kind: "project"; group: string },
  muted: boolean,
  until?: number
): Promise<ApiResponse<unknown>> {
  const body: Record<string, unknown> =
    target.kind === "project"
      ? { kind: "project", group: target.group }
      : target.conversationId
        ? { kind: "thread", conversationId: target.conversationId }
        : { kind: "thread", addr: target.addr };
  body.muted = muted;
  if (muted && until !== undefined) body.until = until;
  return call(scope, "/cli/thread/mute", { method: "POST", body });
}
