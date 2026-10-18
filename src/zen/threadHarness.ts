// The LLM of the session a Thread belongs to: the Thread's
// `conversation_id` is the harness conversation id, and the workspace's
// chat history (`GET /cli/chat/list`) names each conversation's
// `provider`. Works with no live PTY. One read per server + workspace,
// re-read at most every few minutes.

import { useEffect, useState } from "react";
import { getChatList } from "../api/client";
import type { ServerScope } from "../api/scope";
import { parseChatList } from "./sessionHistory";
import { recallHarness, rememberHarness } from "./harnessMemory";

const FRESH_MS = 5 * 60_000;
/** A conversation the last read did not list (a session just started, or
 *  switched to) re-reads once this long after it. */
const MISS_RETRY_MS = 10_000;

type Read = { at: number; byConv: Record<string, string> };
const reads = new Map<string, Read>();
const inflight = new Map<string, Promise<Read | null>>();

/** Test hook. */
export function resetThreadHarness(): void {
  reads.clear();
  inflight.clear();
}

function convKey(serverId: string, conversationId: string): string {
  return `${serverId}|conv:${conversationId}`;
}

async function readProviders(scope: ServerScope, path: string, conv: string): Promise<Read | null> {
  const key = `${scope.id}|${path}`;
  const have = reads.get(key);
  const age = have ? Date.now() - have.at : Infinity;
  if (have && age < FRESH_MS && (have.byConv[conv] || age < MISS_RETRY_MS)) return have;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const r = await getChatList(scope, path);
      if (!r.ok) return have ?? null;
      const byConv: Record<string, string> = {};
      for (const c of parseChatList(r.data)) if (c.provider) byConv[c.id] = c.provider;
      const read = { at: Date.now(), byConv };
      reads.set(key, read);
      return read;
    } catch {
      return have ?? null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** The open Thread's own LLM, or null while unknown. */
export function useThreadHarness(
  scope: ServerScope | null,
  path: string | null | undefined,
  conversationId: string | null | undefined
): string | null {
  const serverId = scope?.id ?? "";
  const conv = (conversationId || "").trim();
  const where = (path || "").trim();
  const memoKey = serverId && conv ? convKey(serverId, conv) : "";
  const [found, setFound] = useState<{ key: string; harness: string | null }>({ key: "", harness: null });

  useEffect(() => {
    if (!scope || !memoKey || !where) return;
    let alive = true;
    void readProviders(scope, where, conv).then((read) => {
      if (!alive) return;
      const harness = read?.byConv[conv] ?? null;
      if (harness) rememberHarness(memoKey, harness);
      setFound((f) => (f.key === memoKey && f.harness === harness ? f : { key: memoKey, harness }));
    });
    return () => {
      alive = false;
    };
    // `scope` is read, not watched: its server id is in memoKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoKey, where, conv]);

  if (!memoKey) return null;
  return (found.key === memoKey ? found.harness : null) ?? recallHarness(memoKey);
}
