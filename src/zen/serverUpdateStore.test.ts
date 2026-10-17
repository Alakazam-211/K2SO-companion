// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn(async () => { throw new Error("offline"); }) }));

import { __resetScopesForTests, bootInfoFor, noteBootStatus, scopeFor } from "../api/scope";
import { eventsHeld, __resetEventsHoldForTests } from "../api/eventsHold";
import { useServersStore } from "../stores/servers";
import {
  CHECKS_STORAGE_KEY,
  __resetServerUpdateForTests,
  __setServerUpdateDepsForTests,
  autoCheckIfDue,
  runUpdateCheck,
  startServerUpdate,
  useServerUpdateStore,
  type ServerUpdateDeps,
} from "./serverUpdateStore";
import { AUTO_CHECK_MIN_MS, BUNDLED_STALL_MS, COMEBACK_GIVE_UP_MS, COMEBACK_SLOW_MS } from "./serverUpdate";

type Phase = string | null;

function makeDeps(script: {
  phases: Array<Phase | "drop">;
  boots?: Array<unknown | null>;
  statusError?: string;
}) {
  let i = 0;
  let b = 0;
  const deps = {
    check: vi.fn<ServerUpdateDeps["check"]>(async () => ({
      ok: true,
      data: { current: "0.46.0", latest: "0.46.1", available: true, installKind: "standalone", platform: "linux-x86_64" },
    })),
    start: vi.fn<ServerUpdateDeps["start"]>(async () => ({ ok: true, data: { job_id: "j1" } })),
    status: vi.fn<ServerUpdateDeps["status"]>(async () => {
      const p = script.phases[Math.min(i, script.phases.length - 1)];
      i += 1;
      if (p === "drop") return { ok: false, error: "Could not reach server: offline" };
      return { ok: true, data: { job_id: "j1", phase: p, progress: 0, bytes: null, error: script.statusError ?? null } };
    }),
    apply: vi.fn<ServerUpdateDeps["apply"]>(async () => ({ ok: true, data: { ok: true, applying: true } })),
    boot: vi.fn<ServerUpdateDeps["boot"]>(async () => {
      const boots = script.boots ?? [];
      const v = boots[Math.min(b, boots.length - 1)] ?? null;
      b += 1;
      return v;
    }),
    afterComeback: vi.fn(),
    random: () => 0.5,
  };
  __setServerUpdateDepsForTests(deps);
  return deps;
}

const scope = () => scopeFor("s1");
const job = () => useServerUpdateStore.getState().jobs.s1;

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetScopesForTests();
  __resetEventsHoldForTests();
  __resetServerUpdateForTests();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "baden", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t1" },
    recovery: { s1: "connected" },
  });
  noteBootStatus("s1", { version: "0.46.0", instanceId: "aaaa", phase: "ready" });
});

afterEach(() => {
  __resetServerUpdateForTests();
  vi.useRealTimers();
});

