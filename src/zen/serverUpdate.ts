// Remote K2 server update: the pure part (daemon contract v0.46.0,
// `/Users/Shared/k2-companion/remote-update-contract-v0460.md`).
//
//   check  → POST /cli/daemon/update/check   {current, latest, available, installKind, …}
//   start  → POST /cli/daemon/update/start   {} → {job_id}
//   status → GET  /cli/daemon/update/status?job_id= every ~2 s
//   apply  → POST /cli/daemon/update/apply   {job_id}, standalone only, once, on `staged`
//   comeback → unauthenticated GET /boot-status every ~2.5 s (jitter)
//
// Everything here is side-effect free: the store (`serverUpdateStore.ts`)
// runs the requests and timers and feeds the results to `reduceJob`.
// Copy follows the desktop (`Settings/sections/update-host.ts`, "UH").

import type { ApiResponse } from "../api/client";

export type UpdatePhase =
  | "downloading"
  | "verifying"
  | "staged"
  | "applying"
  | "restarting"
  | "done"
  | "failed"
  | "rolled-back";

const PHASES: readonly UpdatePhase[] = [
  "downloading",
  "verifying",
  "staged",
  "applying",
  "restarting",
  "done",
  "failed",
  "rolled-back",
];

/** `standalone` | `bundled-app` | `unknown` (anything not bundled-app is
 *  driven like standalone: the client applies after `staged`). */
export type InstallKind = string;

export interface CheckResult {
  current: string;
  latest: string;
  available: boolean;
  installKind: InstallKind;
  platform: string;
  newerNoArtifact: boolean;
}

export interface StatusResult {
  jobId: string;
  phase: UpdatePhase | null;
  progress: number | null;
  error: string | null;
  /** K2 0.46.3: the version the job started from, and the one running
   *  now (null from an older daemon). */
  fromVersion?: string | null;
  runningVersion?: string | null;
}

/** What `/boot-status` said during the comeback watch; null = unreachable. */
export interface BootRead {
  phase: string | null;
  version: string | null;
  instanceId: string | null;
}

// ─── Timing ───

export const STATUS_POLL_MS = 2_000;
/** First status read right after start: a bundled-app job with no desktop
 *  app open fails at once ("K2.app isn't running…"), so show that fast. */
export const FIRST_STATUS_POLL_MS = 500;
export const COMEBACK_POLL_MS = 2_500;
/** ± this much random jitter on each comeback poll. */
export const COMEBACK_JITTER_MS = 500;
export const COMEBACK_SLOW_MS = 4 * 60_000;
export const COMEBACK_GIVE_UP_MS = 10 * 60_000;
/** Bundled-app: the desktop app reports no progress while it downloads. No
 *  phase change for this long (still downloading) = the app never picked
 *  the trigger up. */
export const BUNDLED_STALL_MS = 3 * 60_000;
/** Standalone: the daemon downloads itself; a much longer stall guard. */
export const STANDALONE_STALL_MS = 10 * 60_000;
/** Automatic checks (page open) at most this often per server. Check hits
 *  GitHub on every call. */
export const AUTO_CHECK_MIN_MS = 24 * 60 * 60_000;

// ─── Parsing ───

export function parseCheckResult(raw: unknown): CheckResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.current !== "string" || typeof o.latest !== "string") return null;
  return {
    current: o.current,
    latest: o.latest,
    available: o.available === true,
    installKind: typeof o.installKind === "string" ? o.installKind : "unknown",
    platform: typeof o.platform === "string" ? o.platform : "",
    newerNoArtifact: o.newerNoArtifact === true,
  };
}

export function parsePhase(raw: unknown): UpdatePhase | null {
  return typeof raw === "string" && (PHASES as readonly string[]).includes(raw)
    ? (raw as UpdatePhase)
    : null;
}

export function parseStatus(raw: unknown): StatusResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    jobId: typeof o.job_id === "string" ? o.job_id : "",
    phase: parsePhase(o.phase),
    progress: typeof o.progress === "number" ? o.progress : null,
    error: typeof o.error === "string" && o.error.trim() ? o.error : null,
    fromVersion: typeof o.from_version === "string" && o.from_version.trim() ? o.from_version.trim() : null,
    runningVersion:
      typeof o.running_version === "string" && o.running_version.trim() ? o.running_version.trim() : null,
  };
}

