// MS27 as amended by MA14: close codes per socket, on server B while A is
// active. Every whoami lands on B; no socket ever deletes a token (MA22).
//
//   sessions/events: 4001 kicked (no reconnect, pool + room hear it),
//                    4003 revoked (whoami, then reconnect / stop),
//                    4008 lagged (reconnect at once, re-pull),
//                    other → 500 ms … 5 s with bounded jitter;
//   grid:            4003 → whoami; any other drop reopens with NO whoami;
//   overlay:         1005 → reconnect; a second 1005 within 5 s → whoami.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import { GridSocket } from "./gridSocket";
import { __resetScopesForTests, scopeFor } from "./scope";
import { __resetDialQueueForTests } from "./dialQueue";
import { onServerSignal, type ServerSignal } from "./serverSignals";
import { __resetReviveForTests, __setDeadRecheckMsForTests } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { connectOverlayEvents } from "../zen/overlayEvents";
import {
  EVENTS_BACKOFF_CAP_MS,
  connectProjectEvents,
  eventsBackoffMs,
  hubState,
} from "../zen/ticketEvents";
import { pool } from "../zen/multi/pool";

class MockWS {
  static instances: MockWS[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  openNow() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const A_HOST = "https://a.k2.dev";
const B_HOST = "https://b.k2.dev";
const ok = (body: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
const gate = () => ({
  status: 403,
  ok: false,
  text: async () => JSON.stringify({ error: "Invalid or missing auth token" }),
});

let signals: Array<[string, ServerSignal]> = [];
let stopSignals: () => void = () => {};

const whoamiCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cli/auth/whoami"));

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok({ username: "ub" }));
  __resetScopesForTests();
  __resetReviveForTests();
  __resetDialQueueForTests();
  __setDeadRecheckMsForTests(1000);
  pool.forget("b");
  signals = [];
  stopSignals = onServerSignal((id, s) => signals.push([id, s]));
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "a", nickname: "A", url: A_HOST, username: "ua", rememberPassword: false },
      { id: "b", nickname: "B", url: B_HOST, username: "ub", rememberPassword: false },
    ],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: {},
  });
});

