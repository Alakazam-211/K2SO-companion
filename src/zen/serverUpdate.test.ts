import { describe, expect, it } from "vitest";
import {
  AUTO_CHECK_MIN_MS,
  BUNDLED_STALL_MS,
  COMEBACK_GIVE_UP_MS,
  COMEBACK_SLOW_MS,
  STANDALONE_STALL_MS,
  classifyCheck,
  comebackDelay,
  comebackVerdict,
  confirmCopy,
  desktopStallCopy,
  gaveUpCopy,
  jobHeadline,
  newJob,
  reduceJob,
  releaseNotesUrl,
  shouldAutoCheck,
  type JobEvent,
  type StatusResult,
  type UpdateJob,
  type UpdatePhase,
} from "./serverUpdate";

const T0 = 1_000_000;

function job(installKind: string, over: Partial<UpdateJob> = {}): UpdateJob {
  return {
    ...newJob({
      serverId: "s1",
      host: "Home",
      installKind,
      current: "0.46.0",
      latest: "0.46.1",
      baselineInstanceId: "aaaa",
      now: T0,
    }),
    ...over,
  };
}

function st(phase: UpdatePhase | null, error: string | null = null): StatusResult {
  return { jobId: "j1", phase, progress: null, error };
}

/** Feed events in order; collect every effect. */
function run(j: UpdateJob, events: JobEvent[]): { job: UpdateJob; effects: string[] } {
  const effects: string[] = [];
  let cur = j;
  for (const ev of events) {
    const [next, eff] = reduceJob(cur, ev);
    if (eff) effects.push(eff);
    cur = next;
  }
  return { job: cur, effects };
}

const net = { ok: false, error: "Could not reach server: offline" };

describe("standalone path", () => {
  it("start → staged → apply once → restarting → comeback success", () => {
    const { job: j, effects } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 + 100 },
      { type: "status", status: st("downloading"), at: T0 + 2000 },
      { type: "status", status: st("verifying"), at: T0 + 4000 },
      { type: "status", status: st("staged"), at: T0 + 6000 },
      // Still staged on the next poll: apply must not be sent again.
      { type: "status", status: st("staged"), at: T0 + 8000 },
      { type: "status", status: st("applying"), at: T0 + 10000 },
      { type: "status", status: st("restarting"), at: T0 + 12000 },
      { type: "boot", boot: null, at: T0 + 14500 },
      { type: "boot", boot: { phase: "ready", version: "0.46.1", instanceId: "bbbb" }, at: T0 + 17000 },
    ]);
    expect(effects).toEqual(["apply", "comeback-success"]);
    expect(j.stage).toBe("done");
    expect(j.outcome).toBe("updated");
    expect(j.finalVersion).toBe("0.46.1");
    expect(j.sawDown).toBe(true);
  });

  it("drop before apply = failure, host named, still on current", () => {
    const { job: j } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("downloading"), at: T0 + 2000 },
      { type: "status-failed", res: net, at: T0 + 4000 },
    ]);
    expect(j.stage).toBe("failed");
    expect(j.stillOn).toBe(true);
    expect(j.error).toMatch(/^Lost connection to Home before the update could install/);
  });

  it("drop after apply = comeback", () => {
    const { job: j } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("staged"), at: T0 + 2000 },
      { type: "status-failed", res: net, at: T0 + 4000 },
    ]);
    expect(j.stage).toBe("comeback");
    expect(j.comebackStartedAt).toBe(T0 + 4000);
  });

  it("404 for the job after apply = comeback (jobs live in memory)", () => {
    const { job: j } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("staged"), at: T0 + 2000 },
      { type: "status-failed", res: { ok: false, error: "route not found", status: 404 }, at: T0 + 4000 },
    ]);
    expect(j.stage).toBe("comeback");
  });

  it("404 before apply = failure", () => {
    const { job: j } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status-failed", res: { ok: false, error: "route not found", status: 404 }, at: T0 + 2000 },
    ]);
    expect(j.stage).toBe("failed");
  });

  it("apply that never answers = comeback; apply refused = failure", () => {
    const base = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("staged"), at: T0 + 2000 },
    ]).job;
    expect(reduceJob(base, { type: "apply-failed", res: net, at: T0 + 2100 })[0].stage).toBe("comeback");
    const refused = reduceJob(base, {
      type: "apply-failed",
      res: { ok: false, error: "swap binary: Permission denied", status: 500 },
      at: T0 + 2100,
    })[0];
    expect(refused.stage).toBe("failed");
    expect(refused.error).toBe("Couldn't install the update on Home: swap binary: Permission denied");
  });

  it("stalls only after 10 min without a phase change", () => {
    const started = reduceJob(job("standalone"), { type: "started", jobId: "j1", at: T0 })[0];
    const down = reduceJob(started, { type: "status", status: st("downloading"), at: T0 + 1000 })[0];
    expect(reduceJob(down, { type: "tick", at: T0 + 1000 + STANDALONE_STALL_MS - 1 })[0].stage).toBe("running");
    expect(reduceJob(down, { type: "tick", at: T0 + 1000 + STANDALONE_STALL_MS })[0].stage).toBe("failed");
  });
});