export function parseBootRead(raw: unknown): BootRead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    phase: typeof o.phase === "string" ? o.phase : null,
    version: typeof o.version === "string" && o.version ? o.version : null,
    instanceId: typeof o.instanceId === "string" && o.instanceId ? o.instanceId : null,
  };
}

/** `/boot-status` → `airgap.enabled === true`. */
export function bootAirgapOn(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const a = (raw as Record<string, unknown>).airgap;
  return !!a && typeof a === "object" && (a as Record<string, unknown>).enabled === true;
}

// ─── Errors ───

/** A request that never got an HTTP answer (network, timeout, no server). */
export function isConnectionFailure(res: Pick<ApiResponse, "ok" | "status">): boolean {
  return !res.ok && typeof res.status !== "number";
}

export function isAirgapError(res: Pick<ApiResponse, "status" | "error">): boolean {
  return res.status === 403 && /air-?gap/i.test(res.error ?? "");
}

export function isForbidden(res: Pick<ApiResponse, "status" | "error">): boolean {
  if (isAirgapError(res)) return false;
  if (res.status === 403 || res.status === 401) return true;
  return /role_required|invalid or missing token/i.test(res.error ?? "");
}

// ─── Check ───

export type CheckOutcome =
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; current: string; latest: string; installKind: InstallKind; platform: string }
  | { kind: "no-artifact"; current: string; latest: string; platform: string }
  | { kind: "forbidden" }
  | { kind: "airgap" }
  | { kind: "error"; message: string };

export function classifyCheck(res: ApiResponse<unknown>): CheckOutcome {
  if (!res.ok) {
    if (isAirgapError(res)) return { kind: "airgap" };
    if (isForbidden(res)) return { kind: "forbidden" };
    return { kind: "error", message: res.error || "Check failed" };
  }
  const c = parseCheckResult(res.data);
  if (!c) return { kind: "error", message: "The server sent an unexpected answer" };
  if (c.available) {
    return {
      kind: "available",
      current: c.current,
      latest: c.latest,
      installKind: c.installKind,
      platform: c.platform,
    };
  }
  if (c.newerNoArtifact) {
    return { kind: "no-artifact", current: c.current, latest: c.latest, platform: c.platform };
  }
  return { kind: "up-to-date", current: c.current };
}

export interface StoredCheck {
  at: number;
  result: CheckOutcome;
}

/** May the page run its automatic check now? At most one per 24 h per
 *  server, counting every stored check (tap or auto, success or not). */
export function shouldAutoCheck(stored: StoredCheck | null | undefined, now: number): boolean {
  if (!stored) return true;
  return now - stored.at >= AUTO_CHECK_MIN_MS || now < stored.at;
}

// ─── Copy (desktop UH, phone wording where the desktop says "this Mac") ───

const strip = (v: string) => v.replace(/^v/i, "");

export function releaseNotesUrl(latest: string): string {
  return `https://github.com/Alakazam-211/K2/releases/tag/v${strip(latest)}`;
}

export function upToDateCopy(current: string): string {
  return `K2 is up to date (${current})`;
}

export function availableCopy(current: string, latest: string): string {
  return `Update available: ${current} → ${latest}`;
}

/** UH:257. */
export function newerNoArtifactCopy(host: string, latest: string, platform: string): string {
  const plat = platform.trim() ? platform : "this platform";
  return `A newer version (v${strip(latest)}) exists, but there's no build for ${host}'s platform (${plat}). Nothing to install yet.`;
}

/** UH:291. */
export function forbiddenCopy(host: string): string {
  return `You don't have permission to update ${host}. Only the host owner or an admin can update it.`;
}

export const AIRGAP_NOTE = "Updates are off on this server (air-gap is on).";

export const AGENTS_WARNING =
  "Running agents on this server will be stopped and restarted. Anything they're in the middle of will be interrupted.";

/** UH:269-287. `hostname` is shown only when it differs from the label. */
export function confirmCopy(
  host: string,
  hostname: string,
  latest: string,
  installKind: InstallKind
): { title: string; message: string; confirmLabel: string } {
  const where = hostname && hostname !== host ? `${host} (${hostname})` : host;
  return {
    title: `Update ${host} to ${latest}?`,
    message:
      `This will install ${latest} on ${where} — the REMOTE machine you're ` +
      `connected to, not this phone — and restart it. Active sessions on it ` +
      `will briefly disconnect, then reconnect automatically when it's back ` +
      `on the new version. Continue?`,
    confirmLabel: installKind === "bundled-app" ? "Update Host" : "Download & install",
  };
}

