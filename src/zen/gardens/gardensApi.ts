import type { ServerScope } from "../../api/scope";
import { scopedFetch } from "../../api/scopedFetch";
import { isIosWebView } from "../../lib/nativePicker";
import type { SourcesChanges } from "./sourcesFeed";

// Gardens on the phone (K2 `gardens-remote-v1`, wiki "Reference - Gardens
// Phone Contract v0.46.6"; a golden sample beats the text): the owner person
// on a paired phone reads a server's Gardens through `/cli/zen/remote/*`.

export const FEATURE_GARDENS_REMOTE = "gardens-remote-v1";

/** Gardens show on this phone for this server. Android can't host widget
 *  frames safely yet (contract §10): it needs its own frame host. */
export function gardensAvailable(scope: Pick<ServerScope, "supports">): boolean {
  return isIosWebView() && scope.supports(FEATURE_GARDENS_REMOTE);
}

/** A refusal from any remote route, or `unreachable` when none came back. */
export type GardenRefusal = {
  status: number;
  code: string;
  hint: string;
  cap?: string;
  room?: string;
  feature?: string;
};

export type GardenResult<T> = { ok: true; data: T } | { ok: false; refusal: GardenRefusal };

export type GardenRow = {
  id: string;
  name: string;
  index: number;
  template?: string;
  theme?: string | null;
  locked?: boolean;
  version: string;
};

export type GardenFeed = {
  serverId: string;
  person: string;
  setUp: boolean;
  cursor: string;
  full: boolean;
  gardens: GardenRow[];
};

export type GardenRun = "frame" | "native" | "placeholder";

/** A widget's height on a phone (contract rev 2 §A.4). */
export type PhoneHeight = "fill" | "auto" | number;

/** A Garden's mobile version (K2 0.46.8, contract rev 2 §A). Absent: its
 *  desktop layout, one column per screen. */
export type GardenPhoneLayout = {
  screens: {
    label?: string;
    canvas?: "full";
    widgets: { id: string; height?: PhoneHeight; config?: Record<string, unknown> }[];
  }[];
};

export type GardenColumn = {
  size?: number;
  "min-width"?: number;
  widget?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  label?: string;
};

export type GardenWidget = {
  id: string;
  kind: string;
  column?: number;
  slot?: string;
  props?: Record<string, unknown>;
  name?: string;
  hash?: string;
  paused?: unknown;
  [key: string]: unknown;
};

export type GardenPageBody = {
  schema: number;
  version: string;
  garden: { id: string; name: string; index: number };
  page: {
    layout: { kind?: string; canvas?: string; columns?: GardenColumn[] };
    widgets: GardenWidget[];
    phone?: GardenPhoneLayout;
  };
  theme?: { tokens?: Record<string, unknown>; [key: string]: unknown };
  motion?: { reduced?: boolean };
  errors?: unknown[];
  remote: {
    widgets: { id: string; run: GardenRun; reason?: string; frameVersion?: string }[];
    features?: string[];
  };
};

export type GardenLibFile = { name: string; sha256: string; bytes: number };

export type GardenLib = {
  slot: string;
  key: string;
  id?: string;
  version?: string;
  source: "bundled" | "download" | "cdn";
  files?: GardenLibFile[];
  url?: string;
  integrity?: string;
};

export type GardenFrameBody = {
  garden: string;
  placement: string;
  widget: string;
  hash: string;
  nonce: string;
  srcdoc: string;
  scheme?: string;
  libs: GardenLib[];
  hello: Record<string, unknown>;
};

export function isZenChanged(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "zen_changed";
}

export function isSourcesChanged(frame: unknown): boolean {
  return !!frame && typeof frame === "object" && (frame as { kind?: unknown }).kind === "sources_changed";
}

/** Refusals that end this server's Gardens on this phone (§9): wipe. */
export function refusalEndsGardens(code: string): boolean {
  return code === "device_session_ended" || code === "garden_person_only";
}

