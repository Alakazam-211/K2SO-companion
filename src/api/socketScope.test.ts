// MA5 / MS6: every socket is constructed with a scope and never reads the
// active server. Switch the active server while a grid socket, an overlay
// socket and an app-events hub are open on server B, drop each one, and
// assert every redial (and the grid's revive probe) goes to B with B's
// token — never to A, never with B's session id on A.

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
import { __resetReviveForTests } from "../lib/revive";
import { useServersStore } from "../stores/servers";
import { connectOverlayEvents } from "../zen/overlayEvents";
import { connectProjectEvents } from "../zen/ticketEvents";

class MockWS {
  static instances: MockWS[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
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
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const A_HOST = "https://a.k2.dev";
const B_HOST = "https://b.k2.dev";

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  vi.useFakeTimers();
  fetchMock.mockReset();
  // The grid's revive probe: B's whoami answers "alive".
  fetchMock.mockResolvedValue({ status: 200, ok: true, text: async () => "{}" });
  __resetScopesForTests();
  __resetReviveForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "a", nickname: "A", url: A_HOST, username: "ua", rememberPassword: false },
      { id: "b", nickname: "B", url: B_HOST, username: "ub", rememberPassword: false },
    ],
    activeServerId: "b",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a switch while sockets are open never redials another server (MA5)", () => {
  it("grid socket: redial + revive probe stay on B with B's session id", async () => {
    const sock = new GridSocket(scopeFor("b"), () => {});
    sock.connect("sess-b");
    const first = MockWS.instances[0];
    expect(first.url.startsWith("wss://b.k2.dev/cli/sessions/grid?session=sess-b&token=tok-b")).toBe(true);
    first.openNow();

    useServersStore.getState().setActive("a");
    first.drop();
    await vi.advanceTimersByTimeAsync(600);
    await flush();

    const redial = MockWS.instances[MockWS.instances.length - 1];
    expect(MockWS.instances.length).toBeGreaterThan(1);
    expect(redial.url.startsWith("wss://b.k2.dev/")).toBe(true);
    expect(redial.url).toContain("session=sess-b");
    expect(redial.url).toContain("token=tok-b");
    for (const ws of MockWS.instances) expect(ws.url).not.toContain("a.k2.dev");
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith(B_HOST)).toBe(true);
    sock.close();
  });

  it("overlay events: a reopen after a switch dials B with B's fresh token", async () => {
    const h = connectOverlayEvents({
      scope: scopeFor("b"),
      conversationId: "conv-1",
      onItem: () => {},
      onNeedCatchUp: () => {},
    });
    const first = MockWS.instances[0];
    expect(first.url.startsWith("wss://b.k2.dev/")).toBe(true);
    first.openNow();
    useServersStore.getState().setActive("a");
    useServersStore.getState().setToken("b", "tok-b-2");
    first.drop();
    await vi.advanceTimersByTimeAsync(1500);
    const redial = MockWS.instances[1];
    expect(redial.url.startsWith("wss://b.k2.dev/")).toBe(true);
    expect(redial.url).toContain("tok-b-2");
    expect(redial.url).not.toContain("tok-a");
    h.stop();
  });

  it("app-events hub: a reopen after a switch dials B, not A", async () => {
    const h = connectProjectEvents(scopeFor("b"), () => {});
    const first = MockWS.instances[0];
    first.openNow();
    useServersStore.getState().setActive("a");
    first.drop();
    await vi.advanceTimersByTimeAsync(1500);
    const redial = MockWS.instances[1];
    expect(redial.url).toBe("wss://b.k2.dev/cli/sessions/events?path=&token=tok-b");
    h.stop();
  });

  it("a removed server stops its sockets instead of dialling anywhere", async () => {
    const h = connectProjectEvents(scopeFor("b"), () => {});
    MockWS.instances[0].openNow();
    useServersStore.getState().removeServer("b");
    MockWS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWS.instances).toHaveLength(1);
    h.stop();
  });
});
