// @vitest-environment jsdom
// MS28: background / foreground with a room open on B (flag on).
//   - background closes every room socket (events hub, overlay, grid);
//   - foreground re-checks B's /boot-status (B only), compares instanceId,
//     re-pulls the snapshot + Thread, and the sockets reopen on B through
//     the dial queue; a changed instanceId resyncs that room (rows reload,
//     keep-alive dedupe cleared);
//   - flag off: the background closes nothing (today's behaviour).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ calls: [] as string[], instanceId: "i1" }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string) => {
    net.calls.push(url);
    const u = new URL(url);
    const body = (v: unknown) => ({ status: 200, ok: true, json: async () => v, text: async () => JSON.stringify(v) });
    switch (u.pathname) {
      case "/boot-status":
        return body({ version: "0.45.5", phase: "ready", instanceId: net.instanceId, features: ["daemon-activity"] });
      case "/cli/agent/list":
        return body({ ok: true, agents: [{ name: "docs", path: "/srv/docs", live: true }] });
      case "/cli/projects/list":
        return body([{ id: "pd", name: "Docs", handle: "docs", path: "/srv/docs", pinned: 0, tab_order: 0 }]);
      case "/cli/project-group/list":
        return body({ ok: true, groups: [] });
      case "/cli/companion/sessions":
        return body([]);
      case "/cli/thread":
        return body({ items: [{ seq: 1, from: "docs", text: "hi", at: 1 }], conversation_id: "cb" });
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

import { __resetScopesForTests, refreshBootStatus, scopeFor } from "../../api/scope";
import { __resetDialQueueForTests } from "../../api/dialQueue";
import { GridSocket } from "../../api/gridSocket";
import { __resetLifecycleForTests, setLifecycleEnabled } from "../../lib/appLifecycle";
import { useServersStore } from "../../stores/servers";
import { connectOverlayEvents } from "../overlayEvents";
import { connectProjectEvents, hubState } from "../ticketEvents";
import { useZenStore } from "../zenStore";
import { roomForeground } from "./useRoomLife";
import { __resetKeepAliveForTests, keepRoomAlive } from "./keepAlive";

class MockWS {
  static all: MockWS[] = [];
  readyState = 0;
  closed = false;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.all.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  openNow() {
    this.readyState = 1;
    this.onopen?.();
  }
}

let visibility: "visible" | "hidden" = "visible";
function setVisibility(v: "visible" | "hidden") {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

const A = { id: "a", nickname: "Alpha", url: "https://alpha.k2.dev", username: "u", rememberPassword: false };
const B = { id: "b", nickname: "Bravo", url: "https://bravo.k2.dev", username: "u", rememberPassword: false };

beforeEach(async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  visibility = "visible";
  net.calls = [];
  net.instanceId = "i1";
  MockWS.all = [];
  vi.stubGlobal("WebSocket", MockWS);
  __resetScopesForTests();
  __resetDialQueueForTests();
  __resetLifecycleForTests();
  __resetKeepAliveForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [A, B],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: {},
  });
  useZenStore.setState({ agents: [], agentSource: "live", screen: "list", agentId: "" });
  await useZenStore.getState().openRoom("b", { id: "/srv/docs" });
  await refreshBootStatus(scopeFor("b"));
  net.calls = [];
});

afterEach(() => {
  useZenStore.getState().closeChat();
  __resetLifecycleForTests();
  vi.unstubAllGlobals();
});

function openRoomSockets() {
  const hub = connectProjectEvents(scopeFor("b"), () => {});
  const overlay = connectOverlayEvents({
    scope: scopeFor("b"),
    conversationId: "cb",
    onItem: () => {},
    onNeedCatchUp: () => {},
  });
  const grid = new GridSocket(scopeFor("b"), () => {});
  grid.connect("t-b");
  for (const ws of MockWS.all) ws.openNow();
  return { stop: () => (hub.stop(), overlay.stop(), grid.close()) };
}

describe("MS28 background / foreground (flag on)", () => {
  it("background closes every room socket; foreground reopens them on B through the queue", async () => {
    setLifecycleEnabled(true);
    const s = openRoomSockets();
    expect(MockWS.all).toHaveLength(3);
    setVisibility("hidden");
    expect(MockWS.all.map((w) => [w.url.split("?")[0], w.closed])).toEqual(MockWS.all.map((w) => [w.url.split("?")[0], true]));
    expect(hubState("b")).toBe("paused");
    await new Promise((r) => setTimeout(r, 20));
    expect(MockWS.all).toHaveLength(3); // nothing redials in the background
    setVisibility("visible");
    await new Promise((r) => setTimeout(r, 20));
    const reopened = MockWS.all.slice(3);
    expect(reopened.length).toBe(3);
    for (const w of reopened) expect(w.url).toContain("bravo.k2.dev");
    s.stop();
  });

  it("foreground: boot-status on B only; same instance re-pulls the Thread + snapshot", async () => {
    expect(await roomForeground(scopeFor("b"))).toBe("same");
    await new Promise((r) => setTimeout(r, 0));
    expect(net.calls.every((c) => c.includes("bravo.k2.dev"))).toBe(true);
    const paths = net.calls.map((c) => new URL(c).pathname);
    expect(paths).toContain("/boot-status");
    expect(paths).toContain("/cli/thread");
    expect(paths).toContain("/cli/activity/snapshot");
    expect(paths).not.toContain("/cli/agent/list");
  });

  it("foreground after a restart (new instanceId) resyncs that room and clears its keep-alive dedupe", async () => {
    expect(await keepRoomAlive(scopeFor("b"), "pd")).toBe("sent");
    expect(await keepRoomAlive(scopeFor("b"), "pd")).toBe("deduped");
    net.instanceId = "i2";
    expect(await roomForeground(scopeFor("b"))).toBe("restarted");
    const paths = net.calls.map((c) => new URL(c).pathname);
    expect(paths).toContain("/cli/agent/list");
    expect(net.calls.every((c) => c.includes("bravo.k2.dev"))).toBe(true);
    expect(useServersStore.getState().activeServerId).toBe("a");
    expect(await keepRoomAlive(scopeFor("b"), "pd")).toBe("sent");
  });
});

describe("flag off parity", () => {
  it("the background closes nothing", () => {
    setLifecycleEnabled(false);
    const s = openRoomSockets();
    setVisibility("hidden");
    expect(MockWS.all.some((w) => w.closed)).toBe(false);
    expect(hubState("b")).toBe("open");
    s.stop();
  });
});
