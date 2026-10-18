import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no tauri in tests");
  }),
  addPluginListener: vi.fn(async () => {
    throw new Error("no tauri in tests");
  }),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("../stores/servers", () => ({
  useServersStore: { getState: () => ({ servers: [], tokens: {}, activeServerId: null }) },
  onServerForget: vi.fn(() => () => {}),
  onServerLeave: vi.fn(() => () => {}),
}));

import {
  __pendingBadgeTotalsForTests,
  __setBadgeTotalsDepsForTests,
  badgeTotalsSupported,
  clearServerTotals,
  flushBadgeTotals,
  getBadgeDiagnostics,
  getBadgeTotals,
  installBadgeServerHooks,
  localDayKey,
  badgeStoreKey,
  onBadgeTotals,
  serverForBadgeEvent,
  setServerTotals,
  summarizeBadgeDiagnostics,
  type BadgeDayCount,
  type BadgeTotalsEvent,
} from "./badgeTotals";

type Call = { cmd: string; args?: Record<string, unknown> };

let servers: { id: string; url: string }[];
let calls: Call[];
let avail: { available: boolean; platform: string };
let native: Record<string, (args?: Record<string, unknown>) => unknown>;
let listeners: Map<string, (p: unknown) => void>;
let unregistered: string[];
let forgetFns: ((id: string) => void)[];
let leaveFns: ((s: { id: string; url: string }) => void)[];
let keys: Record<string, string>;
let keyFns: ((id: string, next: string | null, prev: string | null) => void)[];

/** What `badgeKeys.learnBadgeKey` / `forgetBadgeKey` do, on the fake map. */
function setKey(id: string, next: string | null) {
  const prev = keys[id] ?? null;
  if (next) keys[id] = next;
  else delete keys[id];
  keyFns.forEach((fn) => fn(id, next, prev));
}

function install(over: Record<string, unknown> = {}) {
  __setBadgeTotalsDepsForTests({
    enabled: () => true,
    availability: async () => avail,
    call: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const fn = native[cmd];
      if (!fn) throw new Error(`no ${cmd}`);
      return fn(args);
    }) as never,
    listen: async (event, cb) => {
      listeners.set(event, cb);
      return { unregister: () => void unregistered.push(event) };
    },
    servers: () => servers,
    badgeKeyOf: (id) => keys[id] ?? null,
    onBadgeKeyChange: (fn) => {
      keyFns.push(fn);
      return () => {
        keyFns = keyFns.filter((f) => f !== fn);
      };
    },
    onForget: (fn) => {
      forgetFns.push(fn);
      return () => {
        forgetFns = forgetFns.filter((f) => f !== fn);
      };
    },
    onLeave: (fn) => {
      leaveFns.push(fn);
      return () => {
        leaveFns = leaveFns.filter((f) => f !== fn);
      };
    },
    flushMs: 10,
    ...over,
  });
}

beforeEach(() => {
  servers = [
    { id: "s1", url: "https://Rosson.k2.dev" },
    { id: "s2", url: "https://baden.k2.dev:443/" },
    { id: "lan", url: "http://192.168.1.50:60710" },
    { id: "connect", url: "https://rosson.app.k2.dev" },
  ];
  calls = [];
  avail = { available: true, platform: "ios" };
  listeners = new Map();
  unregistered = [];
  forgetFns = [];
  leaveFns = [];
  keys = {};
  keyFns = [];
  native = {
    set_server_totals: () => ({ available: true, sum: 3 }),
    clear_server_totals: () => ({ available: true, sum: 0 }),
    get_badge_totals: () => ({
      available: true,
      sum: 5,
      version: 1,
      servers: {
        rosson: { unread: 2, waiting: 1, at: 1 },
        old: { unread: 3, waiting: 0, at: 1 },
      },
    }),
    get_badge_diagnostics: () => ({
      available: true,
      version: 1,
      days: { "2026-10-17": { rosson: { silent: 2, alert: 1, lastAt: 5 } } },
    }),
  };
  install();
});

afterEach(() => {
  __setBadgeTotalsDepsForTests(null);
  vi.useRealTimers();
});

