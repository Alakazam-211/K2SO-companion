// K2 0.46.3 boot-status views (boot-status-views-contract-0463.md, for
// Companion 4.0.4): Bearer when a token is held, one retry without it on
// 401/403, stranger's views never clear what was known, a token answered
// with a stranger's view runs the re-login check, protocol range.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, reviveMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  reviveMock: vi.fn(async () => "still-valid"),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));
vi.mock("../lib/revive", async (orig) => ({
  ...(await orig<typeof import("../lib/revive")>()),
  reviveServerSession: reviveMock,
}));

import {
  PHONE_PROTOCOL,
  __resetScopesForTests,
  bootInfoFor,
  noteBootStatus,
  protocolOutOfRange,
  readBootStatus,
  refreshBootStatus,
  scopeFor,
} from "./scope";
import { getBootStatus } from "./client";
import { parseBoot } from "../zen/multi/pool";
import { useServersStore, type ServerEntry } from "../stores/servers";

const A: ServerEntry = {
  id: "a",
  nickname: "Rosson",
  url: "https://rosson.k2.dev",
  username: "rosson",
  rememberPassword: false,
};

function json(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const FULL = {
  view: "full",
  phase: "ready",
  protocol: 1,
  protocolMin: 1,
  instanceId: "i1",
  version: "0.46.3",
  features: ["thread-push-v1", "boot-status-views-v1"],
  serverId: "0123456789abcdef",
  publicHost: "rosson.k2.dev",
  airgap: { enabled: true },
};
const PUBLIC = { view: "public", phase: "ready", protocol: 1, protocolMin: 1, instanceId: "i2" };

beforeEach(() => {
  fetchMock.mockReset();
  reviveMock.mockClear();
  __resetScopesForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [A],
    activeServerId: "a",
    tokens: { a: "tok-a" },
    recovery: {},
  });
});

describe("Bearer on /boot-status", () => {
  it("no token held → no header", async () => {
    useServersStore.setState({ tokens: {} });
    fetchMock.mockResolvedValueOnce(json(200, FULL));
    await readBootStatus(scopeFor("a"));
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: "GET" });
  });

  it("a 401/403 with a token retries once without it", async () => {
    fetchMock
      .mockResolvedValueOnce(json(403, { error: "must change password" }))
      .mockResolvedValueOnce(json(200, { phase: "ready", version: "0.46.2", features: [] }));
    const body = await readBootStatus(scopeFor("a"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: "GET", headers: { Authorization: "Bearer tok-a" } });
    expect(fetchMock.mock.calls[1][1]).toEqual({ method: "GET" });
    expect((body as { version: string }).version).toBe("0.46.2");
    expect(reviveMock).not.toHaveBeenCalled(); // tokenless answer: no stale verdict
  });
});

describe("stranger's views keep what was known", () => {
  it("a public body updates phase/instanceId/protocol only", () => {
    noteBootStatus("a", FULL);
    const info = noteBootStatus("a", PUBLIC);
    expect(info.view).toBe("public");
    expect(info.instanceId).toBe("i2");
    expect(info.version).toBe("0.46.3");
    expect(info.features && [...info.features]).toEqual(FULL.features);
    expect(info.serverId).toBe("0123456789abcdef");
    expect(info.publicHost).toBe("rosson.k2.dev");
    expect(info.airgap).toBe(true);
    expect(scopeFor("a").supports("thread-push-v1")).toBe(true);
  });

  it("a compat body updates what it carries", () => {
    noteBootStatus("a", FULL);
    const info = noteBootStatus("a", { ...PUBLIC, view: "compat", version: "0.46.4", features: ["x"] });
    expect(info.version).toBe("0.46.4");
    expect(info.features && [...info.features]).toEqual(["x"]);
    expect(info.serverId).toBe("0123456789abcdef");
  });

  it("an old daemon's body (no view) still means absent = none", () => {
    noteBootStatus("a", FULL);
    const info = noteBootStatus("a", { phase: "ready", version: "0.46.2" });
    expect(info.features).toBeNull();
    expect(info.serverId).toBeNull();
  });

  it("public with nothing cached: features unknown, not unsupported", async () => {
    useServersStore.setState({ tokens: {} });
    fetchMock.mockResolvedValueOnce(json(200, PUBLIC));
    const b = await getBootStatus(scopeFor("a"), { fresh: true });
    expect(b?.features).toEqual([]);
    expect(b?.featuresKnown).toBe(false);
    noteBootStatus("a", { phase: "ready", version: "0.45.4" });
    expect((await getBootStatus(scopeFor("a")))?.featuresKnown).toBe(true);
  });

  it("the pool keeps version and features across a public body", () => {
    const full = parseBoot(FULL, 1);
    const pub = parseBoot(PUBLIC, 2, full);
    expect(pub.version).toBe("0.46.3");
    expect(pub.features).toEqual(FULL.features);
    expect(pub.instanceId).toBe("i2");
    expect(pub.view).toBe("public");
    expect(parseBoot({ phase: "ready" }, 3, full).features).toEqual([]);
  });
});

