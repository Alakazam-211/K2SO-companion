// The pool's poll loop (MS11/MS12, MA11): per-server cadence, visible-only
// checks, boot-only for the active server, Retry now.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeScope, type FakeScope } from "../../test/fakeScope";
import { createPool } from "./pool";
import { HIDDEN_RETRY_MS, startPoolLoop } from "./poolLoop";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(opts: { offline?: Set<string>; visible?: () => boolean } = {}) {
  const scopes: Record<string, FakeScope> = {
    a: fakeScope({ id: "a", base: "https://a.k2.dev" }),
    b: fakeScope({ id: "b", base: "https://b.k2.dev" }),
  };
  const offline = opts.offline ?? new Set<string>();
  const boot = vi.fn(async (scope: { id: string }) =>
    offline.has(scope.id) ? null : { phase: "ready", version: "0.45.3", instanceId: "i" }
  );
  const get = vi.fn(async (_s: unknown, path: string) => ({
    status: 200,
    ok: true,
    text: path.includes("whoami") ? '{"role":"member"}' : "{}",
  }));
  const pool = createPool({
    scopeOf: (id) => scopes[id],
    bootStatus: boot,
    get,
    noteBoot: () => {},
    now: () => Date.now(),
  });
  const checked: string[] = [];
  const loop = startPoolLoop({
    pool,
    serverIds: ["a", "b"],
    activeId: "a",
    isVisible: opts.visible ?? (() => true),
    onChecked: (id) => checked.push(id),
  });
  return { pool, boot, get, loop, checked, offline };
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("startPoolLoop", () => {
  it("checks every server at once; the active one boot-only", async () => {
    const h = setup();
    await flush();
    expect(h.checked.sort()).toEqual(["a", "b"]);
    // Only b (not active) read whoami + summary.
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.pool.entry("a")?.reach).toBe("live");
    h.loop.stop();
  });

  it("re-checks a live server every 30 s", async () => {
    const h = setup();
    await flush();
    h.boot.mockClear();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.boot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.boot).toHaveBeenCalledTimes(2);
    h.loop.stop();
  });

  it("an offline server backs off 5 s, 15 s, then 30 s, and shows when", async () => {
    const h = setup({ offline: new Set(["b"]) });
    await flush();
    const calls = () => h.boot.mock.calls.filter((c) => (c[0] as { id: string }).id === "b").length;
    expect(calls()).toBe(1);
    expect(h.pool.entry("b")?.nextAt).toBe(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls()).toBe(4);
    h.loop.stop();
  });

  it("never checks while hidden; comes back in 30 s; recheckAll on visible", async () => {
    let visible = false;
    const h = setup({ visible: () => visible });
    await flush();
    expect(h.boot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HIDDEN_RETRY_MS);
    expect(h.boot).not.toHaveBeenCalled();
    visible = true;
    h.loop.recheckAll();
    await flush();
    expect(h.boot).toHaveBeenCalledTimes(2);
    h.loop.stop();
  });

  it("Retry now checks that server immediately and restarts its timer", async () => {
    const h = setup({ offline: new Set(["b"]) });
    await flush();
    h.boot.mockClear();
    h.offline.delete("b");
    h.loop.retryNow("b");
    await flush();
    expect(h.boot).toHaveBeenCalledTimes(1);
    expect(h.pool.entry("b")?.reach).toBe("live");
    expect(h.pool.entry("b")?.nextAt).toBe(Date.now() + 30_000);
    h.loop.stop();
  });

  it("stop clears every timer", async () => {
    const h = setup();
    await flush();
    h.loop.stop();
    h.boot.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.boot).not.toHaveBeenCalled();
  });
});
