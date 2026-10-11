// @vitest-environment jsdom
// Multi-server S3 exit tests (MS21–MS23, MS7 no-fallback, MA17, MA18, MA23).
//
// A is the active server throughout. A room on B — its rows, thread, send,
// activity, Files, the Sessions drawer, the terminal page and a push tap —
// never changes the active server and never sends one request or socket to
// A. The transport is mocked; every module above it is real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const net = vi.hoisted(() => ({ calls: [] as string[] }));
const termScopes = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init?: { method?: string }) => {
    net.calls.push(`${init?.method || "GET"} ${url}`);
    const u = new URL(url);
    const body = (v: unknown) => ({
      status: 200,
      ok: true,
      json: async () => v,
      text: async () => JSON.stringify(v),
    });
    switch (u.pathname) {
      case "/boot-status":
        return body({ version: "0.45.5", phase: "ready", instanceId: "ib", features: ["daemon-activity"] });
      case "/cli/agent/list":
        return body({ ok: true, agents: [{ name: "docs", path: "/srv/docs", live: true }] });
      case "/cli/projects/list":
        return body([{ id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 0 }]);
      case "/cli/project-group/list":
        return body({ ok: true, groups: [] });
      case "/cli/companion/sessions":
        return body([
          { terminalId: "t-b", cwd: "/srv/docs", agentName: "docs", isMainChat: true, workspaceId: "pd", label: "docs" },
        ]);
      case "/cli/thread":
        return body({ items: [{ seq: 1, from: "docs", text: "hi from B", at: 1 }], conversation_id: "cb" });
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
vi.mock("../../components/TerminalView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/TerminalView")>();
  return {
    ...actual,
    TerminalView: (p: { scope: { id: string }; terminalId: string }) => {
      termScopes.ids.push(p.scope.id);
      return <div data-testid="terminal-view">{p.terminalId}</div>;
    },
  };
});

import { __resetScopesForTests } from "../../api/scope";
import { __resetDialQueueForTests } from "../../api/dialQueue";
import { useServersStore } from "../../stores/servers";
import { useZenStore } from "../zenStore";
import { roomServerId } from "../zenScope";
import { SessionsPane } from "../SessionsPane";
import { ZenTerminal } from "../../pages/ZenTerminal";
import { useMultiServerPrefs } from "../multi/prefs";
import { routeTap } from "../../lib/push";
import { resolveServerRef, serverRefFor, withServerParam } from "./serverRef";

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

/** Every request and socket so far went to B, none to A. */
function expectOnlyB() {
  expect(net.calls.length).toBeGreaterThan(0);
  for (const c of net.calls) expect(c).toContain("bravo.k2.dev");
  for (const u of MockWS.urls) expect(u).toContain("bravo.k2.dev");
  expect(net.calls.some((c) => c.includes("alpha.k2.dev"))).toBe(false);
}

