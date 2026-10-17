// Remote K2 server update: per-server state + the polling driver.
//
// The page (`ServerUpdateSection`) only reads this store and calls its
// actions, so leaving and reopening Server settings shows the same job, and
// polling keeps going while the app is in the foreground (a hidden page
// skips a beat and tries again). All polling stops on a terminal state.
// The state machine itself is pure: `serverUpdate.ts`.

import { create } from "zustand";
import {
  applyDaemonUpdate,
  checkDaemonUpdate,
  getDaemonUpdateStatus,
  startDaemonUpdate,
  type ApiResponse,
} from "../api/client";
import { holdEvents, releaseEvents } from "../api/eventsHold";
import { bootInfoFor, noteBootStatus, readBootStatus, scopeFor, type ServerScope } from "../api/scope";
import { connectServer } from "../lib/revive";
import { onServerForget } from "../stores/servers";
import { retryServerNow } from "./multi/poolLoop";
import {
  FIRST_STATUS_POLL_MS,
  STATUS_POLL_MS,
  classifyCheck,
  comebackDelay,
  isBundledApp,
  isTerminal,
  newJob,
  parseBootRead,
  parseStatus,
  reduceJob,
  shouldAutoCheck,
  type CheckOutcome,
  type JobEffect,
  type JobEvent,
  type StoredCheck,
  type UpdateJob,
} from "./serverUpdate";

export const CHECKS_STORAGE_KEY = "k2.serverUpdate.checks.v1";