afterEach(() => {
  stopSignals();
  __setDeadRecheckMsForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sessions/events hub close codes (B, while A is active)", () => {
  it("4001 kicked: no reconnect, no whoami, the pool row says Removed", async () => {
    const h = connectProjectEvents(scopeFor("b"), () => {});
    const ws = MockWS.instances[0];
    ws.openNow();
    ws.drop(4001);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWS.instances).toHaveLength(1);
    expect(whoamiCalls()).toHaveLength(0);
    expect(hubState("b")).toBe("none");
    expect(signals).toContainEqual(["b", "kicked"]);
    expect(pool.entry("b")?.auth).toBe("kicked");
    expect(useServersStore.getState().tokens.b).toBe("tok-b"); // never deleted
    h.stop();
  });

  it("4003 revoked: whoami on B, then a reconnect while the token stands", async () => {
    const h = connectProjectEvents(scopeFor("b"), () => {});
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(4003);
    await vi.advanceTimersByTimeAsync(0);
    expect(whoamiCalls().map(([u]) => String(u))).toEqual([`${B_HOST}/cli/auth/whoami`]);
    await vi.advanceTimersByTimeAsync(EVENTS_BACKOFF_CAP_MS);
    expect(MockWS.instances).toHaveLength(2);
    expect(MockWS.instances[1].url.startsWith("wss://b.k2.dev/")).toBe(true);
    h.stop();
  });

  it("4003 with a dead token (twice, 1 s apart): stops, keeps the token, says sign in", async () => {
    fetchMock.mockResolvedValue(gate());
    const h = connectProjectEvents(scopeFor("b"), () => {});
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(4003);
    await vi.advanceTimersByTimeAsync(0);
    expect(whoamiCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(whoamiCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(MockWS.instances).toHaveLength(1);
    expect(signals).toContainEqual(["b", "signin"]);
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
    expect(pool.entry("b")?.auth).toBe("signin-required");
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith(B_HOST)).toBe(true);
    h.stop();
  });

  it("4008 lagged: reconnects at once and re-pulls", async () => {
    const onChange = vi.fn();
    const h = connectProjectEvents(scopeFor("b"), onChange);
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(4008);
    expect(signals).toContainEqual(["b", "lagged"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWS.instances).toHaveLength(2);
    MockWS.instances[1].openNow();
    await vi.advanceTimersByTimeAsync(400);
    expect(onChange).toHaveBeenCalledTimes(1); // the re-pull
    expect(whoamiCalls()).toHaveLength(0);
    h.stop();
  });

  it("any other close: backoff 500 ms doubling to 5 s, jitter inside [ms/2, ms], no whoami", async () => {
    expect(eventsBackoffMs(0, () => 0)).toBe(250);
    expect(eventsBackoffMs(0, () => 1)).toBe(500);
    expect(eventsBackoffMs(3, () => 1)).toBe(4000);
    expect(eventsBackoffMs(9, () => 1)).toBe(5000);
    expect(eventsBackoffMs(9, () => 0)).toBe(2500);
    const h = connectProjectEvents(scopeFor("b"), () => {});
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(MockWS.instances).toHaveLength(2);
    expect(whoamiCalls()).toHaveLength(0);
    h.stop();
  });
});

describe("grid close codes", () => {
  it("a plain drop reopens on B with no whoami (MA14: not on every reconnect)", async () => {
    const sock = new GridSocket(scopeFor("b"), () => {});
    sock.connect("sess-b");
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(1006);
    await vi.advanceTimersByTimeAsync(600);
    expect(MockWS.instances.length).toBe(2);
    expect(whoamiCalls()).toHaveLength(0);
    sock.close();
  });

  it("4003: whoami on B first, then the reopen on B", async () => {
    const sock = new GridSocket(scopeFor("b"), () => {});
    sock.connect("sess-b");
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(4003);
    await vi.advanceTimersByTimeAsync(600);
    expect(whoamiCalls().map(([u]) => String(u))).toEqual([`${B_HOST}/cli/auth/whoami`]);
    expect(MockWS.instances.length).toBe(2);
    expect(MockWS.instances[1].url.startsWith("wss://b.k2.dev/")).toBe(true);
    sock.close();
  });

  it("4003 with a dead token stops the grid and keeps the token", async () => {
    fetchMock.mockResolvedValue(gate());
    const sock = new GridSocket(scopeFor("b"), () => {});
    sock.connect("sess-b");
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(4003);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(MockWS.instances.length).toBe(1);
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
    sock.close();
  });
});

describe("overlay close codes (no 4001/4003/4008 of its own)", () => {
  const open = () =>
    connectOverlayEvents({
      scope: scopeFor("b"),
      conversationId: "c1",
      onItem: () => {},
      onNeedCatchUp: () => {},
    });

  it("one 1005 reconnects with no whoami; 1 s → 15 s backoff", async () => {
    const h = open();
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(1005);
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWS.instances).toHaveLength(2);
    expect(whoamiCalls()).toHaveLength(0);
    h.stop();
  });

  it("4001 / 4003 / 4008 on the overlay are just drops: reconnect, no whoami", async () => {
    const h = open();
    for (const code of [4001, 4003, 4008]) {
      const ws = MockWS.instances[MockWS.instances.length - 1];
      ws.openNow();
      ws.drop(code);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(MockWS.instances).toHaveLength(4);
    expect(whoamiCalls()).toHaveLength(0);
    h.stop();
  });

  it("a second 1005 within 5 s asks whoami on B once; a live token reconnects", async () => {
    const h = open();
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(1005);
    await vi.advanceTimersByTimeAsync(1000);
    MockWS.instances[1].openNow();
    MockWS.instances[1].drop(1005);
    await vi.advanceTimersByTimeAsync(0);
    expect(whoamiCalls().map(([u]) => String(u))).toEqual([`${B_HOST}/cli/auth/whoami`]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWS.instances).toHaveLength(3);
    h.stop();
  });

  it("a 1005 pair with a dead login stops the socket, keeps the token, tells the room", async () => {
    fetchMock.mockResolvedValue(gate());
    const h = open();
    MockWS.instances[0].openNow();
    MockWS.instances[0].drop(1005);
    await vi.advanceTimersByTimeAsync(1000);
    MockWS.instances[1].openNow();
    MockWS.instances[1].drop(1005);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(MockWS.instances).toHaveLength(2);
    expect(signals).toContainEqual(["b", "signin"]);
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
    h.stop();
  });
});