describe("serverUpdateStore driver", () => {
  it("standalone: apply exactly once at staged, then comeback success", async () => {
    const deps = makeDeps({
      phases: ["downloading", "staged", "staged", "restarting"],
      boots: [null, { phase: "ready", version: "0.46.1", instanceId: "bbbb", features: ["zen-v1"] }],
    });
    await startServerUpdate(scope(), { host: "Home", current: "0.46.0", latest: "0.46.1", installKind: "standalone" });
    expect(job().stage).toBe("running");
    expect(eventsHeld("s1")).toBe(false);
    await advance(500); // downloading
    await advance(2000); // staged → apply
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.apply).toHaveBeenCalledWith(scope(), "j1");
    await advance(2000); // staged again: no second apply
    expect(deps.apply).toHaveBeenCalledTimes(1);
    await advance(2000); // restarting → comeback
    expect(job().stage).toBe("comeback");
    await advance(2500); // down
    await advance(2500); // ready on 0.46.1
    expect(job().stage).toBe("done");
    expect(job().finalVersion).toBe("0.46.1");
    expect(deps.afterComeback).toHaveBeenCalledWith("s1");
    expect(bootInfoFor("s1")?.version).toBe("0.46.1");
    expect(bootInfoFor("s1")?.features?.has("zen-v1")).toBe(true);
    // The stored check now says up to date (no card badge).
    expect(useServerUpdateStore.getState().stored.s1.result).toEqual({ kind: "up-to-date", current: "0.46.1" });
    // Polling stopped.
    const calls = deps.boot.mock.calls.length;
    await advance(60_000);
    expect(deps.boot.mock.calls.length).toBe(calls);
  });

  it("bundled-app: never applies, holds /events while running, releases on the end", async () => {
    const deps = makeDeps({
      phases: ["downloading", "applying", "drop"],
      boots: [{ phase: "ready", version: "0.46.1", instanceId: "cccc" }],
    });
    await startServerUpdate(scope(), { host: "Home", current: "0.46.0", latest: "0.46.1", installKind: "bundled-app" });
    expect(eventsHeld("s1")).toBe(true);
    await advance(500);
    await advance(2000);
    await advance(2000); // drop after applying → comeback
    expect(job().stage).toBe("comeback");
    await advance(2500);
    expect(job().stage).toBe("done");
    expect(deps.apply).not.toHaveBeenCalled();
    expect(eventsHeld("s1")).toBe(false);
  });

  it("bundled-app: app not running shows the daemon's message after one quick poll", async () => {
    const msg = "K2.app isn't running on mac-mini — open it there, or update on the machine.";
    const deps = makeDeps({ phases: ["failed"], statusError: msg });
    await startServerUpdate(scope(), { host: "Home", current: "0.46.0", latest: "0.46.1", installKind: "bundled-app" });
    await advance(500);
    expect(deps.status).toHaveBeenCalledTimes(1);
    expect(job().stage).toBe("failed");
    expect(job().error).toBe(msg);
    expect(eventsHeld("s1")).toBe(false);
    await advance(10_000);
    expect(deps.status).toHaveBeenCalledTimes(1);
  });

  it("bundled-app: desktop app never answers → timeout", async () => {
    makeDeps({ phases: ["downloading"] });
    await startServerUpdate(scope(), { host: "Home", current: "0.46.0", latest: "0.46.1", installKind: "bundled-app" });
    await advance(BUNDLED_STALL_MS + 3000);
    expect(job().stage).toBe("failed");
    expect(job().error).toBe("The desktop app didn't respond. Make sure K2 is open on Home.");
  });

  it("comeback: slow at 4 min, gives up at 10 min", async () => {
    makeDeps({ phases: ["restarting"], boots: [null] });
    await startServerUpdate(scope(), { host: "Home", current: "0.46.0", latest: "0.46.1", installKind: "standalone" });
    await advance(500);
    expect(job().stage).toBe("comeback");
    await advance(COMEBACK_SLOW_MS + 3000);
    expect(job().slow).toBe(true);
    expect(job().stage).toBe("comeback");
    await advance(COMEBACK_GIVE_UP_MS - COMEBACK_SLOW_MS);
    expect(job().stage).toBe("failed");
  });

  it("start failure fails the job and releases the hold", async () => {
    const deps = makeDeps({ phases: [] });
    deps.start.mockResolvedValueOnce({ ok: false, status: 403, error: "role_required" });
    await startServerUpdate(scope(), { host: "Home", current: "0.46.0", latest: "0.46.1", installKind: "bundled-app" });
    expect(job().stage).toBe("failed");
    expect(eventsHeld("s1")).toBe(false);
  });
});

describe("check throttling", () => {
  it("auto check runs once per 24 h; taps always check; result persisted", async () => {
    const deps = makeDeps({ phases: [] });
    autoCheckIfDue(scope());
    await advance(0);
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(useServerUpdateStore.getState().outcome.s1?.kind).toBe("available");
    const raw = JSON.parse(localStorage.getItem(CHECKS_STORAGE_KEY) ?? "{}");
    expect(raw.s1.result.kind).toBe("available");

    autoCheckIfDue(scope());
    await advance(0);
    expect(deps.check).toHaveBeenCalledTimes(1);

    await runUpdateCheck(scope());
    expect(deps.check).toHaveBeenCalledTimes(2);

    await advance(AUTO_CHECK_MIN_MS);
    autoCheckIfDue(scope());
    await advance(0);
    expect(deps.check).toHaveBeenCalledTimes(3);
  });

  it("a stored result is shown without a request", async () => {
    const deps = makeDeps({ phases: [] });
    useServerUpdateStore.setState({
      stored: { s1: { at: Date.now() - 1000, result: { kind: "up-to-date", current: "0.46.0" } } },
    });
    autoCheckIfDue(scope());
    await advance(0);
    expect(deps.check).not.toHaveBeenCalled();
    expect(useServerUpdateStore.getState().outcome.s1).toEqual({ kind: "up-to-date", current: "0.46.0" });
  });
});