describe("bundled-app path", () => {
  it("never applies, even if staged shows up", () => {
    const { job: j, effects } = run(job("bundled-app"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("downloading"), at: T0 + 2000 },
      { type: "status", status: st("staged"), at: T0 + 4000 },
      { type: "status", status: st("applying"), at: T0 + 6000 },
      { type: "status-failed", res: net, at: T0 + 8000 },
      { type: "boot", boot: { phase: "ready", version: "0.46.0", instanceId: "aaaa" }, at: T0 + 10000 },
      { type: "boot", boot: { phase: "ready", version: "0.46.1", instanceId: "cccc" }, at: T0 + 12500 },
    ]);
    expect(effects).not.toContain("apply");
    expect(effects).toEqual(["comeback-success"]);
    expect(j.applySent).toBe(false);
    expect(j.stage).toBe("done");
  });

  it("drop while downloading (before applying) = failure", () => {
    const { job: j } = run(job("bundled-app"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("downloading"), at: T0 + 2000 },
      { type: "status-failed", res: net, at: T0 + 4000 },
    ]);
    expect(j.stage).toBe("failed");
  });

  it("app not running: the daemon's message, still on current", () => {
    const msg = "K2.app isn't running on mac-mini — open it there, or update on the machine.";
    const { job: j } = run(job("bundled-app"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("failed", msg), at: T0 + 500 },
    ]);
    expect(j.stage).toBe("failed");
    expect(j.error).toBe(msg);
    expect(j.stillOn).toBe(true);
  });

  it("times out after 3 min stuck in downloading", () => {
    const { job: j } = run(job("bundled-app"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("downloading"), at: T0 + 500 },
      { type: "status", status: st("downloading"), at: T0 + 500 + BUNDLED_STALL_MS - 1 },
    ]);
    expect(j.stage).toBe("running");
    const [timedOut] = reduceJob(j, {
      type: "status",
      status: st("downloading"),
      at: T0 + 500 + BUNDLED_STALL_MS,
    });
    expect(timedOut.stage).toBe("failed");
    expect(timedOut.error).toBe(desktopStallCopy("Home"));
  });
});

describe("terminal phases", () => {
  it.each(["failed", "rolled-back"] as const)("%s → failed with error and still-on", (phase) => {
    const { job: j } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st(phase), at: T0 + 2000 },
    ]);
    expect(j.stage).toBe("failed");
    expect(j.stillOn).toBe(true);
    expect(j.error).toContain("Home is still on 0.46.0");
  });

  it("uses the daemon's error text when present", () => {
    const { job: j } = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("rolled-back", "boot check failed 3 times"), at: T0 + 2000 },
    ]);
    expect(j.error).toBe("boot check failed 3 times");
  });

  it("terminal jobs ignore later events", () => {
    const failed = run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("failed"), at: T0 + 2000 },
    ]).job;
    const [same, eff] = reduceJob(failed, { type: "status", status: st("staged"), at: T0 + 4000 });
    expect(same).toBe(failed);
    expect(eff).toBeNull();
  });

  it("start refused (403 role_required) = forbidden copy", () => {
    const [j] = reduceJob(job("standalone"), {
      type: "start-failed",
      res: { ok: false, error: "role_required", status: 403 },
    });
    expect(j.stage).toBe("failed");
    expect(j.error).toContain("You don't have permission to update Home");
  });
});

