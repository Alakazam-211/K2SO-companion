import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_BURST, createFrameHost, phoneRow, PING_MS, READY_TIMEOUT_MS, type FrameHostOptions } from "./frameHost";
import table from "./phoneVerbs.json";

function setup(over: Partial<FrameHostOptions> = {}) {
  const posted: Record<string, unknown>[] = [];
  const stops: string[] = [];
  const forward = vi.fn(async (): Promise<{ ok: true; value: unknown }> => ({ ok: true, value: "door" }));
  const hostVerb = vi.fn((): { ok: true; value: unknown } => ({ ok: true, value: "host" }));
  const host = createFrameHost({
    post: (m) => void posted.push(m as Record<string, unknown>),
    forward,
    hostVerb,
    onStop: (r) => void stops.push(r),
    ...over,
  });
  return { host, posted, stops, forward, hostVerb };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a widget frame's protocol (Gardens contract §4.4, §4.5)", () => {
  it("routes each row of the phone table", async () => {
    const { host, posted, forward, hostVerb } = setup();
    host.onMessage({ id: 1, verb: "store.get", args: ["k"] });
    host.onMessage({ id: 2, verb: "theme.get", args: [] });
    host.onMessage({ id: 3, verb: "window.startDrag", args: [] });
    await flush();
    expect(forward).toHaveBeenCalledWith("store.get", ["k"]);
    expect(hostVerb.mock.calls[0]).toEqual(["theme.get", [], false]);
    expect(posted).toContainEqual({ id: 1, ok: true, value: "door" });
    expect(posted).toContainEqual({ id: 2, ok: true, value: "host" });
    expect(posted).toContainEqual({ id: 3, ok: false, error: { message: "", code: "not_exposed" } });
  });

  it("the table is K2's catalog 50: store.changes and compute.nodes go through the door", () => {
    expect(table.catalogVersion).toBe(50);
    expect(phoneRow("store.changes")).toBe("door");
    expect(phoneRow("compute.nodes")).toBe("door");
    expect(phoneRow("boardFile.open")).toBe("host");
  });

  it("later and unknown verbs go to the daemon, so a row K2 opens works with no phone release", async () => {
    const { host, forward } = setup();
    host.onMessage({ id: 1, verb: "agents.list", args: [] });
    host.onMessage({ id: 2, verb: "made.up", args: [] });
    await flush();
    expect(forward.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["agents.list", "made.up"]);
  });

  it("refuses an oversized message, without counting transferred bytes", async () => {
    const { host, posted, forward } = setup();
    host.onMessage({ id: 1, verb: "store.put", args: ["x".repeat(70_000)] });
    host.onMessage({ id: 2, verb: "blobs.put", args: [], bytes: new ArrayBuffer(1_000_000) });
    await flush();
    expect(posted[0]).toMatchObject({ id: 1, ok: false, error: { code: "too_large" } });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("budgets calls, and ten rate_limited answers in a minute unload the frame", async () => {
    const { host, posted, stops } = setup();
    for (let i = 0; i < CALL_BURST + 12; i++) host.onMessage({ id: i, verb: "store.get", args: [] });
    await flush();
    expect(posted.filter((m) => (m.error as { code?: string })?.code === "rate_limited")).toHaveLength(10);
    expect(stops).toEqual(["rate-limited"]);
  });

  it("no ready in 10 s: didn't start", () => {
    const { stops } = setup();
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(stops).toEqual(["no-ready"]);
  });

  it("pings after ready; three missed pongs: stopped responding; a pong resets it", () => {
    const { host, posted, stops } = setup();
    host.onMessage({ ready: true });
    vi.advanceTimersByTime(PING_MS * 2);
    expect(posted.filter((m) => "ping" in m)).toHaveLength(2);
    host.onMessage({ pong: 2 });
    vi.advanceTimersByTime(PING_MS * 3);
    expect(stops).toEqual([]);
    vi.advanceTimersByTime(PING_MS);
    expect(stops).toEqual(["not-responding"]);
  });

  it("twenty uncaught errors in a minute: keeps failing", () => {
    const onError = vi.fn();
    const { host, stops } = setup({ onError });
    for (let i = 0; i < 20; i++) host.onMessage({ error: { message: "boom" } });
    expect(onError).toHaveBeenCalledTimes(20);
    expect(stops).toEqual(["keeps-failing"]);
  });

  it("a press opens the 5 s window for host verbs", async () => {
    const { host, hostVerb } = setup();
    host.onMessage({ pointer: "down" });
    host.onMessage({ id: 1, verb: "layout.toggle", args: [] });
    vi.advanceTimersByTime(5_000);
    host.onMessage({ id: 2, verb: "layout.toggle", args: [] });
    await flush();
    expect((hostVerb.mock.calls as unknown[][]).map((c) => c[2])).toEqual([true, false]);
  });

  it("subscriptions: 16 at most, ended by unsub and by stop; unsupported ones are refused", () => {
    const end = vi.fn();
    let push: (v: unknown) => void = () => {};
    const { host, posted } = setup({
      subscribe: (verb, _a, p) => {
        if (verb === "nope") return { code: "verb_unavailable" };
        push = p;
        return end;
      },
    });
    host.onMessage({ sub: 1, verb: "theme.changed", args: [] });
    push("v");
    expect(posted).toContainEqual({ sub: 1, value: "v" });
    host.onMessage({ unsub: 1 });
    expect(end).toHaveBeenCalledTimes(1);
    host.onMessage({ sub: 2, verb: "nope", args: [] });
    expect(posted).toContainEqual({ sub: 2, error: { message: "", code: "verb_unavailable" } });
    for (let i = 10; i < 27; i++) host.onMessage({ sub: i, verb: "theme.changed", args: [] });
    expect(posted[posted.length - 1]).toMatchObject({ sub: 26, error: { code: "rate_limited" } });
    host.stop();
    expect(end).toHaveBeenCalledTimes(17);
  });

  it("sends a ready frame the new viewport", () => {
    const { host, posted } = setup();
    host.setViewport({ width: 1, height: 1 });
    expect(posted).toEqual([]);
    host.onMessage({ ready: true });
    host.setViewport({ width: 390, height: 720 });
    expect(posted).toEqual([{ viewport: { width: 390, height: 720 } }]);
  });

  it("reports size, and tells a ready frame when it's visible", () => {
    const onSize = vi.fn();
    const { host, posted } = setup({ onSize });
    host.setVisible(false);
    expect(posted).toEqual([]);
    host.onMessage({ ready: true });
    expect(posted).toEqual([{ visible: false }]);
    host.setVisible(true);
    expect(posted).toEqual([{ visible: false }, { visible: true }]);
    host.onMessage({ size: { height: 320 } });
    expect(onSize).toHaveBeenCalledWith(320);
  });

  it("delivers a push made while subscribing, and a later refusal ends the subscription", async () => {
    let refuse: (e: { code: string }) => void = () => {};
    const off = vi.fn();
    const { host, posted } = setup({
      subscribe: (_verb, _args, push, fail) => {
        push("first");
        refuse = fail;
        return off;
      },
    });
    host.onMessage({ sub: 1, verb: "sources.subscribe", args: ["fleet"] });
    await flush();
    expect(posted).toContainEqual({ sub: 1, value: "first" });
    refuse({ code: "not_bound" });
    expect(posted).toContainEqual({ sub: 1, error: { message: "", code: "not_bound" } });
    host.onMessage({ unsub: 1 });
    expect(off).not.toHaveBeenCalled();
  });
});
