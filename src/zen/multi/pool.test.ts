// The connection pool (multi-server S2, MS10–MS14 as amended by MA11 and
// MA22): reducer transitions, cadence 5/15/30, `instanceId` restart,
// single-flight, and the no-token-deletion rule.

import { describe, expect, it, vi } from "vitest";
import { fakeScope, type FakeScope } from "../../test/fakeScope";
import type { RawResponse } from "../../api/scopedFetch";
import {
  blankEntry,
  bootIsReady,
  classifyLoginRead,
  createPool,
  nextCheckDelayMs,
  reducePool,
  restartedBetween,
  roleAllowsRoom,
  type PoolDeps,
} from "./pool";

const READY = { version: "0.45.3", protocol: 1, phase: "ready", instanceId: "i1", features: ["daemon-activity"] };
const ok = (body: unknown): RawResponse => ({ status: 200, ok: true, text: JSON.stringify(body) });
const status = (code: number, text = ""): RawResponse => ({ status: code, ok: code < 300, text });
const WHO = { username: "me", owner: false, role: "member", mustChangePassword: false };
const SUMMARY = {
  online: true,
  workspaces: [],
  agentActivity: [{ workspaceId: "pb", status: "working", display: "working" }],
  activeProjectIds: ["pb"],
};

function harness(over: Partial<PoolDeps> = {}, scopes: Record<string, FakeScope> = {}) {
  const all: Record<string, FakeScope> = {
    b: fakeScope({ id: "b", base: "https://b.k2.dev", label: "Box B" }),
    ...scopes,
  };
  let now = 1_000;
  const boot = vi.fn<(s: unknown) => Promise<unknown | null>>(async () => READY);
  const get = vi.fn<(s: unknown, path: string) => Promise<RawResponse>>(async (_s, path) =>
    path.includes("whoami") ? ok(WHO) : ok(SUMMARY)
  );
  const noteBoot = vi.fn();
  const pool = createPool({
    scopeOf: (id) => all[id],
    bootStatus: boot,
    get,
    noteBoot,
    now: () => now,
    ...over,
  });
  return { pool, boot, get, noteBoot, scopes: all, tick: (ms: number) => (now += ms) };
}

describe("pure helpers", () => {
  it("ready means phase === 'ready' (ready:true tolerated, MA11)", () => {
    expect(bootIsReady({ phase: "ready" })).toBe(true);
    expect(bootIsReady({ ready: true })).toBe(true);
    expect(bootIsReady({ phase: "migrating" })).toBe(false);
    expect(bootIsReady({ ready: "true" })).toBe(false);
    expect(bootIsReady(null)).toBe(false);
  });

  it("cadence: 30 s while not offline; offline 5 s, 15 s, then 30 s", () => {
    expect(nextCheckDelayMs(undefined)).toBe(30_000);
    expect(nextCheckDelayMs({ reach: "live", offlineStreak: 0 })).toBe(30_000);
    expect(nextCheckDelayMs({ reach: "unknown", offlineStreak: 0 })).toBe(30_000);
    expect(nextCheckDelayMs({ reach: "offline", offlineStreak: 1 })).toBe(5_000);
    expect(nextCheckDelayMs({ reach: "offline", offlineStreak: 2 })).toBe(15_000);
    expect(nextCheckDelayMs({ reach: "offline", offlineStreak: 3 })).toBe(30_000);
    expect(nextCheckDelayMs({ reach: "offline", offlineStreak: 9 })).toBe(30_000);
  });

  it("roles: owner/admin/member and null (not read) open rooms; others do not", () => {
    for (const r of ["owner", "admin", "member", null]) expect(roleAllowsRoom(r)).toBe(true);
    for (const r of ["viewer", "", "guest"]) expect(roleAllowsRoom(r)).toBe(false);
  });

  it("classifies login reads: 401 and token-gate 403 are dead; role_required is not", () => {
    expect(classifyLoginRead(status(401)).kind).toBe("dead");
    expect(classifyLoginRead(status(403, "invalid or missing token")).kind).toBe("dead");
    expect(classifyLoginRead(status(403, '{"error":"role_required"}')).kind).toBe("failed");
    expect(classifyLoginRead(status(503, '{"state":"migrating"}')).kind).toBe("migrating");
    expect(classifyLoginRead(status(502)).kind).toBe("failed");
    expect(classifyLoginRead(status(404)).kind).toBe("failed");
    expect(classifyLoginRead(null).kind).toBe("failed");
    expect(classifyLoginRead(ok({ a: 1 }))).toEqual({ kind: "ok", body: { a: 1 } });
  });
});

