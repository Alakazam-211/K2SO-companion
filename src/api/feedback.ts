import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getBaseUrl, getToken } from "./client";
import { useServersStore } from "../stores/servers";
import { isPossibleAuthFailure, reviveServerSession } from "../lib/revive";
import {
  sortNewestFirst,
  type CommentResponse,
  type FeedbackItem,
  type FeedbackListRow,
  type FeedbackProjectRef,
  type FeedbackShow,
} from "./feedbackPure";

// Feedback C3 — companion client for the daemon's `/cli/feedback/*` routes
// (feedback_routes.rs) + the pure list/thread helpers the page renders from.
//
// Wire shapes mirror k2-core's `FeedbackItem`/`FeedbackComment` (camelCase
// serde). The list route is PER-WORKSPACE (`?project=<path>` is required —
// `all=1` only widens the STATUS filter to include resolved/dismissed for
// that ONE project, it is NOT server-wide), so `fetchAllFeedback` fans out
// one GET per registered workspace and tags each row with its host —
// exactly the desktop's fan-out (feedback-api.ts).
//
// client.ts doesn't export its request wrapper (and C2/C3 must not edit
// it), so this module carries its own minimal fetch with the SAME
// stale-session contract: auth-classified rejection → revive (single-flight
// whoami + silent re-login) → replay ONCE only when a fresh token was
// actually minted. URL is rebuilt per attempt so the replay carries it.

// ─── HTTP (cliFetch-parity: revive + replay-once on stale session) ───

async function feedbackFetch<T>(
  path: string,
  opts: {
    method?: "GET" | "POST";
    params?: Record<string, string>;
    body?: unknown;
  } = {},
  timeoutMs = 15000
): Promise<T> {
  const attempt = async (): Promise<{ status: number; ok: boolean; text: string }> => {
    const base = getBaseUrl();
    if (!base) throw new Error("Not connected");
    const params: string[] = [];
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      params.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    const token = getToken();
    if (token) params.push(`token=${encodeURIComponent(token)}`);
    const url = `${base}${path}${params.length ? `?${params.join("&")}` : ""}`;
    const res = await Promise.race([
      tauriFetch(url, {
        method: opts.method ?? "GET",
        headers: { "Content-Type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs)
      ),
    ]);
    return { status: res.status, ok: res.ok, text: await res.text() };
  };

  let out = await attempt();
  if (isPossibleAuthFailure(out.status, out.text)) {
    const serverId = useServersStore.getState().activeServerId;
    if (serverId) {
      const outcome = await reviveServerSession(serverId);
      if (outcome === "revived") out = await attempt();
    }
  }
  if (!out.ok) {
    let msg = `HTTP ${out.status}`;
    try {
      const j = JSON.parse(out.text) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return JSON.parse(out.text) as T;
}

// ─── Endpoints ───

/** GET /cli/feedback/list?project=<path>&all=1 for every registered
 *  workspace, tag rows with their host project, merge newest-first.
 *  Per-workspace failures are logged and skipped (one unregistered/
 *  unreachable workspace must not blank the whole page); a fully-failed
 *  fan-out throws so the page shows a real error instead of a fake
 *  empty. (Desktop fetchAllFeedback semantics.) */
export async function fetchAllFeedback(
  projects: FeedbackProjectRef[]
): Promise<FeedbackListRow[]> {
  if (projects.length === 0) return [];
  let failures = 0;
  let lastError: unknown = null;
  const results = await Promise.all(
    projects.map(async (p) => {
      try {
        const res = await feedbackFetch<{ ok: boolean; items: FeedbackItem[] }>(
          "/cli/feedback/list",
          { params: { project: p.path, all: "1" } }
        );
        return (res.items ?? []).map((item) => ({
          ...item,
          assignees: item.assignees ?? [],
          projectPath: p.path,
          projectName: p.name,
        }));
      } catch (err) {
        failures++;
        lastError = err;
        console.warn("[feedback] list failed for", p.path, err);
        return [] as FeedbackListRow[];
      }
    })
  );
  if (failures === projects.length) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return sortNewestFirst(results.flat());
}

/** GET /cli/feedback/show?id=<id> — one item + its full thread. */
export function fetchFeedbackShow(id: string): Promise<FeedbackShow> {
  return feedbackFetch<FeedbackShow>("/cli/feedback/show", { params: { id } });
}

/** POST /cli/feedback/comment — it's just a comment thread. The
 *  companion posts author-less (= `owner`, a HUMAN comment): the daemon
 *  injects it into the asking session, and the FIRST human comment on a
 *  waiting question/approval doubles as the answer behind the scenes
 *  (status → answered, `ask --wait` unblocks). fyi never auto-answers.
 *  Returns the delivery receipt for the composer's status line. */
export function commentFeedback(id: string, body: string): Promise<CommentResponse> {
  return feedbackFetch<CommentResponse>("/cli/feedback/comment", {
    method: "POST",
    body: { id, body },
  });
}

/** GET /cli/users — Connect usernames for the assignee picker.
 *  Viewers may 403; caller should fall back to `["owner"]`. */
export async function fetchTicketUsers(): Promise<string[]> {
  const res = await feedbackFetch<{ users?: Array<{ username?: string }> }>(
    "/cli/users",
  );
  const names = (res.users ?? [])
    .map((u) => (u.username ?? "").trim())
    .filter(Boolean);
  return ["owner", ...names.filter((n) => n !== "owner")];
}

/** POST /cli/feedback/assign — replace the assignee set. */
export function assignFeedback(
  id: string,
  usernames: string[],
): Promise<{ assignees?: string[] }> {
  return feedbackFetch<{ assignees?: string[] }>("/cli/feedback/assign", {
    method: "POST",
    body: { id, usernames },
  });
}

/** POST /cli/feedback/resolve — `resolved`, `dismissed`, or `waiting`
 *  (reopen). `answered` is NOT manually settable — only reachable
 *  through an actual reply. */
export function resolveFeedback(
  id: string,
  status: "resolved" | "dismissed" | "waiting"
): Promise<void> {
  return feedbackFetch<{ ok: boolean }>("/cli/feedback/resolve", {
    method: "POST",
    body: { id, status },
  }).then(() => undefined);
}

// Pure types + helpers live in feedbackPure.ts (Node-testable).
export * from "./feedbackPure";