describe("token sent, view not full → re-login check", () => {
  /** Answer /boot-status with `boot` and whoami with `who`. */
  function serve(boot: unknown, who: { status: number; body: unknown }) {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/cli/auth/whoami") ? json(who.status, who.body) : json(200, boot)
    );
  }
  const whoamiCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/cli/auth/whoami")).length;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("a full body checks nothing; a stale one asks whoami once per window", async () => {
    serve(FULL, { status: 200, body: { username: "rosson" } });
    await refreshBootStatus(scopeFor("a"));
    await settle();
    expect(whoamiCalls()).toBe(0);

    serve(PUBLIC, { status: 200, body: { username: "rosson" } });
    await refreshBootStatus(scopeFor("a"));
    await settle();
    expect(whoamiCalls()).toBe(1);
    await refreshBootStatus(scopeFor("a"));
    await settle();
    expect(whoamiCalls()).toBe(1); // throttled
    expect(reviveMock).not.toHaveBeenCalled(); // whoami alive
    expect(bootInfoFor("a")?.version).toBe("0.46.3"); // kept from the full read; never "offline"
  });

  it("whoami rejects the token → the background re-login path", async () => {
    serve(PUBLIC, { status: 401, body: { error: "unauthorized" } });
    await refreshBootStatus(scopeFor("a"));
    await settle();
    await settle();
    expect(reviveMock).toHaveBeenCalledWith("a", { background: true });
  });

  it("mustChangePassword explains it: no re-checks for that token, until a new token or a full answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      serve({ ...PUBLIC, view: "compat" }, { status: 200, body: { mustChangePassword: true } });
      await refreshBootStatus(scopeFor("a"));
      await settle();
      expect(whoamiCalls()).toBe(1);
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await refreshBootStatus(scopeFor("a"));
      await settle();
      expect(whoamiCalls()).toBe(1); // explained, even past the window
      expect(reviveMock).not.toHaveBeenCalled();

      useServersStore.setState({ tokens: { a: "tok-a2" } }); // signed in again / password changed
      await refreshBootStatus(scopeFor("a"));
      await settle();
      expect(whoamiCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("not while the server already needs a sign-in", async () => {
    useServersStore.setState({ recovery: { a: "signin-required" } });
    serve(PUBLIC, { status: 401, body: {} });
    await refreshBootStatus(scopeFor("a"));
    await settle();
    expect(whoamiCalls()).toBe(0);
    expect(reviveMock).not.toHaveBeenCalled();
  });
});

describe("protocol range", () => {
  it("is out of range only when known and excluding this phone", () => {
    expect(PHONE_PROTOCOL).toBe(1);
    expect(protocolOutOfRange(null)).toBe(false);
    expect(protocolOutOfRange({ protocol: null, protocolMin: null })).toBe(false);
    expect(protocolOutOfRange({ protocol: 1, protocolMin: 1 })).toBe(false);
    expect(protocolOutOfRange({ protocol: 1 })).toBe(false); // ≤0.46.2: min defaults to 1
    expect(protocolOutOfRange({ protocol: 2, protocolMin: 2 })).toBe(true);
    expect(protocolOutOfRange({ protocol: 0, protocolMin: 0 })).toBe(true);
  });
});
