// MS7 / MA4 exit test: a request made with server B's scope never reaches
// server A's host — not on the first try, not on the revive probe, not on
// the replay — and that holds for EVERY phone HTTP stack: `api/client`,
// `api/feedback`, `api/projectGroups`, `api/sendMessage`, `lib/sessionAuthor`
// and `lib/push`. The active server is A throughout (or flips to A
// mid-request), which is exactly what used to leak.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, reviveOverride } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  reviveOverride: { fn: null as null | ((scope: { id: string }) => Promise<string>) },
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async (file: string) => {
    if (file !== "push.json") throw new Error("no tauri");
    return { get: async () => "device-1", set: async () => {}, save: async () => {} };
  }),
}));
// Real revive, unless a test swaps in a stand-in for the "revived" path
// (no password is stored, so the real one can never mint a token).
vi.mock("../lib/revive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/revive")>();
  return {
    ...actual,
    revive: (scope: { id: string }) =>
      reviveOverride.fn ? reviveOverride.fn(scope) : actual.revive(scope),
  };
});

import { __resetReviveForTests } from "../lib/revive";
import { __resetScopesForTests, scopeFor } from "./scope";
import { useServersStore } from "../stores/servers";
import {
  getActivitySnapshot,
  getThread,
  inspectProjectsSummary,
  resetActivityRouteMemory,
  resetWriteVerbMemory,
  setSessionLabel,
} from "./client";
import { fetchFeedbackShow } from "./feedback";
import { fetchProjectGroups } from "./projectGroups";
import { sendMessageToSession } from "./sendMessage";
import { __resetIdentityForTests, ensureIdentity } from "../lib/sessionAuthor";
import { unregister } from "../lib/push";

const A_HOST = "https://a.k2.dev";
const B_HOST = "https://b.k2.dev";
const TOKEN_GATE = { error: "Invalid or missing auth token" };

function answer(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Call = { url: string; auth: string | undefined };
function calls(): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    auth: (init as { headers?: Record<string, string> } | undefined)?.headers?.Authorization,
  }));
}

function expectOnlyB(): void {
  const all = calls();
  expect(all.length).toBeGreaterThan(0);
  for (const c of all) {
    expect(c.url.startsWith(B_HOST)).toBe(true);
    expect(c.url.startsWith(A_HOST)).toBe(false);
    if (c.auth) expect(c.auth).not.toContain("tok-a");
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  reviveOverride.fn = null;
  __resetReviveForTests();
  __resetScopesForTests();
  __resetIdentityForTests();
  resetActivityRouteMemory();
  resetWriteVerbMemory();
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "a", nickname: "A", url: A_HOST, username: "ua", rememberPassword: false },
      { id: "b", nickname: "B", url: B_HOST, username: "ub", rememberPassword: false },
    ],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: { a: "connected", b: "connected" },
  });
});

const B = () => scopeFor("b");

describe("no fallback: every stack stays on its scope's server (MS7)", () => {
  it("api/client: request, its 403 revive probe and the answer all stay on B", async () => {
    // First try: a token-gate 403 → revive whoami-probes B (alive) → no replay.
    fetchMock
      .mockResolvedValueOnce(answer(403, TOKEN_GATE))
      .mockResolvedValueOnce(answer(200, { username: "ub" }));
    const r = await getThread(B(), "appa");
    expect(r.ok).toBe(false);
    expectOnlyB();
    expect(calls().map((c) => c.url)).toEqual([
      `${B_HOST}/cli/thread?addr=appa&limit=50`,
      `${B_HOST}/cli/auth/whoami`,
    ]);
    // B's recovery state moved, A's never did.
    expect(useServersStore.getState().recovery.a).toBe("connected");
  });

  it("api/client: a switch to A mid-request does not move the retry", async () => {
    useServersStore.setState({ activeServerId: "b" });
    let release: (v: unknown) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValueOnce(answer(200, { username: "ub" }));
    const pending = getThread(B(), "appa");
    useServersStore.getState().setActive("a"); // the user switches servers
    release(answer(401, { error: "unauthorized" }));
    await pending;
    expectOnlyB();
  });

  it("api/client: the replay after a revive uses B's NEW token on B", async () => {
    reviveOverride.fn = async (scope) => {
      expect(scope.id).toBe("b");
      useServersStore.getState().setToken("b", "tok-b-2");
      useServersStore.getState().setActive("a");
      return "revived";
    };
    fetchMock
      .mockResolvedValueOnce(answer(403, TOKEN_GATE))
      .mockResolvedValueOnce(answer(200, { items: [] }));
    const r = await getThread(B(), "appa");
    expect(r.ok).toBe(true);
    expectOnlyB();
    expect(calls().map((c) => c.auth)).toEqual(["Bearer tok-b", "Bearer tok-b-2"]);
  });

  it("api/client: the legacy-GET verb fallback (MA15) stays on B", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(405, { error: "method" }))
      .mockResolvedValueOnce(answer(200, { label: "x" }));
    await setSessionLabel(B(), "sid", "x");
    expectOnlyB();
  });

  it("api/client: inspectProjectsSummary and the activity routes stay on B", async () => {
    fetchMock.mockResolvedValue(answer(200, { rows: [] }));
    await inspectProjectsSummary(B());
    await getActivitySnapshot(B());
    expectOnlyB();
  });

  it("api/feedback stays on B (revive probe included)", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(403, TOKEN_GATE))
      .mockResolvedValueOnce(answer(200, { username: "ub" }));
    await expect(fetchFeedbackShow(B(), "t1")).rejects.toThrow();
    expectOnlyB();
  });

  it("api/projectGroups stays on B (revive probe included)", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(401, { error: "nope" }))
      .mockResolvedValueOnce(answer(200, { username: "ub" }));
    await fetchProjectGroups(B());
    expectOnlyB();
  });

  it("api/sendMessage stays on B (revive probe included)", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(403, TOKEN_GATE))
      .mockResolvedValueOnce(answer(200, { username: "ub" }));
    await sendMessageToSession(B(), "sid", "hello");
    expectOnlyB();
  });

  it("lib/sessionAuthor asks B's whoami and caches it for B only", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { username: "ub", owner: false, role: "member" }));
    const who = await ensureIdentity(B());
    expect(who?.username).toBe("ub");
    expectOnlyB();
    expect(calls()[0].auth).toBe("Bearer tok-b");
  });

  it("lib/push posts to B with B's token", async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { ok: true }));
    await unregister(B());
    expectOnlyB();
    expect(calls()[0]).toEqual({
      url: `${B_HOST}/cli/push/unregister-device`,
      auth: "Bearer tok-b",
    });
  });

  it("a removed B fails closed: nothing is sent anywhere", async () => {
    const b = B();
    useServersStore.getState().removeServer("b");
    const r = await getThread(b, "appa");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/removed/);
    await sendMessageToSession(b, "sid", "x");
    await fetchProjectGroups(b);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("per-server route memory (MS8)", () => {
  it("a pre-0.45 404 on A never silences B's activity routes", async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { error: "route not found" }));
    await getActivitySnapshot(scopeFor("a"));
    fetchMock.mockResolvedValueOnce(answer(200, { rows: [] }));
    const r = await getActivitySnapshot(B());
    expect(r.ok).toBe(true);
    // A is remembered as missing: no second request to A.
    await getActivitySnapshot(scopeFor("a"));
    expect(calls().map((c) => c.url)).toEqual([
      `${A_HOST}/cli/activity/snapshot`,
      `${B_HOST}/cli/activity/snapshot`,
    ]);
  });
});