describe("comeback rules", () => {
  const comeback = () =>
    run(job("standalone"), [
      { type: "started", jobId: "j1", at: T0 },
      { type: "status", status: st("restarting"), at: T0 },
    ]).job;

  it("old daemon still ready on the old version, same instance: keep watching", () => {
    const [j] = reduceJob(comeback(), {
      type: "boot",
      boot: { phase: "ready", version: "0.46.0", instanceId: "aaaa" },
      at: T0 + 2500,
    });
    expect(j.stage).toBe("comeback");
  });

  it("version match = success, even without seeing it down", () => {
    const [j, eff] = reduceJob(comeback(), {
      type: "boot",
      boot: { phase: "ready", version: "0.46.1", instanceId: "aaaa" },
      at: T0 + 2500,
    });
    expect(j.stage).toBe("done");
    expect(eff).toBe("comeback-success");
  });

  it("saw it down, back without a version = success", () => {
    const { job: j } = run(comeback(), [
      { type: "boot", boot: { phase: "starting", version: "0.46.1", instanceId: "bbbb" }, at: T0 + 2500 },
      { type: "boot", boot: { phase: "ready", version: null, instanceId: "bbbb" }, at: T0 + 5000 },
    ]);
    expect(j.stage).toBe("done");
    expect(j.outcome).toBe("updated");
    expect(j.finalVersion).toBe("0.46.1");
  });

  it("instanceId changed = restarted (never saw it down)", () => {
    expect(
      comebackVerdict(
        { latest: "0.46.1", sawDown: false, baselineInstanceId: "aaaa" },
        { phase: "ready", version: null, instanceId: "bbbb" }
      )
    ).toBe("success");
  });

  it("restarted on the old version = wrong-version, not a success claim", () => {
    const { job: j } = run(comeback(), [
      { type: "boot", boot: null, at: T0 + 2500 },
      { type: "boot", boot: { phase: "ready", version: "0.46.0", instanceId: "bbbb" }, at: T0 + 5000 },
    ]);
    expect(j.stage).toBe("done");
    expect(j.outcome).toBe("wrong-version");
    expect(j.error).toContain("not 0.46.1");
  });

  it("slow at 4 min, gives up at 10 min", () => {
    const c = comeback();
    const [notYet] = reduceJob(c, { type: "boot", boot: null, at: T0 + COMEBACK_SLOW_MS - 1 });
    expect(notYet.slow).toBe(false);
    const [slow] = reduceJob(c, { type: "boot", boot: null, at: T0 + COMEBACK_SLOW_MS });
    expect(slow.slow).toBe(true);
    expect(slow.stage).toBe("comeback");
    expect(jobHeadline(slow)).toBe("Slow to come back…");
    const [gone] = reduceJob(slow, { type: "tick", at: T0 + COMEBACK_GIVE_UP_MS });
    expect(gone.stage).toBe("failed");
    expect(gone.error).toBe(gaveUpCopy("Home"));
    expect(gone.stillOn).toBe(false);
  });

  it("restarting shows Restarting…", () => {
    expect(jobHeadline(comeback())).toBe("Restarting…");
  });

  it("jitters around 2.5 s", () => {
    expect(comebackDelay(0)).toBe(2000);
    expect(comebackDelay(0.5)).toBe(2500);
    expect(comebackDelay(0.999)).toBeLessThanOrEqual(3000);
  });
});

describe("check", () => {
  it("classifies results and errors", () => {
    const body = (o: object) => ({
      ok: true,
      data: { current: "0.46.0", latest: "0.46.1", installKind: "standalone", platform: "linux-x86_64", ...o },
    });
    expect(classifyCheck(body({ available: true })).kind).toBe("available");
    expect(classifyCheck(body({ available: false, latest: "0.46.0" }))).toEqual({
      kind: "up-to-date",
      current: "0.46.0",
    });
    expect(classifyCheck(body({ available: false, newerNoArtifact: true })).kind).toBe("no-artifact");
    expect(
      classifyCheck({ ok: false, status: 403, error: "role_required" }).kind
    ).toBe("forbidden");
    expect(
      classifyCheck({
        ok: false,
        status: 403,
        error: "Air-gap is on (K2_AIRGAP=1). This daemon will not start a tunnel…",
      }).kind
    ).toBe("airgap");
    expect(classifyCheck({ ok: false, status: 400, error: "fetch manifest: timeout" })).toEqual({
      kind: "error",
      message: "fetch manifest: timeout",
    });
    expect(classifyCheck({ ok: false, error: "Could not reach server: offline" }).kind).toBe("error");
  });

  it("auto check at most once per 24 h", () => {
    const now = 50 * AUTO_CHECK_MIN_MS;
    expect(shouldAutoCheck(null, now)).toBe(true);
    const stored = { at: now - AUTO_CHECK_MIN_MS + 1, result: { kind: "up-to-date" as const, current: "1" } };
    expect(shouldAutoCheck(stored, now)).toBe(false);
    expect(shouldAutoCheck({ ...stored, at: now - AUTO_CHECK_MIN_MS }, now)).toBe(true);
    // Errors count too.
    expect(shouldAutoCheck({ at: now - 1000, result: { kind: "error", message: "x" } }, now)).toBe(false);
  });

  it("release notes link and confirm labels", () => {
    expect(releaseNotesUrl("0.46.1")).toBe("https://github.com/Alakazam-211/K2/releases/tag/v0.46.1");
    expect(releaseNotesUrl("v0.46.1")).toBe("https://github.com/Alakazam-211/K2/releases/tag/v0.46.1");
    expect(confirmCopy("Home", "home.k2.dev", "0.46.1", "bundled-app").confirmLabel).toBe("Update Host");
    expect(confirmCopy("Home", "home.k2.dev", "0.46.1", "standalone").confirmLabel).toBe("Download & install");
    const c = confirmCopy("Home", "home.k2.dev", "0.46.1", "standalone");
    expect(c.title).toBe("Update Home to 0.46.1?");
    expect(c.message).toContain("on Home (home.k2.dev) — the REMOTE machine");
  });
});