function loadStored(): Record<string, StoredCheck> {
  try {
    const raw = localStorage.getItem(CHECKS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StoredCheck> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as Partial<StoredCheck> | null;
      if (c && typeof c.at === "number" && c.result && typeof c.result === "object") {
        out[id] = { at: c.at, result: c.result as CheckOutcome };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveStored(stored: Record<string, StoredCheck>): void {
  try {
    localStorage.setItem(CHECKS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* private mode / quota: the throttle is best effort */
  }
}

export interface ServerUpdateState {
  /** Last check per server (persisted): throttle + the card badge. */
  stored: Record<string, StoredCheck>;
  /** A check is in flight. */
  checking: Record<string, boolean>;
  /** This session's last check outcome (what the page shows). */
  outcome: Record<string, CheckOutcome>;
  /** The update job per server (live or finished, until dismissed). */
  jobs: Record<string, UpdateJob>;
}

export const useServerUpdateStore = create<ServerUpdateState>(() => ({
  stored: loadStored(),
  checking: {},
  outcome: {},
  jobs: {},
}));

/** Last persisted check said an update is available (card badge). */
export function useUpdateAvailable(serverId: string): boolean {
  return useServerUpdateStore((s) => s.stored[serverId]?.result.kind === "available");
}

// ─── Injectable I/O (tests) ───

export interface ServerUpdateDeps {
  check(scope: ServerScope): Promise<ApiResponse<unknown>>;
  start(scope: ServerScope): Promise<ApiResponse<{ job_id?: string }>>;
  status(scope: ServerScope, jobId: string): Promise<ApiResponse<unknown>>;
  apply(scope: ServerScope, jobId: string): Promise<ApiResponse<unknown>>;
  /** Raw `/boot-status`, never cached; null when unreachable. */
  boot(scope: ServerScope): Promise<unknown | null>;
  /** The host is back: what the app does after a reconnect. */
  afterComeback(serverId: string): void;
  random(): number;
}

const realDeps: ServerUpdateDeps = {
  check: (scope) => checkDaemonUpdate(scope),
  start: (scope) => startDaemonUpdate(scope),
  status: (scope, jobId) => getDaemonUpdateStatus(scope, jobId),
  apply: (scope, jobId) => applyDaemonUpdate(scope, jobId),
  boot: (scope) => readBootStatus(scope),
  afterComeback: (serverId) => {
    // The login survives the restart: re-probe it (marks the server
    // connected) and re-check it in the multi-server pool.
    void connectServer(serverId);
    retryServerNow(serverId);
  },
  random: () => Math.random(),
};

let deps: ServerUpdateDeps = realDeps;

/** Tests: swap some of the I/O. */
export function __setServerUpdateDepsForTests(over: Partial<ServerUpdateDeps> | null): void {
  deps = over ? { ...realDeps, ...over } : realDeps;
}

// ─── Check ───

function persist(serverId: string, result: CheckOutcome | null): void {
  const stored = { ...useServerUpdateStore.getState().stored };
  if (result) stored[serverId] = { at: Date.now(), result };
  else delete stored[serverId];
  useServerUpdateStore.setState({ stored });
  saveStored(stored);
}

/** `POST update/check` now (a tap, or the page's daily auto check). */
export async function runUpdateCheck(scope: ServerScope): Promise<CheckOutcome | null> {
  const id = scope.id;
  if (!id || useServerUpdateStore.getState().checking[id]) return null;
  useServerUpdateStore.setState((s) => ({ checking: { ...s.checking, [id]: true } }));
  let result: CheckOutcome;
  try {
    result = classifyCheck(await deps.check(scope));
  } catch (err) {
    result = { kind: "error", message: err instanceof Error ? err.message : "Check failed" };
  }
  useServerUpdateStore.setState((s) => ({
    checking: { ...s.checking, [id]: false },
    outcome: { ...s.outcome, [id]: result },
  }));
  persist(id, result);
  return result;
}

/** Page open: check unless one ran in the last 24 h (stored outcomes, error
 *  or not, count) or a job is under way. A stored non-error outcome is
 *  shown meanwhile. */
export function autoCheckIfDue(scope: ServerScope): void {
  const id = scope.id;
  if (!id) return;
  const s = useServerUpdateStore.getState();
  const job = s.jobs[id];
  if (job && !isTerminal(job)) return;
  const stored = s.stored[id];
  if (shouldAutoCheck(stored, Date.now())) {
    void runUpdateCheck(scope);
    return;
  }
  if (stored && stored.result.kind !== "error" && !s.outcome[id]) {
    useServerUpdateStore.setState((st) => ({ outcome: { ...st.outcome, [id]: stored.result } }));
  }
}

// ─── Job driver ───

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(serverId: string): void {
  const t = timers.get(serverId);
  if (t) clearTimeout(t);
  timers.delete(serverId);
}

function schedule(serverId: string, ms: number): void {
  clearTimer(serverId);
  timers.set(
    serverId,
    setTimeout(() => {
      timers.delete(serverId);
      void step(serverId);
    }, ms)
  );
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function dispatch(serverId: string, ev: JobEvent): JobEffect {
  const job = useServerUpdateStore.getState().jobs[serverId];
  if (!job) return null;
  const [next, effect] = reduceJob(job, ev);
  if (next !== job) {
    useServerUpdateStore.setState((s) => ({ jobs: { ...s.jobs, [serverId]: next } }));
    if (isTerminal(next)) onTerminal(next);
  }
  return effect;
}

function onTerminal(job: UpdateJob): void {
  clearTimer(job.serverId);
  if (isBundledApp(job)) releaseEvents(job.serverId);
  if (job.stage === "done" && job.outcome === "updated" && job.finalVersion) {
    const result: CheckOutcome = { kind: "up-to-date", current: job.finalVersion };
    useServerUpdateStore.setState((s) => ({ outcome: { ...s.outcome, [job.serverId]: result } }));
    persist(job.serverId, result);
  } else if (job.stage === "done") {
    // Back on another version: the old check is wrong either way.
    useServerUpdateStore.setState((s) => {
      const outcome = { ...s.outcome };
      delete outcome[job.serverId];
      return { outcome };
    });
    persist(job.serverId, null);
  }
}

async function step(serverId: string): Promise<void> {
  const job = useServerUpdateStore.getState().jobs[serverId];
  if (!job || isTerminal(job)) return;
  if (hidden()) {
    schedule(serverId, STATUS_POLL_MS);
    return;
  }
  const scope = scopeFor(serverId);
  const at = () => Date.now();

  if (job.stage === "running" && job.jobId) {
    const jobId = job.jobId;
    const res = await deps.status(scope, jobId);
    const status = res.ok ? parseStatus(res.data) : null;
    const effect = status
      ? dispatch(serverId, { type: "status", status, at: at() })
      : dispatch(serverId, {
          type: "status-failed",
          res: res.ok ? { ok: false, error: "unexpected status answer", status: 200 } : res,
          at: at(),
        });
    if (effect === "apply") {
      // Standalone only, exactly once (the reducer hands it out once).
      const applied = await deps.apply(scope, jobId);
      if (!applied.ok) dispatch(serverId, { type: "apply-failed", res: applied, at: at() });
    }
  } else if (job.stage === "comeback") {
    const body = await deps.boot(scope);
    const effect = dispatch(serverId, {
      type: "boot",
      boot: body === null ? null : parseBootRead(body),
      at: at(),
    });
    if (effect === "comeback-success" && body !== null) {
      noteBootStatus(serverId, body);
      deps.afterComeback(serverId);
    }
  }

  const after = useServerUpdateStore.getState().jobs[serverId];
  if (!after || isTerminal(after)) return;
  schedule(serverId, after.stage === "comeback" ? comebackDelay(deps.random()) : STATUS_POLL_MS);
}

/** Start updating `scope`'s server to `latest` (after the confirm sheet). */
export async function startServerUpdate(
  scope: ServerScope,
  args: { host: string; current: string; latest: string; installKind: string }
): Promise<void> {
  const id = scope.id;
  if (!id) return;
  const existing = useServerUpdateStore.getState().jobs[id];
  if (existing && !isTerminal(existing)) return;
  const job = newJob({
    serverId: id,
    host: args.host,
    installKind: args.installKind,
    current: args.current,
    latest: args.latest,
    baselineInstanceId: bootInfoFor(id)?.instanceId ?? null,
    now: Date.now(),
  });
  useServerUpdateStore.setState((s) => ({ jobs: { ...s.jobs, [id]: job } }));
  // Bundled-app: the daemon counts `/events` subscribers as "the desktop
  // app is open". Never be one of them while this runs.
  if (isBundledApp(job)) holdEvents(id);

  let res: ApiResponse<{ job_id?: string }>;
  try {
    res = await deps.start(scope);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : "Request failed" };
  }
  const jobId = res.ok ? res.data?.job_id : undefined;
  if (!res.ok || !jobId) {
    dispatch(id, {
      type: "start-failed",
      res: res.ok ? { ok: false, error: "no job id in the answer", status: 200 } : res,
    });
    return;
  }
  dispatch(id, { type: "started", jobId, at: Date.now() });
  schedule(id, FIRST_STATUS_POLL_MS);
}

/** Clear a finished job (the page's Done / Try again). */
export function dismissServerUpdate(serverId: string): void {
  const job = useServerUpdateStore.getState().jobs[serverId];
  if (!job || !isTerminal(job)) return;
  useServerUpdateStore.setState((s) => {
    const jobs = { ...s.jobs };
    delete jobs[serverId];
    return { jobs };
  });
}

function forget(serverId: string): void {
  clearTimer(serverId);
  releaseEvents(serverId);
  useServerUpdateStore.setState((s) => {
    const jobs = { ...s.jobs };
    const outcome = { ...s.outcome };
    const checking = { ...s.checking };
    delete jobs[serverId];
    delete outcome[serverId];
    delete checking[serverId];
    return { jobs, outcome, checking };
  });
  if (useServerUpdateStore.getState().stored[serverId]) persist(serverId, null);
}

onServerForget((id) => forget(id));

/** Tests only. */
export function __resetServerUpdateForTests(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  for (const id of Object.keys(useServerUpdateStore.getState().jobs)) releaseEvents(id);
  deps = realDeps;
  try {
    localStorage.removeItem(CHECKS_STORAGE_KEY);
  } catch {
    /* none */
  }
  useServerUpdateStore.setState({ stored: {}, checking: {}, outcome: {}, jobs: {} });
}
