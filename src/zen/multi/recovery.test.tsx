// @vitest-environment jsdom
// Auto reconnect: a server that went away and came back reconnects on its
// own — the same reconnect a tap in the Servers sheet runs — for the ACTIVE
// server too, from the list or from an open chat:
//   - the active server recovers after down → up with no tap;
//   - a room's server recovers while its chat is open;
//   - a down server is checked at 5 s / 15 s / 30 s from anywhere, never in
//     the background; foreground / online check at once;
//   - tapping an agent on an offline server opens its chat with
//     "Reconnecting to {server}…", then "{server} is offline … Retry now"
//     after 10 s, and recovers;
//   - an expired login says "Sign in again", not "offline";
//   - reconnects are single-flight per server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const net = vi.hoisted(() => ({
  down: new Set<string>(),
  /** host → whoami status (default 200). */
  whoami: {} as Record<string, number>,
  calls: [] as { host: string; path: string; method: string }[],
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init?: { method?: string }) => {
    const u = new URL(url);
    const host = u.host;
    net.calls.push({ host, path: u.pathname, method: init?.method || "GET" });
    // Not a "connection-level" message, so /boot-status is read once per check.
    if (net.down.has(host)) throw new Error("host is down");
    const body = (v: unknown, status = 200) => ({
      status,
      ok: status < 300,
      json: async () => v,
      text: async () => JSON.stringify(v),
    });
    const bravo = host.startsWith("bravo");
    switch (u.pathname) {
      case "/boot-status":
        return body({ version: "0.45.5", phase: "ready", instanceId: `i-${host}`, features: ["daemon-activity"] });
      case "/cli/auth/whoami": {
        const st = net.whoami[host] ?? 200;
        return st === 200
          ? body({ username: "u", role: "member" })
          : body({ error: "Invalid or missing auth token" }, st);
      }
      case "/cli/presence/summary":
        return body({ workspaces: [], agentActivity: [] });
      case "/cli/agent/list":
        return body({
          ok: true,
          agents: [{ name: bravo ? "docs" : "alpha", path: bravo ? "/srv/docs" : "/a", live: true }],
        });
      case "/cli/projects/list":
        return body(
          bravo
            ? [{ id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 0 }]
            : [{ id: "pa", name: "Alpha", handle: "alpha", path: "/a", pinned: 0, tab_order: 0 }]
        );
      case "/cli/project-group/list":
        return body({ ok: true, groups: [] });
      case "/cli/companion/sessions":
        return body([]);
      case "/cli/thread":
        return body({ items: [{ seq: 1, from: "docs", text: `hello from ${host}`, at: 1 }], conversation_id: "c" });
      case "/cli/activity/snapshot":
        return body({ rows: [], workspaces: [] });
      default:
        return body({});
    }
  }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import { __resetScopesForTests } from "../../api/scope";
import { __resetDialQueueForTests } from "../../api/dialQueue";
import { onServerSignal } from "../../api/serverSignals";
import { __resetHttpCapForTests } from "../../api/httpCap";
import { __resetReviveForTests, __setDeadRecheckMsForTests } from "../../lib/revive";
import { useServersStore } from "../../stores/servers";
import { useZenStore } from "../zenStore";
import { FOCUS_OFF } from "../serverPins";
import { openHomeRowOnServer } from "../HomeList";
import { useRoomLife } from "../room/useRoomLife";
import { RoomBanner } from "../room/RoomBanner";
import { __resetKeepAliveForTests } from "../room/keepAlive";
import { pool } from "./pool";
import { useMultiServerPrefs } from "./prefs";
import { useMultiServerList } from "./useMultiServerList";
import { __resetHealthForTests, healthStore } from "./serverHealth";
import { __resetRecoveryForTests, reconnectServer } from "./recovery";
import { __resetRemoteRowsForTests } from "./remoteRows";
import { setChatCacheForTests } from "../chatCache";

class MockWS {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send() {}
  close() {}
}

const A = { id: "a", nickname: "Alpha", url: "https://alpha.k2.dev", username: "u", rememberPassword: false };
const B = { id: "b", nickname: "Bravo", url: "https://bravo.k2.dev", username: "u", rememberPassword: false };
const ALPHA = "alpha.k2.dev";
const BRAVO = "bravo.k2.dev";

