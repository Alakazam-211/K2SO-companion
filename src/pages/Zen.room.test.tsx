// @vitest-environment jsdom
// Multi-server S3 on the Zen page:
//   - `/zen?addr=&seq=&server=` (a push tap, terminal Done) opens a ROOM on
//     that server; the active server never changes (MS21, MA17, MA23);
//   - MS36: a room whose server is in trouble shows ONE banner above the
//     composer, input off, one action scoped to that server;
//   - MS37: the chat header shows the room's server chip;
//   - a `server=` that names no saved server is dropped (never opened on A);
//   - flag-off parity: `server=` is ignored and nothing room-like runs
//     (no keep-alive, no pool checks), exactly as before S3.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const net = vi.hoisted(() => ({
  calls: [] as string[],
  boot: { version: "0.45.5", phase: "ready", instanceId: "ib", features: ["daemon-activity"] } as unknown,
  whoami: 200,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init?: { method?: string }) => {
    net.calls.push(`${init?.method || "GET"} ${url}`);
    const u = new URL(url);
    const body = (v: unknown, status = 200) => ({
      status,
      ok: status < 300,
      json: async () => v,
      text: async () => JSON.stringify(v),
    });
    const host = u.host;
    switch (u.pathname) {
      case "/boot-status":
        return body(net.boot);
      case "/cli/auth/whoami":
        return net.whoami === 200
          ? body({ username: "u", role: "member" })
          : body({ error: "Invalid or missing auth token" }, net.whoami);
      case "/cli/presence/summary":
        return body({ workspaces: [], agentActivity: [] });
      case "/cli/agent/list":
        return body({
          ok: true,
          agents: [{ name: host.startsWith("bravo") ? "docs" : "alpha", path: host.startsWith("bravo") ? "/srv/docs" : "/a", live: true }],
        });
      case "/cli/projects/list":
        return body(
          host.startsWith("bravo")
            ? [{ id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 0 }]
            : [{ id: "pa", name: "Alpha", handle: "alpha", path: "/a", pinned: 0, tab_order: 0 }]
        );
      case "/cli/project-group/list":
        return body({ ok: true, groups: [] });
      case "/cli/companion/sessions":
        return body([]);
      case "/cli/thread":
        return body({ items: [{ seq: 1, from: "docs", text: `hello from ${host}`, at: 1 }], conversation_id: "cb" });
      case "/cli/activity/snapshot":
        return body({ rows: [], workspaces: [] });
      case "/cli/workspace/resources":
        return body({ resources: [] });
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

import { __resetScopesForTests } from "../api/scope";
import { __resetDialQueueForTests } from "../api/dialQueue";
import { useServersStore } from "../stores/servers";
import { useZenStore } from "../zen/zenStore";
import { roomServerId } from "../zen/zenScope";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { pool } from "../zen/multi/pool";
import { __resetKeepAliveForTests } from "../zen/room/keepAlive";
import { Zen } from "./Zen";

class MockWS {
  static urls: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.urls.push(url);
  }
  send() {}
  close() {}
}

const A = { id: "a", nickname: "Alpha", url: "https://alpha.k2.dev", username: "u", rememberPassword: false };
const B = { id: "b", nickname: "Bravo", url: "https://bravo.k2.dev", username: "u", rememberPassword: false };

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/zen" element={<Zen />} />
      </Routes>
    </MemoryRouter>
  );
}

const callsTo = (host: string) => net.calls.filter((c) => c.includes(host));

beforeEach(() => {
  net.calls = [];
  net.boot = { version: "0.45.5", phase: "ready", instanceId: "ib", features: ["daemon-activity"] };
  net.whoami = 200;
  MockWS.urls = [];
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  sessionStorage.clear();
  __resetScopesForTests();
  __resetDialQueueForTests();
  __resetKeepAliveForTests();
  pool.forget("a");
  pool.forget("b");
  useMultiServerPrefs.setState({ multiServer: true, serverFilter: "all" });
  useServersStore.setState({
    hydrated: true,
    servers: [A, B],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: { a: "connected", b: "connected" },
  });
  useZenStore.setState({ agents: [], agentId: "", screen: "list", drawerOrigin: null, threadFocusSeq: null });
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  vi.unstubAllGlobals();
});