function refusalOf(status: number, text: string): GardenRefusal {
  try {
    const e = (JSON.parse(text) as { error?: Partial<GardenRefusal> | string }).error;
    if (e && typeof e === "object" && typeof e.code === "string") {
      return {
        status,
        code: e.code,
        hint: typeof e.hint === "string" ? e.hint : "",
        ...(typeof e.cap === "string" ? { cap: e.cap } : {}),
        ...(typeof e.room === "string" ? { room: e.room } : {}),
        ...(typeof e.feature === "string" ? { feature: e.feature } : {}),
      };
    }
  } catch {
    /* not K2's body */
  }
  return { status, code: "failed", hint: "" };
}

async function raw(
  scope: ServerScope,
  path: string,
  opts: { method?: string; query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
): Promise<GardenResult<string>> {
  try {
    const out = await scopedFetch(scope, path, {
      method: opts.method || "GET",
      query: opts.query,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      timeoutMs: opts.timeoutMs,
      headers: { "X-K2-Client": "phone" },
      priority: "user",
    });
    return out.ok ? { ok: true, data: out.text } : { ok: false, refusal: refusalOf(out.status, out.text) };
  } catch {
    return { ok: false, refusal: { status: 0, code: "unreachable", hint: "" } };
  }
}

async function json<T>(
  scope: ServerScope,
  path: string,
  opts: Parameters<typeof raw>[2] = {}
): Promise<GardenResult<T>> {
  const r = await raw(scope, path, opts);
  if (!r.ok) return r;
  try {
    return { ok: true, data: JSON.parse(r.data) as T };
  } catch {
    return { ok: false, refusal: { status: 200, code: "failed", hint: "" } };
  }
}

export const fetchGardenFeed = (scope: ServerScope, since?: string | null) =>
  json<GardenFeed>(scope, "/cli/zen/remote/gardens", { query: since ? { since } : undefined });

export const fetchGardenPage = (scope: ServerScope, garden: string, scheme?: string) =>
  json<GardenPageBody>(scope, "/cli/zen/remote/page", { query: { garden, ...(scheme ? { scheme } : {}) } });

export const fetchGardenFrame = (scope: ServerScope, garden: string, placement: string, scheme?: string) =>
  json<GardenFrameBody>(scope, "/cli/zen/remote/frame", {
    query: { garden, placement, ...(scheme ? { scheme } : {}) },
  });

/** One library file's text. Library files can be megabytes: no short limit
 *  on the first byte, and the body read isn't timed. */
export const fetchGardenLibFile = (scope: ServerScope, query: Record<string, string>) =>
  raw(scope, "/cli/zen/remote/lib", { query, timeoutMs: 30_000 });

export const requestGardenLib = (scope: ServerScope, body: Record<string, string>) =>
  json<unknown>(scope, "/cli/zen/remote/lib/fetch", { method: "POST", body, timeoutMs: 60_000 });

/** This placement's sources that moved since `since` (contract rev 2 §G). */
export const fetchGardenSourceChanges = (
  scope: ServerScope,
  frame: { garden: string; placement: string; hash: string },
  since: number
) =>
  json<SourcesChanges>(scope, "/cli/zen/remote/sources-changes", {
    query: { garden: frame.garden, placement: frame.placement, hash: frame.hash, since: String(since) },
  });

export type GardenCall = { garden: string; placement: string; hash: string; verb: string; args: unknown[] };

/** A data verb through the door (§4.6). */
export const callGardenVerb = (scope: ServerScope, call: GardenCall) =>
  json<{ result?: unknown }>(scope, "/cli/zen/remote/call", { method: "POST", body: call });

export type GardenReport = {
  garden: string;
  placement: string;
  hash: string;
  event: "ready" | "error" | "refusal";
  message?: string;
  stack?: string;
  verb?: string;
  code?: string;
};

/** So agents can see phone problems (`k2 zen widget errors`). Best effort. */
export function reportGardenFrame(scope: ServerScope, report: GardenReport): void {
  void json<unknown>(scope, "/cli/zen/remote/report", { method: "POST", body: report });
}