/** What ChatsList (the pool loop, always mounted under Zen) and the Zen page
 *  (the room's banner) wire up, without their UI. */
function Harness() {
  const zenScreen = useZenStore((s) => s.screen);
  const source = useZenStore((s) => s.agentSource);
  const agentId = useZenStore((s) => s.agentId);
  const agent = useZenStore((s) => s.agents.find((a) => a.id === agentId));
  useMultiServerList({
    q: "",
    listOnScreen: zenScreen === "list",
    active: { source, agents: [], serverProjects: [], pinnedIds: [], focus: FOCUS_OFF, hiddenAddrs: [] },
  });
  const room = useRoomLife({ open: zenScreen === "thread", agent });
  return room.failure ? <RoomBanner failure={room.failure} onAction={room.act} /> : null;
}

let visibility: DocumentVisibilityState = "visible";
const run = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const bootCalls = (host: string) => net.calls.filter((c) => c.host === host && c.path === "/boot-status").length;
const banner = () => screen.queryByTestId("room-banner");

beforeEach(() => {
  setChatCacheForTests(null);
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  net.down = new Set();
  net.whoami = {};
  net.calls = [];
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  __resetScopesForTests();
  __resetDialQueueForTests();
  __resetHttpCapForTests();
  __resetReviveForTests();
  __setDeadRecheckMsForTests(0);
  __resetKeepAliveForTests();
  __resetHealthForTests();
  __resetRecoveryForTests();
  __resetRemoteRowsForTests();
  pool.forget("a");
  pool.forget("b");
  useMultiServerPrefs.setState({ multiServer: true });
  useServersStore.setState({
    hydrated: true,
    servers: [A, B],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: { a: "connected", b: "connected" },
  });
  useZenStore.setState({
    agents: [],
    agentSource: "loading",
    agentError: null,
    agentId: "",
    screen: "list",
    drawerOrigin: null,
    thread: [],
    threadSource: "loading",
    threadError: null,
    threadAddr: null,
    outbox: [],
  });
});

afterEach(async () => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  __setDeadRecheckMsForTests(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the active server recovers on its own", () => {
  it("down → up: no tap; its list is read again and the down state clears", async () => {
    net.down.add(ALPHA);
    render(<Harness />);
    await run();
    await act(async () => {
      await useZenStore.getState().hydrateAgents();
    });
    await run();
    expect(useZenStore.getState().agentSource).toBe("error");
    expect(pool.entry("a")?.reach).toBe("offline");
    expect(healthStore.getState().downSince.a).toBeDefined();

    // Still down at the 5 s check.
    await run(5_000);
    expect(useZenStore.getState().agentSource).toBe("error");

    // Back: the next check (15 s later) sees it and reconnects it.
    net.down.delete(ALPHA);
    net.calls = [];
    await run(15_000);
    expect(useZenStore.getState().agentSource).toBe("live");
    expect(useZenStore.getState().agents.map((a) => a.name)).toEqual(["alpha"]);
    expect(healthStore.getState().downSince.a).toBeUndefined();
    expect(useServersStore.getState().recovery.a).toBe("connected");
    // The reconnect revived the login (whoami) before re-reading the list,
    // and the active server stayed the active one.
    const paths = net.calls.filter((c) => c.host === ALPHA).map((c) => c.path);
    expect(paths.indexOf("/cli/auth/whoami")).toBeGreaterThan(paths.indexOf("/boot-status"));
    expect(paths.indexOf("/cli/agent/list")).toBeGreaterThan(paths.indexOf("/cli/auth/whoami"));
    expect(useServersStore.getState().activeServerId).toBe("a");
  });

  it("a chat open on the active server: its failed Thread re-reads when the server is back", async () => {
    render(<Harness />);
    await act(async () => {
      await useZenStore.getState().hydrateAgents();
    });
    await run();
    const id = useZenStore.getState().agents[0].id;
    act(() => useZenStore.getState().setAgent(id));
    await run();
    expect(useZenStore.getState().threadSource).toBe("live");

    // The server goes away; the next Thread read fails.
    net.down.add(ALPHA);
    act(() => useZenStore.getState().setAgent(id));
    await run();
    expect(healthStore.getState().downSince.a).toBeDefined();
    // The cached Thread stays on screen; the banner says it reconnects.
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello from alpha.k2.dev"]);
    expect(banner()?.getAttribute("data-state")).toBe("reconnecting");
    expect(screen.getByTestId("room-banner-copy").textContent).toBe("Reconnecting to Alpha…");

    net.down.delete(ALPHA);
    const recovered: string[] = [];
    const stop = onServerSignal((sid, sig) => sig === "recovered" && recovered.push(sid));
    await run(5_000);
    stop();
    expect(useZenStore.getState().threadSource).toBe("live");
    expect(healthStore.getState().downSince.a).toBeUndefined();
    expect(recovered).toEqual(["a"]);
    expect(banner()).toBeNull();
  });
});