describe("Zen rooms (flag on)", () => {
  it("?addr=&server= opens a room on B: B's thread, B's chip, the active server stays A", async () => {
    renderAt("/zen?addr=docs&seq=1&server=bravo.k2.dev");
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    expect(roomServerId()).toBe("b");
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello from bravo.k2.dev"]);
    expect(screen.getByTestId("chat-header-server").textContent).toBe("Bravo");
    // MS24: the room told B someone is using `docs` (pd), once.
    await waitFor(() =>
      expect(callsTo("bravo.k2.dev/cli/projects/activate")).toHaveLength(1)
    );
    // Nothing for this room went to A.
    // Nothing for this ROOM went to A (the list underneath and Tickets stay
    // on the default server, A, by design).
    const ROOM_ROUTES = ["/cli/thread", "/cli/agent/list", "/cli/companion/sessions", "/cli/activity", "/cli/workspace", "/cli/projects/activate"];
    expect(
      callsTo("alpha.k2.dev").filter((c) => ROOM_ROUTES.some((r) => c.includes(r)))
    ).toEqual([]);
    // Room sockets dial B. The app-events hub on A is the default server's
    // (Tickets, NG6) — one per server (MS25).
    const roomSockets = MockWS.urls.filter((u) => !u.includes("/cli/sessions/events"));
    for (const u of roomSockets) expect(u).toContain("bravo.k2.dev");
    expect(MockWS.urls.filter((u) => u.includes("alpha.k2.dev/cli/sessions/events")).length).toBeLessThanOrEqual(1);
  });

  it("MS36: a room on a server whose login is gone shows one banner; input off; Sign in targets B only", async () => {
    renderAt("/zen?addr=docs&server=bravo.k2.dev");
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    await waitFor(() => expect(pool.entry("b")?.auth).toBe("ok"));
    act(() => pool.noteKicked("b"));
    const banner = await screen.findByTestId("room-banner");
    expect(banner.getAttribute("data-state")).toBe("kicked");
    expect(screen.getByTestId("room-banner-copy").textContent).toBe("Removed from Bravo");
    expect(screen.getAllByTestId("room-banner")).toHaveLength(1);
    // Input is off; the last messages stay.
    expect(screen.getByTestId("composer-input").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("composer-send")).toBeNull();
    expect(useZenStore.getState().thread).toHaveLength(1);
    // The one action: sign in to B, without switching or deleting anything.
    fireEvent.click(screen.getByTestId("room-banner-action"));
    expect(await screen.findByTestId("room-sign-in")).toBeTruthy();
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
  });

  it("MS36: an offline room server says so with Retry now, which re-checks B only", async () => {
    renderAt("/zen?addr=docs&server=bravo.k2.dev");
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    net.boot = null as unknown;
    await act(async () => {
      await pool.check("b");
    });
    const banner = await screen.findByTestId("room-banner");
    expect(banner.getAttribute("data-state")).toBe("offline");
    expect(screen.getByTestId("room-banner-copy").textContent).toMatch(/^Offline/);
    net.calls = [];
    fireEvent.click(screen.getByTestId("room-banner-action"));
    await waitFor(() => expect(net.calls.length).toBeGreaterThan(0));
    expect(net.calls.every((c) => c.includes("bravo.k2.dev"))).toBe(true);
  });

  it("a server= that names no saved server is dropped, never opened on A", async () => {
    renderAt("/zen?addr=docs&server=gone.k2.dev");
    await waitFor(() => expect(useZenStore.getState().agentSource).toBe("live"));
    expect(roomServerId()).toBeNull();
    expect(useZenStore.getState().screen).toBe("list");
    expect(callsTo("/cli/thread?addr=docs")).toEqual([]);
    expect(callsTo("bravo.k2.dev/cli/thread")).toEqual([]);
  });

  it("an old link without server= means the active server, and leaves a room", async () => {
    await act(async () => {
      await useZenStore.getState().openRoom("b", { id: "/srv/docs" });
    });
    expect(roomServerId()).toBe("b");
    renderAt("/zen?addr=alpha");
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    expect(roomServerId()).toBeNull();
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello from alpha.k2.dev"]);
  });
});

describe("flag-off parity", () => {
  it("server= is ignored; no room, no keep-alive, no pool checks, no chip", async () => {
    useMultiServerPrefs.setState({ multiServer: false });
    useServersStore.setState({ servers: [A] , tokens: { a: "tok-a" } });
    renderAt("/zen?addr=alpha&server=bravo.k2.dev");
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    expect(roomServerId()).toBeNull();
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hello from alpha.k2.dev"]);
    expect(net.calls.some((c) => c.includes("/cli/projects/activate"))).toBe(false);
    expect(net.calls.some((c) => c.includes("/cli/presence/summary"))).toBe(false);
    expect(net.calls.some((c) => c.includes("bravo.k2.dev"))).toBe(false);
    expect(screen.queryByTestId("chat-header-server")).toBeNull();
    expect(screen.queryByTestId("room-banner")).toBeNull();
  });
});