describe("reducePool", () => {
  const e0 = blankEntry("b", "b.k2.dev");

  it("a new entry starts unknown and signed out (desktop)", () => {
    expect([e0.reach, e0.auth, e0.offlineStreak]).toEqual(["unknown", "signin-required", 0]);
  });

  it("boot: ready → live, not ready → starting, null → offline with a growing streak", () => {
    const live = reducePool(e0, { type: "boot", body: READY, at: 5 });
    expect([live.reach, live.boot?.version, live.boot?.instanceId, live.checkedAt]).toEqual(["live", "0.45.3", "i1", 5]);
    expect(reducePool(e0, { type: "boot", body: { phase: "migrating" }, at: 5 }).reach).toBe("starting");
    const off1 = reducePool(live, { type: "boot", body: null, at: 6 });
    const off2 = reducePool(off1, { type: "boot", body: null, at: 7 });
    expect([off1.reach, off1.offlineStreak, off2.offlineStreak]).toEqual(["offline", 1, 2]);
    // The last good boot stays known while offline.
    expect(off2.boot?.version).toBe("0.45.3");
    expect(reducePool(off2, { type: "boot", body: READY, at: 8 }).offlineStreak).toBe(0);
  });

  it("whoami: role and username; mustChangePassword → rotate-required; dead → sign in", () => {
    const live = reducePool(e0, { type: "boot", body: READY, at: 1 });
    const who = reducePool(live, { type: "whoami", read: { kind: "ok", body: WHO }, serverLabel: "Box B" });
    expect([who.role, who.username]).toEqual(["member", "me"]);
    const rot = reducePool(live, {
      type: "whoami",
      read: { kind: "ok", body: { ...WHO, mustChangePassword: true } },
      serverLabel: "Box B",
    });
    expect([rot.auth, rot.authNote]).toEqual(["rotate-required", "Box B needs a new password."]);
    expect(reducePool(live, { type: "whoami", read: { kind: "dead" }, serverLabel: "B" }).auth).toBe("signin-required");
    expect(reducePool(live, { type: "whoami", read: { kind: "migrating" }, serverLabel: "B" }).reach).toBe("starting");
    expect(reducePool(live, { type: "whoami", read: { kind: "failed" }, serverLabel: "B" })).toBe(live);
  });

  it("summary: ok → auth ok + activity; failure → Live with no dots (MA11)", () => {
    const live = reducePool(e0, { type: "boot", body: READY, at: 1 });
    const s = reducePool(live, { type: "summary", read: { kind: "ok", body: SUMMARY }, whoamiAlive: true });
    expect([s.auth, s.activity?.[0]?.workspaceId, s.activeProjectIds]).toEqual(["ok", "pb", ["pb"]]);
    const failed = reducePool(s, { type: "summary", read: { kind: "failed", status: 502 }, whoamiAlive: true });
    expect([failed.auth, failed.activity, failed.presence]).toEqual(["ok", null, null]);
    // whoami did not answer: the login is not promoted by a failed summary.
    const unk = reducePool(live, { type: "summary", read: { kind: "failed" }, whoamiAlive: false });
    expect(unk.auth).toBe("signin-required");
    expect(reducePool(s, { type: "summary", read: { kind: "dead" }, whoamiAlive: true }).auth).toBe("signin-required");
    expect(reducePool(s, { type: "summary", read: { kind: "migrating" }, whoamiAlive: true }).reach).toBe("starting");
  });

  it("kicked carries the copy; no token → sign in", () => {
    const k = reducePool(e0, { type: "kicked", serverLabel: "Box B" });
    expect([k.auth, k.authNote]).toEqual(["kicked", "Removed from Box B. Sign in again."]);
    expect(reducePool({ ...e0, auth: "ok" }, { type: "no-token" }).auth).toBe("signin-required");
  });

  it("restart = a different instanceId (never from unknown)", () => {
    const b = (id: string | null) => ({ phase: "ready", ready: true, version: null, protocol: 1, instanceId: id, features: [], at: 0 });
    expect(restartedBetween(b("i1"), b("i2"))).toBe(true);
    expect(restartedBetween(b("i1"), b("i1"))).toBe(false);
    expect(restartedBetween(null, b("i2"))).toBe(false);
    expect(restartedBetween(b(null), b("i2"))).toBe(false);
  });
});