/** UH:126-151 (no percentage: progress jumps 0 → 1). */
export function phaseCopy(phase: UpdatePhase, host: string, current?: string): string {
  switch (phase) {
    case "downloading":
      return `Downloading update for ${host}…`;
    case "verifying":
      return `Verifying update for ${host}…`;
    case "staged":
      return `Update staged for ${host} — ready to install & restart.`;
    case "applying":
      return `Installing update on ${host}…`;
    case "restarting":
      return `Installing & restarting ${host}… it'll reconnect automatically.`;
    case "done":
      return `${host} updated and is reconnecting.`;
    case "failed":
      return `Update failed — ${host} is still on ${current ?? "its current version"}.`;
    case "rolled-back":
      return `Update rolled back — ${host} is still on ${current ?? "its current version"}.`;
  }
}

export function slowComebackCopy(host: string): string {
  return `${host} is taking longer than expected to come back — it may still be installing. Still watching…`;
}

export function gaveUpCopy(host: string): string {
  return `${host} hasn't come back after 10 minutes. It may still be installing; check the machine, then open this page again.`;
}

export function desktopStallCopy(host: string): string {
  return `The desktop app didn't respond. Make sure K2 is open on ${host}.`;
}

export function standaloneStallCopy(host: string): string {
  return `The update on ${host} stopped making progress. Try again.`;
}

export function lostBeforeInstallCopy(host: string, message: string): string {
  return `Lost connection to ${host} before the update could install: ${message}`;
}

export function wrongVersionCopy(host: string, version: string, expected: string): string {
  return `${host} is back — but on ${version}, not ${expected}. The update may have rolled back.`;
}

// ─── Job state machine ───

export type JobStage =
  /** POST start in flight. */
  | "starting"
  /** Polling status (download / verify / staged / applying). */
  | "running"
  /** Daemon going away; polling `/boot-status`. */
  | "comeback"
  /** Back up (see `outcome`). Terminal. */
  | "done"
  /** Terminal. `error` says why; `stillOn` when the host kept its version. */
  | "failed";

export interface UpdateJob {
  serverId: string;
  /** Nickname or host label, for copy. */
  host: string;
  installKind: InstallKind;
  current: string;
  latest: string;
  stage: JobStage;
  jobId: string | null;
  phase: UpdatePhase | null;
  applySent: boolean;
  startedAt: number;
  phaseChangedAt: number;
  /** `/boot-status` instanceId when the job began (restart detection). */
  baselineInstanceId: string | null;
  comebackStartedAt: number | null;
  sawDown: boolean;
  slow: boolean;
  error: string | null;
  /** The host kept (or went back to) `current`. */
  stillOn: boolean;
  outcome: "updated" | "wrong-version" | null;
  finalVersion: string | null;
  /** K2 0.46.3 status `from_version` / `running_version`, once seen. */
  fromVersion?: string | null;
  runningVersion?: string | null;
}

export function newJob(args: {
  serverId: string;
  host: string;
  installKind: InstallKind;
  current: string;
  latest: string;
  baselineInstanceId: string | null;
  now: number;
}): UpdateJob {
  return {
    serverId: args.serverId,
    host: args.host,
    installKind: args.installKind,
    current: args.current,
    latest: args.latest,
    stage: "starting",
    jobId: null,
    phase: null,
    applySent: false,
    startedAt: args.now,
    phaseChangedAt: args.now,
    baselineInstanceId: args.baselineInstanceId,
    comebackStartedAt: null,
    sawDown: false,
    slow: false,
    error: null,
    stillOn: false,
    outcome: null,
    finalVersion: null,
  };
}

export type JobEvent =
  | { type: "started"; jobId: string; at: number }
  | { type: "start-failed"; res: ApiResponse<unknown> }
  | { type: "status"; status: StatusResult; at: number }
  | { type: "status-failed"; res: ApiResponse<unknown>; at: number }
  | { type: "apply-failed"; res: ApiResponse<unknown>; at: number }
  | { type: "boot"; boot: BootRead | null; at: number }
  | { type: "tick"; at: number };

/** Side effect the driver must run after this transition. `apply` is
 *  returned exactly once per job (standalone only). */
export type JobEffect = "apply" | "comeback-success" | null;