describe("a room's server recovers while its chat is open", () => {
  it("B goes down and comes back: the pool keeps checking it off the list and reconnects it", async () => {
    render(<Harness />);
    await run();
    await act(async () => {
      await useZenStore.getState().openRoom("b", { id: "/srv/docs" });
    });
    await run();
    expect(useZenStore.getState().screen).toBe("thread");
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello from bravo.k2.dev"]);

    net.down.add(BRAVO);
    // The room's server is watched while the chat is open (list off screen).
    await run(30_000);
    expect(pool.entry("b")?.reach).toBe("offline");
    expect(banner()?.getAttribute("data-state")).toBe("reconnecting");

    net.down.delete(BRAVO);
    net.calls = [];
    await run(5_000);
    expect(pool.entry("b")?.reach).toBe("live");
    expect(healthStore.getState().downSince.b).toBeUndefined();
    expect(banner()).toBeNull();
    // The open Thread was re-read on B; nothing for the room went to A.
    expect(net.calls.some((c) => c.host === BRAVO && c.path === "/cli/thread")).toBe(true);
    expect(net.calls.filter((c) => c.host === ALPHA && c.path === "/cli/thread")).toEqual([]);
    expect(useServersStore.getState().activeServerId).toBe("a");
  });
});

describe("cadence: 5 s / 15 s / 30 s while down, from anywhere, never in the background", () => {
  it("a down server is retried 5 → 15 → 30 → 30 s with a Thread open; healthy ones wait for the list", async () => {
    net.down.add(BRAVO);
    render(<Harness />);
    await run();
    expect(pool.entry("b")?.reach).toBe("offline");
    // A chat opens on A: the list is off screen.
    await act(async () => {
      await useZenStore.getState().hydrateAgents();
    });
    act(() => useZenStore.getState().setAgent(useZenStore.getState().agents[0].id));
    await run();
    net.calls = [];
    const at: number[] = [];
    const t0 = Date.now();
    for (let s = 0; s < 80; s++) {
      const before = bootCalls(BRAVO);
      await run(1_000);
      if (bootCalls(BRAVO) > before) at.push(Math.round((Date.now() - t0) / 1000));
    }
    // 5 s, then +15 s, then +30 s each (the loop's 5 s was armed before t0).
    expect(at.slice(0, 3).map((x, i, a) => (i ? x - a[i - 1] : x))).toEqual([at[0], 15, 30]);
    expect(at[0]).toBeLessThanOrEqual(5);
    // The healthy active server is not polled while the Thread is open.
    expect(bootCalls(ALPHA)).toBe(0);
  });

  it("never checks in the background", async () => {
    net.down.add(BRAVO);
    render(<Harness />);
    await run();
    visibility = "hidden";
    net.calls = [];
    await run(120_000);
    expect(net.calls).toEqual([]);
  });

  it("coming back to the foreground or online checks at once", async () => {
    net.down.add(BRAVO);
    render(<Harness />);
    await run();
    await run(5_000); // second check armed 15 s out
    net.calls = [];
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await run();
    expect(bootCalls(BRAVO)).toBe(1);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    net.down.delete(BRAVO);
    net.calls = [];
    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await run();
    expect(bootCalls(BRAVO)).toBe(1);
    expect(pool.entry("b")?.reach).toBe("live");
    expect(healthStore.getState().downSince.b).toBeUndefined();
  });
});