describe("createPool", () => {
  it("MS29: an accepted login reports it; a dead one does not", async () => {
    const onAccepted = vi.fn();
    const h = harness({ onAccepted });
    await h.pool.check("b");
    expect(onAccepted).toHaveBeenCalledWith("b");
    const dead = harness({
      onAccepted,
      get: vi.fn(async () => status(401)),
    } as Partial<PoolDeps>);
    onAccepted.mockClear();
    await dead.pool.check("b");
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("socket signals: kicked and signin land on that server's entry only", async () => {
    const h = harness();
    await h.pool.check("b");
    h.pool.noteSigninRequired("b");
    expect(h.pool.entry("b")?.auth).toBe("signin-required");
    h.pool.noteKicked("b");
    expect(h.pool.entry("b")?.auth).toBe("kicked");
    h.pool.noteSigninRequired("b"); // kicked is the stronger word
    expect(h.pool.entry("b")?.auth).toBe("kicked");
    expect(h.pool.entry("a")).toBeUndefined();
  });

  it("check: boot-status → whoami → summary, with that server's scope only", async () => {
    const h = harness();
    const e = await h.pool.check("b");
    expect([e?.reach, e?.auth, e?.role, e?.hostKey]).toEqual(["live", "ok", "member", "b.k2.dev"]);
    expect(h.get.mock.calls.map((c) => c[1])).toEqual(["/cli/auth/whoami", "/cli/presence/summary"]);
    for (const c of [...h.get.mock.calls, ...h.boot.mock.calls]) expect(c[0]).toBe(h.scopes.b);
    expect(h.noteBoot).toHaveBeenCalledWith("b", READY);
  });

  it("is single-flight per server", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.pool.check("b"), h.pool.check("b")]);
    expect(a).toBe(b);
    expect(h.boot).toHaveBeenCalledTimes(1);
  });

  it("offline skips the login half; bootOnly too", async () => {
    const h = harness({ bootStatus: async () => null });
    expect((await h.pool.check("b"))?.reach).toBe("offline");
    expect(h.get).not.toHaveBeenCalled();
    const h2 = harness();
    expect((await h2.pool.check("b", { bootOnly: true }))?.reach).toBe("live");
    expect(h2.get).not.toHaveBeenCalled();
  });

  it("no token → sign in, without asking whoami", async () => {
    const h = harness({}, { b: fakeScope({ id: "b", token: "" }) });
    expect((await h.pool.check("b"))?.auth).toBe("signin-required");
    expect(h.get).not.toHaveBeenCalled();
  });

  it("a dead login never deletes the token (MA22: pool checks are read-only)", async () => {
    const h = harness({ get: async () => status(401) });
    const e = await h.pool.check("b");
    expect(e?.auth).toBe("signin-required");
    expect(h.scopes.b.token()).toBe("tok");
  });

  it("a whoami network error still reads the summary (MA11)", async () => {
    const h = harness({
      get: async (_s, path) => {
        if (path.includes("whoami")) throw new Error("timed out");
        return ok(SUMMARY);
      },
    });
    const e = await h.pool.check("b");
    expect([e?.auth, e?.activity?.length]).toEqual(["ok", 1]);
  });

  it("a changed instanceId fires onRestart for THAT server only (MS13)", async () => {
    let instance = "i1";
    const h = harness(
      { bootStatus: async () => ({ ...READY, instanceId: instance }) },
      { c: fakeScope({ id: "c", base: "https://c.k2.dev" }) }
    );
    const heard: string[] = [];
    h.pool.onRestart((id, a, b) => heard.push(`${id}:${a}>${b}`));
    await h.pool.check("b");
    await h.pool.check("c");
    expect(heard).toEqual([]);
    instance = "i2";
    await h.pool.check("b");
    expect(heard).toEqual(["b:i1>i2"]);
  });

  it("a removed server drops its entry instead of falling back", async () => {
    const h = harness();
    await h.pool.check("b");
    h.scopes.b.remove();
    expect(await h.pool.check("b")).toBeUndefined();
    expect(h.pool.entry("b")).toBeUndefined();
  });

  it("schedule records nextAt for the countdown", async () => {
    const h = harness({ bootStatus: async () => null });
    await h.pool.check("b");
    h.pool.schedule("b", 6_000);
    expect(h.pool.entry("b")?.nextAt).toBe(6_000);
  });

  it("forget during a check keeps the late answer out", async () => {
    let release!: (v: unknown) => void;
    const h = harness({ bootStatus: () => new Promise((r) => (release = r)) });
    const p = h.pool.check("b");
    h.pool.forget("b");
    release(READY);
    await p;
    expect(h.pool.entry("b")).toBeUndefined();
  });
});