export function isTerminal(job: UpdateJob): boolean {
  return job.stage === "done" || job.stage === "failed";
}

export function isBundledApp(job: Pick<UpdateJob, "installKind">): boolean {
  return job.installKind === "bundled-app";
}

/** Past this point the daemon may go away at any moment, so a dropped
 *  connection (or a 404 for the job) means "restarting", not "failed". */
export function pastPointOfNoReturn(job: UpdateJob): boolean {
  return job.applySent || job.phase === "applying" || job.phase === "restarting" || job.phase === "done";
}

function fail(job: UpdateJob, error: string, stillOn: boolean): UpdateJob {
  return { ...job, stage: "failed", error, stillOn };
}

function toComeback(job: UpdateJob, at: number): UpdateJob {
  if (job.stage === "comeback") return job;
  return { ...job, stage: "comeback", comebackStartedAt: at, slow: false };
}

function requestError(job: UpdateJob, res: ApiResponse<unknown>): string {
  if (isAirgapError(res)) return AIRGAP_NOTE;
  if (isForbidden(res)) return forbiddenCopy(job.host);
  return res.error || "Request failed";
}

/** Did `/boot-status` show the restart finished? UH:218-234 plus the
 *  instanceId rule: ready AND (on `latest`, or seen down, or new process). */
export function comebackVerdict(
  job: Pick<UpdateJob, "latest" | "sawDown" | "baselineInstanceId">,
  boot: BootRead
): "keep-watching" | "success" | "wrong-version" {
  if (boot.phase !== "ready") return "keep-watching";
  const expected = strip(job.latest);
  if (boot.version && strip(boot.version) === expected) return "success";
  const restarted =
    job.sawDown ||
    (!!boot.instanceId && !!job.baselineInstanceId && boot.instanceId !== job.baselineInstanceId);
  if (!restarted) return "keep-watching";
  if (boot.version && strip(boot.version) !== expected) return "wrong-version";
  return "success";
}

function stallLimit(job: UpdateJob): number {
  return isBundledApp(job) ? BUNDLED_STALL_MS : STANDALONE_STALL_MS;
}

/** No phase change for too long while the daemon should still be talking
 *  (`applying` excluded: the host is about to go away). */
function stalled(job: UpdateJob, at: number): boolean {
  if (job.stage !== "running" || job.phase === "applying") return false;
  return at - job.phaseChangedAt >= stallLimit(job);
}

