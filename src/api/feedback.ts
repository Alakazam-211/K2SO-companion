import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { cliAuthHeaders } from "./cliAuth";
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
  type FeedbackStatus,
} from "./feedbackPure";

// Feedback C3 — companion client for the daemon's `/cli/feedback/*` routes
// (feedback_routes.rs) + the pure list/thread helpers the page renders from.
//
// Wire shapes mirror k2-core's `FeedbackItem`/`FeedbackComment` (camelCase
// serde). `fetchAllFeedback` asks `list-all?all=1` (0.43.0+, one GET, with
// unlinked rows); an older daemon gets the per-workspace `list?project=`
// fan-out, tagging each row with its host — the desktop's two paths
// (feedback-api.ts). Routes, statuses and answering rules: the K2 tickets
// reference for the phone (2026-10-11).
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
    const url = `${base}${path}${params.length ? `?${params.join("&")}` : ""}`;
    const res = await Promise.race([
      tauriFetch(url, {
        method: opts.method ?? "GET",
        headers: cliAuthHeaders(token),
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
      // 403 is a flat `{error:"…"}`; validation / not_found are nested
      // `{error:{code,hint}}` (tickets reference §1).
      const j = JSON.parse(out.text) as {
        error?: string | { code?: string; hint?: string };
      };
      if (typeof j?.error === "string" && j.error) msg = j.error;
      else if (j?.error && typeof j.error === "object") {
        msg = j.error.hint || j.error.code || msg;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return JSON.parse(out.text) as T;
}

// ─── Endpoints ───

/** Every ticket on the active server. A 0.43.0+ daemon answers in ONE
 *  GET (`list-all?all=1`), including tickets from removed workspaces
 *  (`linked:false`). An older daemon 404s there, so fall back to the
 *  per-workspace fan-out, where every row is linked. */
export async function fetchAllFeedback(
  projects: FeedbackProjectRef[]
): Promise<FeedbackListRow[]> {
  try {
    return await fetchHostFeedback();
  } catch (err) {
    console.warn("[feedback] list-all unavailable, fanning out", err);
    return fetchFeedbackFanOut(projects);
  }
}

/** `list-all` wire row: the item plus where it lives. */
interface HostFeedbackWireRow extends FeedbackItem {
  projectPath: string | null;
  projectName: string | null;
  linked: boolean;
}

async function fetchHostFeedback(): Promise<FeedbackListRow[]> {
  const res = await feedbackFetch<{ ok: boolean; items?: HostFeedbackWireRow[] }>(
    "/cli/feedback/list-all",
    { params: { all: "1" } }
  );
  if (!Array.isArray(res.items)) throw new Error("feedback/list-all: no items");
  return sortNewestFirst(
    res.items.map((item) => ({
      ...item,
      assignees: item.assignees ?? [],
      projectPath: item.linked ? (item.projectPath ?? "") : "",
      projectName: item.linked ? (item.projectName ?? "") : "",
      linked: item.linked !== false,
    }))
  );
}

/** GET /cli/feedback/list?project=<path>&all=1 for every registered
 *  workspace, tag rows with their host project, merge newest-first.
 *  Per-workspace failures are logged and skipped (one unregistered/
 *  unreachable workspace must not blank the whole page); a fully-failed
 *  fan-out throws so the page shows a real error instead of a fake
 *  empty. (Desktop fetchFeedbackFanOut semantics.) */
async function fetchFeedbackFanOut(
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

/** GET /cli/feedback/show?id=<id> — one item + its full thread. Plain
 *  `show` never carries the brief; `{brief:true}` adds `brief=1` (up to
 *  1 MiB of inline images), which callers do ONCE per ticket — the
 *  brief is immutable, so event refetches stay plain. */
export function fetchFeedbackShow(
  id: string,
  opts: { brief?: boolean } = {}
): Promise<FeedbackShow> {
  const params: Record<string, string> = { id };
  if (opts.brief) params.brief = "1";
  return feedbackFetch<FeedbackShow>("/cli/feedback/show", { params });
}

/** POST /cli/feedback/comment — a HUMAN comment (never send `author`:
 *  any author other than `owner` is stored as an agent comment that
 *  doesn't inject, wake or change status). Since 0.43.2:
 *    - an option tap sends `optionPick:true` → status `answered`, the
 *      pick becomes `answer`, and the agent hears it;
 *    - free text (no flag) → status `needs_discussion` (any kind, fyi
 *      included), and the agent hears it.
 *  Returns the delivery receipt for the composer's status line. */
export function commentFeedback(
  id: string,
  body: string,
  opts: { optionPick?: boolean } = {}
): Promise<CommentResponse> {
  const payload: { id: string; body: string; optionPick?: true } = { id, body };
  if (opts.optionPick === true) payload.optionPick = true;
  return feedbackFetch<CommentResponse>("/cli/feedback/comment", {
    method: "POST",
    body: payload,
  });
}

/** Who can be assigned. 0.45.4+ `GET /cli/tickets/settings` → `people`
 *  is Member-readable; else `GET /cli/users` (Admin floor, Members 403);
 *  else just `owner`. Always includes `owner` first. */
export async function fetchTicketUsers(): Promise<string[]> {
  const withOwner = (names: string[]) => [
    "owner",
    ...names.filter((n) => n && n !== "owner"),
  ];
  try {
    const res = await feedbackFetch<{
      people?: Array<{ value?: string; disabled?: boolean }>;
    }>("/cli/tickets/settings");
    if (Array.isArray(res.people)) {
      return withOwner(
        res.people
          .filter((p) => !p.disabled)
          .map((p) => (p.value ?? "").trim())
      );
    }
  } catch {
    /* pre-0.45.4 daemon: fall through to /cli/users */
  }
  const res = await feedbackFetch<{ users?: Array<{ username?: string }> }>(
    "/cli/users",
  );
  return withOwner((res.users ?? []).map((u) => (u.username ?? "").trim()));
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

/** POST /cli/feedback/resolve — set any status (`waiting` reopens).
 *  `answered` carries the agreed outcome as `answer`; it is recorded but
 *  NOT injected into the agent (an option pick is how to tell the agent). */
export function resolveFeedback(
  id: string,
  status: FeedbackStatus,
  answer?: string
): Promise<void> {
  const body: { id: string; status: FeedbackStatus; answer?: string } = { id, status };
  if (status === "answered" && answer !== undefined) body.answer = answer;
  return feedbackFetch<{ ok: boolean }>("/cli/feedback/resolve", {
    method: "POST",
    body,
  }).then(() => undefined);
}

// Pure types + helpers live in feedbackPure.ts (Node-testable).
export * from "./feedbackPure";