describe("tapping an agent on an offline server", () => {
  it("opens the chat with the cached Thread and 'Reconnecting…', then 'offline · Retry now' after 10 s, and recovers", async () => {
    render(<Harness />);
    await run();
    // Seen once while B was up (rows + Thread cached), then back to the list.
    await act(async () => {
      await useZenStore.getState().openRoom("b", { id: "/srv/docs" });
    });
    await run();
    const seed = useZenStore.getState().agents;
    act(() => useZenStore.getState().closeChat());
    await run();

    net.down.add(BRAVO);
    await run(30_000); // the list's check sees B down
    expect(pool.entry("b")?.reach).toBe("offline");

    // The Home row tap.
    await act(async () => {
      void openHomeRowOnServer("b", "docs", { localId: "/srv/docs", seed });
    });
    await run();
    expect(useZenStore.getState().screen).toBe("thread");
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello from bravo.k2.dev"]);
    expect(banner()?.getAttribute("data-state")).toBe("reconnecting");
    expect(screen.getByTestId("room-banner-copy").textContent).toBe("Reconnecting to Bravo…");
    expect(screen.getByTestId("room-banner-spinner")).toBeTruthy();
    expect(screen.queryByTestId("room-banner-action")).toBeNull();

    await run(10_000);
    expect(banner()?.getAttribute("data-state")).toBe("offline");
    expect(screen.getByTestId("room-banner-copy").textContent).toBe("Bravo is offline. We'll keep trying");
    expect(screen.getByTestId("room-banner-action").textContent).toBe("Retry now");

    // B is back; Retry now checks at once and the chat recovers.
    net.down.delete(BRAVO);
    net.calls = [];
    fireEvent.click(screen.getByTestId("room-banner-action"));
    await run();
    expect(net.calls[0]).toMatchObject({ host: BRAVO, path: "/boot-status" });
    expect(banner()).toBeNull();
    expect(useZenStore.getState().threadSource).toBe("live");
    expect(net.calls.every((c) => c.host === BRAVO)).toBe(true);
  });
});

describe("expired login", () => {
  it("the server answers but the login is dead: 'Sign in again', not offline; the token stays", async () => {
    render(<Harness />);
    await act(async () => {
      await useZenStore.getState().hydrateAgents();
    });
    act(() => useZenStore.getState().setAgent(useZenStore.getState().agents[0].id));
    await run();
    net.down.add(ALPHA);
    act(() => useZenStore.getState().setAgent(useZenStore.getState().agentId));
    await run();
    expect(banner()?.getAttribute("data-state")).toBe("reconnecting");

    // It comes back after a restart that dropped this login.
    net.down.delete(ALPHA);
    net.whoami[ALPHA] = 401;
    await run(5_000);
    await run(1_000); // whoami said dead twice (MA22)
    expect(healthStore.getState().expired.a).toBe(true);
    expect(banner()?.getAttribute("data-state")).toBe("signin-required");
    expect(screen.getByTestId("room-banner-copy").textContent).toBe("Sign in again to Alpha");
    expect(screen.getByTestId("room-banner-action").textContent).toBe("Sign in again");
    // A background reconnect never deletes the token (MA22).
    expect(useServersStore.getState().tokens.a).toBe("tok-a");

    // A new sign-in clears it.
    act(() => useServersStore.getState().setToken("a", "tok-a2"));
    expect(healthStore.getState().expired.a).toBeUndefined();
  });
});

describe("single-flight", () => {
  it("concurrent reconnects of one server share one attempt", async () => {
    render(<Harness />);
    await run();
    net.calls = [];
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    await act(async () => {
      p1 = reconnectServer("b");
      p2 = reconnectServer("b", { force: true });
      expect(p2).toBe(p1);
      await vi.advanceTimersByTimeAsync(0);
    });
    await expect(p1).resolves.toBe("connected");
    expect(net.calls.filter((c) => c.host === BRAVO && c.path === "/cli/auth/whoami")).toHaveLength(1);
    // Other servers are untouched.
    expect(net.calls.filter((c) => c.host === ALPHA && c.path === "/cli/auth/whoami")).toHaveLength(0);
  });
});
