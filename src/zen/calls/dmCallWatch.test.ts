import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn(async () => ({ unregister() {} })) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../api/scope", async (orig) => ({
  ...(await orig<typeof import("../../api/scope")>()),
  scopeFor: (id: string) => ({ id, label: id }),
}));
const gate = vi.hoisted(() => ({
  offered: new Set<string>(),
  listeners: new Set<(id: string, g: { offered: boolean }) => void>(),
}));
vi.mock("../../api/homeChat", async (orig) => ({
  ...(await orig<typeof import("../../api/homeChat")>()),
  refreshHomeChatGate: vi.fn(async (scope: { id: string }) => ({ offered: gate.offered.has(scope.id) })),
  onHomeChatGate: (fn: (id: string, g: { offered: boolean }) => void) => {
    gate.listeners.add(fn);
    return () => gate.listeners.delete(fn);
  },
}));
const sock = vi.hoisted(() => ({ open: new Map<string, (f: unknown) => void>(), closed: [] as string[] }));
vi.mock("../../api/homeChatEvents", async (orig) => ({
  ...(await orig<typeof import("../../api/homeChatEvents")>()),
  subscribeHomeChat: (scope: { id: string }, onFrame: (f: unknown) => void) => {
    sock.open.set(scope.id, onFrame);
    return () => {
      sock.open.delete(scope.id);
      sock.closed.push(scope.id);
    };
  },
}));

import { useServersStore, type ServerEntry } from "../../stores/servers";
import { parseRing } from "../../api/homeChatCallsPure";
import { __resetDmCallsForTests, useDmCalls } from "./dmCall";
import { startDmCallWatch } from "./dmCallWatch";

const server = (id: string) => ({ id, nickname: id, url: `https://${id}.k2.dev` }) as unknown as ServerEntry;
const flush = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | null = null;

beforeEach(() => {
  gate.offered.clear();
  gate.listeners.clear();
  sock.open.clear();
  sock.closed.length = 0;
  __resetDmCallsForTests();
  useServersStore.setState({ servers: [server("a"), server("b"), server("c")], tokens: { a: "t", b: "t" } });
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("startDmCallWatch", () => {
  it("opens one Home chat socket per signed-in server that offers it, and hears its rings", async () => {
    gate.offered.add("a");
    stop = startDmCallWatch();
    await flush();
    expect([...sock.open.keys()]).toEqual(["a"]);
    sock.open.get("a")!({
      type: "call_ring",
      conv: "900",
      ring: parseRing({ call_id: "7", channel_id: "900", started_by: null, ringing: true, silent: true }),
    });
    expect(useDmCalls.getState().rings).toMatchObject([{ serverId: "a", callId: "7", silent: true }]);
  });

  it("joins a server once its gate opens, and lets go of one signed out", async () => {
    gate.offered.add("a");
    stop = startDmCallWatch();
    await flush();
    for (const fn of gate.listeners) fn("b", { offered: true });
    expect([...sock.open.keys()].sort()).toEqual(["a", "b"]);
    // c has no login here: never joined.
    for (const fn of gate.listeners) fn("c", { offered: true });
    expect(sock.open.has("c")).toBe(false);
    useServersStore.setState({ tokens: { b: "t" } });
    await flush();
    expect(sock.closed).toEqual(["a"]);
    stop();
    stop = null;
    expect(sock.open.size).toBe(0);
  });
});
