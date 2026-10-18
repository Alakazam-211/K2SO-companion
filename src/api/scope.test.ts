// MS4 / MA28: ServerScope — memoised per server id, live creds, lazy
// ServerRemovedError, never another server's token; activeScope() shim;
// per-scope feature memory from /boot-status (MS31); per-server memories
// dropped on remove / re-key (MS3).

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import {
  DAEMON_FEATURES,
  NO_SERVER_SCOPE,
  ServerRemovedError,
  __resetScopesForTests,
  activeScope,
  bootInfoFor,
  ensureBootStatus,
  noteBootStatus,
  refreshBootStatus,
  scopeFor,
  scopedKey,
  serverMemory,
  versionAtLeast,
} from "./scope";
import { useServersStore, type ServerEntry } from "../stores/servers";

const A: ServerEntry = {
  id: "a",
  nickname: "Rosson",
  url: "https://rosson.k2.dev",
  username: "rosson",
  rememberPassword: false,
};
const B: ServerEntry = {
  id: "b",
  nickname: "",
  url: "http://192.168.1.20:38471",
  username: "baden",
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

beforeEach(() => {
  fetchMock.mockReset();
  __resetScopesForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [A, B],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: {},
  });
});

describe("scopeFor (MS4)", () => {
  it("is one object per server id and never follows a switch", () => {
    const a = scopeFor("a");
    expect(scopeFor("a")).toBe(a);
    expect(a.id).toBe("a");
    expect(a.hostKey).toBe("rosson.k2.dev");
    expect(a.label).toBe("Rosson");
    useServersStore.getState().setActive("b");
    expect(a.httpBase()).toBe("https://rosson.k2.dev");
    expect(a.token()).toBe("tok-a");
  });

  it("reads creds at call time, so a re-sign-in is picked up", () => {
    const b = scopeFor("b");
    expect(b.token()).toBe("tok-b");
    useServersStore.getState().setToken("b", "tok-b-2");
    expect(b.token()).toBe("tok-b-2");
    expect(b.wsBase()).toBe("ws://192.168.1.20:38471");
    expect(b.hostKey).toBe("192.168.1.20:38471");
    expect(b.label).toBe("192.168.1.20:38471");
    expect(b.username()).toBe("baden");
  });

  it("never hands out another server's token", () => {
    useServersStore.getState().clearToken("b");
    expect(scopeFor("b").token()).toBe("");
    expect(scopeFor("a").token()).toBe("tok-a");
  });

  it("a removed server throws ServerRemovedError lazily — no fallback", () => {
    const b = scopeFor("b");
    expect(b.httpBase()).toBe("http://192.168.1.20:38471");
    useServersStore.getState().removeServer("b");
    expect(() => b.httpBase()).toThrow(ServerRemovedError);
    expect(() => b.token()).toThrow(ServerRemovedError);
    expect(() => b.wsBase()).toThrow(ServerRemovedError);
    // The last known identity stays readable for copy.
    expect(b.hostKey).toBe("192.168.1.20:38471");
    // A scope for an id that was never saved fails the same way.
    expect(() => scopeFor("ghost").httpBase()).toThrow(ServerRemovedError);
  });

  it("follows an address edit of the same id (hostKey is derived now)", () => {
    const a = scopeFor("a");
    useServersStore.getState().upsertServer({ ...A, url: "https://dtl.k2.dev" });
    expect(a.hostKey).toBe("dtl.k2.dev");
    expect(a.httpBase()).toBe("https://dtl.k2.dev");
  });
});

describe("activeScope shim (MS5)", () => {
  it("is the active server's pinned scope, resolved at call time", () => {
    expect(activeScope()).toBe(scopeFor("a"));
    useServersStore.getState().setActive("b");
    expect(activeScope()).toBe(scopeFor("b"));
  });

  it("is the no-server scope when nothing is active", () => {
    useServersStore.setState({ activeServerId: null });
    expect(activeScope()).toBe(NO_SERVER_SCOPE);
    expect(activeScope().httpBase()).toBe("");
    expect(activeScope().token()).toBe("");
  });

  it("scopedKey prefixes the server id (MA2)", () => {
    expect(scopedKey(scopeFor("b"), "t:appa")).toBe("b|t:appa");
  });
});

describe("feature memory (MS31 / MA15)", () => {
  it("lists all 17 daemon features (0.46.1 adds push-previews-v1, push-environment-v1, thread-read-v1)", () => {
    expect(DAEMON_FEATURES).toHaveLength(17);
    expect(DAEMON_FEATURES).toContain("thread-read-v1");
  });

  it("unknown supports nothing; boot-status features decide per server", () => {
    const a = scopeFor("a");
    const b = scopeFor("b");
    expect(a.supports("daemon-activity")).toBe(false);
    expect(a.version()).toBeNull();
    noteBootStatus("a", { version: "0.45.3", features: ["daemon-activity"], instanceId: "i1" });
    expect(a.supports("daemon-activity")).toBe(true);
    expect(a.version()).toBe("0.45.3");
    expect(b.supports("daemon-activity")).toBe(false);
  });

  it("refreshBootStatus reads the scope's own /boot-status without a token", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { version: "0.44.3", phase: "ready", features: ["tickets-list-all"], instanceId: "x" })
    );
    const info = await refreshBootStatus(scopeFor("b"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers?: unknown }];
    expect(url).toBe("http://192.168.1.20:38471/boot-status");
    expect(init.headers).toBeUndefined();
    expect(info?.version).toBe("0.44.3");
    expect(scopeFor("b").supports("tickets-list-all")).toBe(true);
    expect(scopeFor("a").supports("tickets-list-all")).toBe(false);
  });

  it("retries once on a connection error only, and is single-flight", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("Load failed"))
      .mockResolvedValueOnce(json(200, { version: "0.45.3", features: [] }));
    const [x, y] = await Promise.all([refreshBootStatus(scopeFor("a")), refreshBootStatus(scopeFor("a"))]);
    expect(x).toBe(y);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(503, { state: "migrating" }));
    expect((await refreshBootStatus(scopeFor("a")))?.version).toBe("0.45.3"); // keeps what was known
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ensureBootStatus uses a fresh answer instead of asking again", async () => {
    noteBootStatus("a", { version: "0.45.3", features: [] });
    await ensureBootStatus(scopeFor("a"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a re-key or removal drops that server's feature memory (MS3)", () => {
    noteBootStatus("a", { version: "0.45.3", features: ["daemon-activity"] });
    useServersStore.getState().upsertServer({ ...A, url: "https://elsewhere.k2.dev" });
    expect(bootInfoFor("a")).toBeNull();
    expect(scopeFor("a").supports("daemon-activity")).toBe(false);
  });

  it("versionAtLeast compares dotted versions", () => {
    expect(versionAtLeast("0.44.4", "0.44.4")).toBe(true);
    expect(versionAtLeast("v0.45.3-dev", "0.44.4")).toBe(true);
    expect(versionAtLeast("0.44.3", "0.44.4")).toBe(false);
    expect(versionAtLeast("0.9.10", "0.10.0")).toBe(false);
    expect(versionAtLeast(null, "0.44.4")).toBe(false);
  });
});

describe("serverMemory (MA6)", () => {
  it("keeps one slot per server and drops it on removal", () => {
    const mem = serverMemory(() => ({ n: 0 }));
    mem.get("a").n += 1;
    mem.get("b").n += 5;
    expect(mem.get("a").n).toBe(1);
    useServersStore.getState().removeServer("b");
    expect(mem.peek("b")).toBeUndefined();
    expect(mem.get("a").n).toBe(1);
  });
});