beforeEach(() => {
  net.calls = [];
  MockWS.urls = [];
  termScopes.ids = [];
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  sessionStorage.clear();
  __resetScopesForTests();
  __resetDialQueueForTests();
  useMultiServerPrefs.setState({ multiServer: true, serverFilter: null });
  useServersStore.setState({
    hydrated: true,
    servers: [A, B],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: { a: "connected", b: "connected" },
  });
  useZenStore.setState({
    agentSource: "live",
    agents: [{ id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" }],
    screen: "list",
    agentId: "",
    activity: { rows: [], workspaces: [] } as never,
  });
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  vi.unstubAllGlobals();
});

async function openRoomOnB() {
  await act(async () => {
    await useZenStore.getState().openRoom("b", { id: "/srv/docs" });
  });
  await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
}

describe("rooms on any server (MS21–MS23)", () => {
  it("opening a row from B never changes the active server; the room reads B only", async () => {
    await openRoomOnB();
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(roomServerId()).toBe("b");
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["hi from B"]);
    // Files, activity, a send, a catch-up: all on B.
    await act(async () => {
      await useZenStore.getState().hydrateFiles("/srv/docs");
      await useZenStore.getState().refreshActivity();
      await useZenStore.getState().refreshOpenThread();
      await useZenStore.getState().sendThread("hello B");
    });
    expect(net.calls.some((c) => c.startsWith("POST https://bravo.k2.dev/cli/thread"))).toBe(true);
    expect(useServersStore.getState().activeServerId).toBe("a");
    expectOnlyB();
  });

  it("hot cap 1: a room elsewhere moves the room; Back restores A's list untouched", async () => {
    await openRoomOnB();
    act(() => useZenStore.getState().closeChat());
    expect(roomServerId()).toBeNull();
    expect(useZenStore.getState().agents.map((a) => a.id)).toEqual(["/a"]);
    expect(useServersStore.getState().activeServerId).toBe("a");
  });

  it("the Sessions drawer in a B room lists, and reads presets, on B", async () => {
    await openRoomOnB();
    net.calls = [];
    const agent = useZenStore.getState().agents.find((a) => a.id === "/srv/docs");
    render(
      <MemoryRouter>
        <SessionsPane agent={agent} onClose={() => {}} onOpenTerminal={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(net.calls.some((c) => c.includes("bravo.k2.dev/cli/companion/sessions"))).toBe(true)
    );
    await waitFor(() => expect(net.calls.some((c) => c.includes("/cli/companion/presets"))).toBe(true));
    // The drawer header names the room's server (MS37: two servers saved).
    expect(screen.getByTestId("sessions-server").textContent).toBe("Bravo");
    expectOnlyB();
  });

  it("the terminal page with ?server= runs its grid and sessions on B", async () => {
    net.calls = [];
    const path = withServerParam("/zen/terminal/t-b", "b");
    expect(path).toBe("/zen/terminal/t-b?server=bravo.k2.dev");
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/zen/terminal/:terminalId" element={<ZenTerminal />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(termScopes.ids).toContain("b"));
    expect(termScopes.ids.every((id) => id === "b")).toBe(true);
    await waitFor(() =>
      expect(net.calls.some((c) => c.includes("bravo.k2.dev/cli/companion/sessions"))).toBe(true)
    );
    expect(screen.getByTestId("zen-terminal-server").textContent).toBe("Bravo");
    expect(useServersStore.getState().activeServerId).toBe("a");
    expectOnlyB();
  });

  it("an old terminal link (no server=) means the active server (MA17)", async () => {
    render(
      <MemoryRouter initialEntries={["/zen/terminal/t-a"]}>
        <Routes>
          <Route path="/zen/terminal/:terminalId" element={<ZenTerminal />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(termScopes.ids).toContain("a"));
  });

  it("server refs: host key when unique, id otherwise; unknown refs resolve to nothing", () => {
    expect(serverRefFor("b")).toBe("bravo.k2.dev");
    expect(resolveServerRef("bravo.k2.dev")).toBe("b");
    expect(resolveServerRef("b")).toBe("b");
    expect(resolveServerRef("gone.k2.dev")).toBeNull();
    useServersStore.setState({ servers: [A, B, { ...B, id: "b2", username: "gina" }] });
    expect(serverRefFor("b2")).toBe("b2");
  });
});

describe("push taps (MA23): a room on the matched server, no switch", () => {
  const THREAD = { kind: "thread", subdomain: "bravo", addr: "docs", seq: "7" };

  it("flag on: navigates to the room on B; the active server stays A; nothing goes to A", async () => {
    const navigate = vi.fn();
    await routeTap(THREAD, navigate);
    expect(navigate).toHaveBeenCalledWith("/zen?addr=docs&seq=7&server=bravo.k2.dev");
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(net.calls.some((c) => c.includes("alpha.k2.dev"))).toBe(false);
  });
});