describe("availability gate", () => {
  it("is a no-op outside Tauri", async () => {
    install({ enabled: () => false });
    setServerTotals("s1", { unread: 2 });
    clearServerTotals("s1");
    expect(__pendingBadgeTotalsForTests()).toEqual({});
    expect(await badgeTotalsSupported()).toBe(false);
    expect(await getBadgeTotals()).toBeNull();
    expect(await getBadgeDiagnostics()).toBeNull();
    const off = await onBadgeTotals(() => {});
    off();
    expect(listeners.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("drops the queue and stops when push is unavailable", async () => {
    avail = { available: false, platform: "ios" };
    setServerTotals("s1", { unread: 2 });
    await flushBadgeTotals();
    expect(calls).toEqual([]);
    expect(__pendingBadgeTotalsForTests()).toEqual({});
    // Disabled for the session: nothing queues any more.
    avail = { available: true, platform: "ios" };
    setServerTotals("s1", { unread: 2 });
    expect(__pendingBadgeTotalsForTests()).toEqual({});
  });

  it("is a no-op on Android", async () => {
    avail = { available: true, platform: "android" };
    expect(await badgeTotalsSupported()).toBe(false);
    setServerTotals("s1", { unread: 2 });
    await flushBadgeTotals();
    expect(calls).toEqual([]);
  });

  it("stops when native answers unavailable (no App Group)", async () => {
    native.set_server_totals = () => ({ available: false, sum: 0, reason: "no App Group" });
    setServerTotals("s1", { unread: 2 });
    setServerTotals("s2", { unread: 1 });
    await flushBadgeTotals();
    expect(calls).toHaveLength(1);
    setServerTotals("s1", { unread: 4 });
    expect(__pendingBadgeTotalsForTests()).toEqual({});
  });

  it("never throws when the plugin call fails", async () => {
    native.set_server_totals = () => {
      throw new Error("boom");
    };
    setServerTotals("s1", { unread: 2 });
    await expect(flushBadgeTotals()).resolves.toBeUndefined();
    native.get_badge_totals = () => {
      throw new Error("boom");
    };
    expect(await getBadgeTotals()).toBeNull();
  });
});

describe("subdomain derivation", () => {
  it("keys by the lowercased k2.dev tunnel label", async () => {
    setServerTotals("s1", { unread: 2, waiting: 1 });
    setServerTotals("s2", { unread: "4" });
    expect(__pendingBadgeTotalsForTests()).toEqual({
      rosson: { unread: 2, waiting: 1 },
      baden: { unread: 4 },
    });
    await flushBadgeTotals();
    expect(calls).toEqual([
      { cmd: "set_server_totals", args: { key: "rosson", unread: 2, waiting: 1 } },
      { cmd: "set_server_totals", args: { key: "baden", unread: 4 } },
    ]);
  });

  it("skips servers off k2.dev and unknown ids", () => {
    setServerTotals("lan", { unread: 2 });
    setServerTotals("connect", { unread: 2 });
    setServerTotals("nope", { unread: 2 });
    clearServerTotals("lan");
    expect(__pendingBadgeTotalsForTests()).toEqual({});
  });

  it("skips totals that are not non-negative numbers", () => {
    setServerTotals("s1", { unread: -1 });
    setServerTotals("s1", { unread: "x" });
    setServerTotals("s1", { unread: NaN });
    setServerTotals("s1", { unread: null });
    expect(__pendingBadgeTotalsForTests()).toEqual({});
    setServerTotals("s1", { unread: 2.7, waiting: -3 });
    expect(__pendingBadgeTotalsForTests()).toEqual({ rosson: { unread: 2 } });
  });
});

describe("coalescing", () => {
  it("sends only the last value per server, once, after the timer", async () => {
    vi.useFakeTimers();
    setServerTotals("s1", { unread: 1 });
    setServerTotals("s1", { unread: 2 });
    setServerTotals("s1", { unread: 3, waiting: 1 });
    setServerTotals("s2", { unread: 1 });
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(15);
    expect(calls).toEqual([
      { cmd: "set_server_totals", args: { key: "rosson", unread: 3, waiting: 1 } },
      { cmd: "set_server_totals", args: { key: "baden", unread: 1 } },
    ]);
  });

  it("a clear after a set wins, and vice versa", async () => {
    setServerTotals("s1", { unread: 3 });
    clearServerTotals("s1");
    setServerTotals("s2", { unread: 3 });
    clearServerTotals("s2");
    setServerTotals("s2", { unread: 1 });
    await flushBadgeTotals();
    expect(calls).toEqual([
      { cmd: "clear_server_totals", args: { key: "rosson" } },
      { cmd: "set_server_totals", args: { key: "baden", unread: 1 } },
    ]);
  });

  it("concurrent flushes share one run and pick up late updates", async () => {
    setServerTotals("s1", { unread: 1 });
    const a = flushBadgeTotals();
    setServerTotals("s2", { unread: 2 });
    const b = flushBadgeTotals();
    expect(a).toBe(b);
    await a;
    expect(calls.map((c) => c.args?.key)).toEqual(["rosson", "baden"]);
  });
});

describe("clear on forget / sign-out", () => {
  it("sign-out (leave) clears that server's subdomain", async () => {
    installBadgeServerHooks();
    leaveFns.forEach((fn) => fn({ id: "s1", url: "https://rosson.k2.dev" }));
    await flushBadgeTotals();
    expect(calls).toEqual([{ cmd: "clear_server_totals", args: { key: "rosson" } }]);
  });

  it("forget clears every stored subdomain no saved server uses", async () => {
    installBadgeServerHooks();
    forgetFns.forEach((fn) => fn("gone"));
    // "rosson" and "baden" are saved servers; "old" is not.
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { cmd: "get_badge_totals", args: undefined },
      { cmd: "clear_server_totals", args: { key: "old" } },
    ]);
  });

  it("installs once and removes cleanly", () => {
    const off1 = installBadgeServerHooks();
    const off2 = installBadgeServerHooks();
    expect(off1).toBe(off2);
    expect(forgetFns).toHaveLength(1);
    expect(leaveFns).toHaveLength(1);
    off1();
    expect(forgetFns).toHaveLength(0);
    expect(leaveFns).toHaveLength(0);
  });

  it("forget is a no-op when unsupported", async () => {
    install({ enabled: () => false });
    installBadgeServerHooks();
    forgetFns.forEach((fn) => fn("gone"));
    leaveFns.forEach((fn) => fn({ id: "s1", url: "https://rosson.k2.dev" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    expect(__pendingBadgeTotalsForTests()).toEqual({});
  });
});

describe("reads", () => {
  it("getBadgeTotals / getBadgeDiagnostics pass the native objects through", async () => {
    expect((await getBadgeTotals())?.sum).toBe(5);
    expect((await getBadgeDiagnostics())?.days["2026-10-17"].rosson).toEqual({
      silent: 2,
      alert: 1,
      lastAt: 5,
    });
    native.get_badge_diagnostics = () => ({ available: false, version: 1, days: {} });
    expect(await getBadgeDiagnostics()).toBeNull();
  });
});

describe("summarizeBadgeDiagnostics", () => {
  const now = new Date(2026, 9, 17, 15, 0);
  const days: Record<string, Record<string, BadgeDayCount>> = {
    [localDayKey(new Date(2026, 9, 17))]: {
      rosson: { silent: 3, alert: 2, lastAt: 300 },
      baden: { silent: 9, alert: 9, lastAt: 999 },
    },
    [localDayKey(new Date(2026, 9, 14))]: { rosson: { silent: 1, alert: 4, lastAt: 200 } },
    [localDayKey(new Date(2026, 9, 11))]: { rosson: { silent: 5, alert: 0, lastAt: 100 } },
    [localDayKey(new Date(2026, 9, 10))]: { rosson: { silent: 7, alert: 7, lastAt: 50 } },
  };

  it("counts today, the last 7 local days, and the newest time", () => {
    expect(summarizeBadgeDiagnostics({ days }, "Rosson", now)).toEqual({
      today: { silent: 3, alert: 2 },
      week: { silent: 9, alert: 6 },
      lastAt: 300,
    });
  });

  it("is all zero for a server with nothing received", () => {
    expect(summarizeBadgeDiagnostics({ days }, "other", now)).toEqual({
      today: { silent: 0, alert: 0 },
      week: { silent: 0, alert: 0 },
      lastAt: null,
    });
    expect(summarizeBadgeDiagnostics(null, "rosson", now).lastAt).toBeNull();
  });

  it("formats the local day key", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("onBadgeTotals", () => {
  it("forwards events with the matching saved server", async () => {
    const got: BadgeTotalsEvent[] = [];
    const off = await onBadgeTotals((e) => got.push(e));
    const fire = listeners.get("badgeTotals")!;
    fire({ subdomain: "rosson", unread: 4, waiting: 1, sum: 6 });
    fire({ subdomain: "elsewhere", unread: 2, sum: 8 });
    fire({ subdomain: "", unread: 2 });
    fire({ subdomain: "rosson", unread: "x" });
    expect(got).toEqual([
      { subdomain: "rosson", badgeKey: null, unread: 4, waiting: 1, sum: 6, serverId: "s1" },
      { subdomain: "elsewhere", badgeKey: null, unread: 2, waiting: null, sum: 8, serverId: null },
    ]);
    off();
    expect(unregistered).toEqual(["badgeTotals"]);
  });

  it("a duplicate delivery is just another event", async () => {
    const got: BadgeTotalsEvent[] = [];
    await onBadgeTotals((e) => got.push(e));
    const fire = listeners.get("badgeTotals")!;
    fire({ subdomain: "baden", unread: 1, sum: 1 });
    fire({ subdomain: "baden", unread: 1, sum: 1 });
    expect(got).toHaveLength(2);
  });

  it("does not subscribe when unsupported, and survives a listener failure", async () => {
    avail = { available: false, platform: "ios" };
    const off = await onBadgeTotals(() => {});
    off();
    expect(listeners.size).toBe(0);

    avail = { available: true, platform: "ios" };
    install({
      listen: async () => {
        throw new Error("no plugin");
      },
    });
    const off2 = await onBadgeTotals(() => {});
    expect(typeof off2).toBe("function");
  });
});

describe("badgeKey store key (K2 0.46.1)", () => {
  beforeEach(() => {
    // Two logins on one host: an owner and a member on rosson.k2.dev.
    servers = [
      { id: "own", url: "https://rosson.k2.dev" },
      { id: "mem", url: "https://rosson.k2.dev" },
      { id: "s2", url: "https://baden.k2.dev" },
    ];
  });

  it("keys by the badgeKey when known, else by the tunnel label", async () => {
    keys = { own: "bkOwner", mem: "bkMember" };
    expect(badgeStoreKey("own")).toBe("bkOwner");
    expect(badgeStoreKey("s2")).toBe("baden");
    setServerTotals("own", { unread: 2 });
    setServerTotals("mem", { unread: 5, waiting: 1 });
    setServerTotals("s2", { unread: 1 });
    await flushBadgeTotals();
    // Both logins keep their own entry; nothing collides on "rosson"
    // (still written by no one, so cleared once).
    expect(calls).toEqual([
      { cmd: "clear_server_totals", args: { key: "rosson" } },
      { cmd: "set_server_totals", args: { key: "bkOwner", unread: 2 } },
      { cmd: "set_server_totals", args: { key: "bkMember", unread: 5, waiting: 1 } },
      { cmd: "set_server_totals", args: { key: "baden", unread: 1 } },
    ]);
  });

  it("moves a server off its tunnel label once its badgeKey is known", async () => {
    servers = [{ id: "s1", url: "https://rosson.k2.dev" }];
    setServerTotals("s1", { unread: 2 });
    await flushBadgeTotals();
    installBadgeServerHooks();
    setKey("s1", "bk1");
    setServerTotals("s1", { unread: 3 });
    await flushBadgeTotals();
    expect(calls).toEqual([
      { cmd: "set_server_totals", args: { key: "rosson", unread: 2 } },
      { cmd: "clear_server_totals", args: { key: "rosson" } },
      { cmd: "set_server_totals", args: { key: "bk1", unread: 3 } },
    ]);
    // Steady state: no more clears.
    calls = [];
    setServerTotals("s1", { unread: 4 });
    await flushBadgeTotals();
    expect(calls).toEqual([{ cmd: "set_server_totals", args: { key: "bk1", unread: 4 } }]);
  });

  it("first write of a session with a known key clears a label entry left from before", async () => {
    servers = [{ id: "s1", url: "https://rosson.k2.dev" }];
    keys = { s1: "bk1" };
    setServerTotals("s1", { unread: 1 });
    await flushBadgeTotals();
    expect(calls).toEqual([
      { cmd: "clear_server_totals", args: { key: "rosson" } },
      { cmd: "set_server_totals", args: { key: "bk1", unread: 1 } },
    ]);
  });

  it("keeps the label entry while another login on that host still writes it", async () => {
    keys = { own: "bkOwner" };
    setServerTotals("own", { unread: 2 });
    setServerTotals("mem", { unread: 1 });
    await flushBadgeTotals();
    expect(calls).toEqual([
      { cmd: "set_server_totals", args: { key: "bkOwner", unread: 2 } },
      { cmd: "set_server_totals", args: { key: "rosson", unread: 1 } },
    ]);
  });

  it("a changed badgeKey clears the old entry; a shared key is kept", async () => {
    installBadgeServerHooks();
    keys = { own: "bkA", mem: "bkM" };
    setKey("own", "bkB");
    await flushBadgeTotals();
    expect(calls).toEqual([{ cmd: "clear_server_totals", args: { key: "bkA" } }]);
    // Owner token + owner-linked login share one key: forgetting one keeps it.
    calls = [];
    keys = { own: "bkO", mem: "bkO" };
    setKey("mem", null);
    await flushBadgeTotals();
    expect(calls).toEqual([]);
  });

  it("clear / sign-out clears the badgeKey entry", async () => {
    keys = { own: "bkOwner", mem: "bkMember" };
    clearServerTotals("own");
    installBadgeServerHooks();
    leaveFns.forEach((fn) => fn({ id: "mem", url: "https://rosson.k2.dev" }));
    await flushBadgeTotals();
    expect(calls).toEqual([
      { cmd: "clear_server_totals", args: { key: "bkOwner" } },
      { cmd: "clear_server_totals", args: { key: "rosson" } },
      { cmd: "clear_server_totals", args: { key: "bkMember" } },
    ]);
  });

  it("forget sweeps keys no saved server writes now", async () => {
    keys = { own: "bkOwner" };
    native.get_badge_totals = () => ({
      available: true,
      sum: 9,
      version: 1,
      servers: {
        bkOwner: { unread: 1, waiting: 0, at: 1 },
        bkGone: { unread: 2, waiting: 0, at: 1 },
        rosson: { unread: 3, waiting: 0, at: 1 },
        baden: { unread: 3, waiting: 0, at: 1 },
      },
    });
    installBadgeServerHooks();
    forgetFns.forEach((fn) => fn("gone"));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // "rosson" stays: "mem" has no key yet and writes it.
    expect(calls[1]).toEqual({ cmd: "clear_server_totals", args: { key: "bkGone" } });
  });
});

describe("badgeTotals event → server (K2 0.46.1)", () => {
  const two = [
    { id: "own", url: "https://rosson.k2.dev" },
    { id: "mem", url: "https://rosson.k2.dev" },
    { id: "s2", url: "https://baden.k2.dev" },
  ];

  it("maps the badgeKey to the saved login on that host", () => {
    const keyOf = (id: string) => ({ own: "bkO", mem: "bkM" })[id] ?? null;
    expect(serverForBadgeEvent({ subdomain: "rosson", badgeKey: "bkM" }, two, keyOf)).toBe("mem");
    expect(serverForBadgeEvent({ subdomain: "rosson", badgeKey: "bkO" }, two, keyOf)).toBe("own");
    // A key held on another host never maps across hosts.
    expect(serverForBadgeEvent({ subdomain: "baden", badgeKey: "bkM" }, two, keyOf)).toBe("s2");
  });

  it("falls back to the tunnel label, preferring a login whose key is unknown", () => {
    const keyOf = (id: string) => ({ own: "bkO" })[id] ?? null;
    expect(serverForBadgeEvent({ subdomain: "rosson", badgeKey: "bkNew" }, two, keyOf)).toBe("mem");
    expect(serverForBadgeEvent({ subdomain: "rosson", badgeKey: null }, two, keyOf)).toBe("own");
    expect(serverForBadgeEvent({ subdomain: "nowhere", badgeKey: "bkO" }, two, keyOf)).toBeNull();
    // No subdomain: the key alone (a refresh hint only).
    expect(serverForBadgeEvent({ subdomain: "", badgeKey: "bkO" }, two, keyOf)).toBe("own");
    expect(serverForBadgeEvent({ subdomain: "", badgeKey: "bkX" }, two, keyOf)).toBeNull();
  });

  it("the plugin event carries the key and the mapped server", async () => {
    servers = two;
    keys = { own: "bkO", mem: "bkM" };
    const got: BadgeTotalsEvent[] = [];
    await onBadgeTotals((e) => got.push(e));
    const fire = listeners.get("badgeTotals")!;
    fire({ key: "bkM", subdomain: "rosson", badgeKey: "bkM", unread: 3, waiting: 0, sum: 3 });
    fire({ key: "bkO", badgeKey: "bkO", unread: 1, sum: 4 });
    fire({ key: "x", badgeKey: "bad key!", unread: 1 });
    expect(got).toEqual([
      { subdomain: "rosson", badgeKey: "bkM", unread: 3, waiting: 0, sum: 3, serverId: "mem" },
      { subdomain: "", badgeKey: "bkO", unread: 1, waiting: null, sum: 4, serverId: "own" },
    ]);
  });
});