/** The whole job state machine. Terminal jobs ignore every event. */
export function reduceJob(job: UpdateJob, ev: JobEvent): [UpdateJob, JobEffect] {
  if (isTerminal(job)) return [job, null];
  switch (ev.type) {
    case "started":
      if (job.stage !== "starting") return [job, null];
      return [{ ...job, stage: "running", jobId: ev.jobId, phaseChangedAt: ev.at }, null];

    case "start-failed":
      return [fail(job, `Couldn't start the update on ${job.host}: ${requestError(job, ev.res)}`, true), null];

    case "status": {
      if (job.stage !== "running") return [job, null];
      const s = ev.status;
      const changed = s.phase !== job.phase;
      let next: UpdateJob = changed ? { ...job, phase: s.phase, phaseChangedAt: ev.at } : job;
      if ((s.fromVersion && s.fromVersion !== next.fromVersion) || (s.runningVersion && s.runningVersion !== next.runningVersion)) {
        next = {
          ...next,
          fromVersion: s.fromVersion ?? next.fromVersion ?? null,
          runningVersion: s.runningVersion ?? next.runningVersion ?? null,
        };
      }
      if (s.phase === "failed" || s.phase === "rolled-back") {
        return [fail(next, s.error ?? phaseCopy(s.phase, job.host, job.current), true), null];
      }
      if (s.phase === "restarting" || s.phase === "done") {
        return [toComeback(next, ev.at), null];
      }
      if (s.phase === "staged" && !isBundledApp(job) && !job.applySent) {
        return [{ ...next, applySent: true }, "apply"];
      }
      if (!changed && stalled(next, ev.at)) {
        next = fail(
          next,
          isBundledApp(job) ? desktopStallCopy(job.host) : standaloneStallCopy(job.host),
          true
        );
      }
      return [next, null];
    }

    case "status-failed": {
      if (job.stage !== "running") return [job, null];
      if (pastPointOfNoReturn(job)) {
        // Dropped connection, 404 (jobs live in memory), 503 migrating:
        // the daemon is restarting.
        return [toComeback(job, ev.at), null];
      }
      if (isConnectionFailure(ev.res)) {
        return [fail(job, lostBeforeInstallCopy(job.host, ev.res.error || "no answer"), true), null];
      }
      return [fail(job, `Update error on ${job.host}: ${requestError(job, ev.res)}`, true), null];
    }

    case "apply-failed": {
      if (job.stage !== "running") return [job, null];
      // Apply races the host going down: no answer = restarting.
      if (isConnectionFailure(ev.res)) return [toComeback(job, ev.at), null];
      return [
        fail(job, `Couldn't install the update on ${job.host}: ${requestError(job, ev.res)}`, true),
        null,
      ];
    }

    case "boot": {
      if (job.stage !== "comeback") return [job, null];
      const startedAt = job.comebackStartedAt ?? ev.at;
      if (!ev.boot || ev.boot.phase !== "ready") {
        const down = { ...job, sawDown: true };
        return [timeouts(down, ev.at, startedAt), null];
      }
      const verdict = comebackVerdict(job, ev.boot);
      if (verdict === "success") {
        return [
          {
            ...job,
            stage: "done",
            outcome: "updated",
            finalVersion: ev.boot.version ?? job.runningVersion ?? job.latest,
          },
          "comeback-success",
        ];
      }
      if (verdict === "wrong-version") {
        return [
          {
            ...job,
            stage: "done",
            outcome: "wrong-version",
            finalVersion: ev.boot.version,
            error: wrongVersionCopy(job.host, ev.boot.version ?? "?", job.latest),
          },
          "comeback-success",
        ];
      }
      return [timeouts(job, ev.at, startedAt), null];
    }

    case "tick": {
      if (job.stage === "comeback") {
        return [timeouts(job, ev.at, job.comebackStartedAt ?? ev.at), null];
      }
      if (stalled(job, ev.at)) {
        return [
          fail(
            job,
            isBundledApp(job) ? desktopStallCopy(job.host) : standaloneStallCopy(job.host),
            true
          ),
          null,
        ];
      }
      return [job, null];
    }
  }
}

function timeouts(job: UpdateJob, at: number, startedAt: number): UpdateJob {
  const waited = at - startedAt;
  if (waited >= COMEBACK_GIVE_UP_MS) return fail(job, gaveUpCopy(job.host), false);
  if (waited >= COMEBACK_SLOW_MS && !job.slow) return { ...job, slow: true };
  return job;
}

/** Headline for a live job. */
export function jobHeadline(job: UpdateJob): string {
  if (job.stage === "starting") return "Starting update…";
  if (job.stage === "comeback") return job.slow ? "Slow to come back…" : "Restarting…";
  if (job.phase === "applying" || job.phase === "restarting" || job.applySent) return "Restarting…";
  return "Updating…";
}

/** Detail line for a live job. */
export function jobDetail(job: UpdateJob): string {
  if (job.stage === "starting") return `Asking ${job.host} to update to ${job.latest}…`;
  if (job.stage === "comeback") {
    return job.slow ? slowComebackCopy(job.host) : `Waiting for ${job.host} to come back…`;
  }
  if (job.applySent && (job.phase === "staged" || job.phase === null)) {
    return phaseCopy("applying", job.host);
  }
  if (job.phase) return phaseCopy(job.phase, job.host, job.current);
  return isBundledApp(job)
    ? `Waiting for the K2 desktop app on ${job.host}…`
    : phaseCopy("downloading", job.host);
}

/** Next poll delay for a comeback read, 2.5 s ± 0.5 s. `rand` in [0, 1). */
export function comebackDelay(rand: number): number {
  return Math.round(COMEBACK_POLL_MS + (rand * 2 - 1) * COMEBACK_JITTER_MS);
}

/** The done line: "Updated 0.46.2 → 0.46.3" (the start version from the
 *  daemon's `from_version` when it sent one, else what the check said),
 *  or "Updated to X" when the start is unknown or the same. */
export function updatedCopy(job: Pick<UpdateJob, "current" | "latest" | "finalVersion" | "fromVersion">): string {
  const to = job.finalVersion ?? job.latest;
  const from = job.fromVersion ?? job.current;
  return from && strip(from) !== strip(to) ? `Updated ${from} → ${to}` : `Updated to ${to}`;
}
