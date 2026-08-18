import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GRID_STALL_NO_FRAME_MS, GRID_STALL_POLL_MS } from "../kessel/softResync";

vi.mock("./client", () => ({
  getBaseUrl: () => "http://127.0.0.1:8080",
  getToken: () => "tok",
}));

vi.mock("../stores/servers", () => ({
  useServersStore: { getState: () => ({ activeServerId: "s1" }) },
}));

vi.mock("../lib/revive", () => ({
  reviveServerSession: async () => "still-valid",
}));

class MockWS {
  static last: MockWS | null = null;
  static instances: MockWS[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: unknown[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.last = this;
    MockWS.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== MockWS.OPEN) {
      throw new Error("not open");
    }
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  openNow() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: { event: string; payload: unknown }) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function parsed(): unknown[] {
  return MockWS.last?.sent ?? [];
}

async function flushResync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("GridSocket soft-resync", () => {
  beforeEach(() => {
    MockWS.last = null;
    MockWS.instances = [];
    vi.stubGlobal("WebSocket", MockWS);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("visibilitychange visible + not OPEN → forceGridResync('foreground')", async () => {
    const vis = { state: "hidden" as DocumentVisibilityState };
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal("document", {
      get visibilityState() {
        return vis.state;
      },
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    });
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
    });

    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    const first = MockWS.last!;
    first.readyState = 3;
    vis.state = "visible";
    for (const fn of listeners.get("visibilitychange") ?? []) fn();
    await flushResync();
    expect(MockWS.instances.length).toBeGreaterThan(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=foreground"),
    );
    sock.close();
  });

  it("need-to-send on non-OPEN buffers input and flushes after reopen", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess", { drive: true });
    sock.setDrive(true);
    const first = MockWS.last!;
    first.readyState = 3;
    sock.sendInput("\x1b[<64;1;1M");
    await flushResync();
    const next = MockWS.last!;
    expect(next).not.toBe(first);
    next.openNow();
    const actions = parsed().map((f) => (f as { action?: string }).action);
    expect(actions[0]).toBe("set_mode");
    expect(parsed().some((f) => (f as { action?: string }).action === "input")).toBe(
      true,
    );
    sock.close();
  });

  it("acks on a dead socket do not buffer or resync", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    const first = MockWS.last!;
    first.openNow();
    first.readyState = 3;
    MockWS.instances.length = 1;
    sock.sendFrames([{ action: "ack", version: 12 }]);
    await flushResync();
    expect(MockWS.instances).toHaveLength(1);
    sock.close();
  });

  it("OPEN + no frame ≥ 20s while visible → grid-stall-no-frame once", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    const first = MockWS.last!;
    first.openNow();
    first.deliver({ event: "title", payload: { title: "t" } });
    expect(MockWS.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(GRID_STALL_NO_FRAME_MS + GRID_STALL_POLL_MS);
    await flushResync();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=grid-stall-no-frame"),
    );
    expect(MockWS.instances.length).toBeGreaterThan(1);

    const before = MockWS.instances.length;
    await vi.advanceTimersByTimeAsync(GRID_STALL_NO_FRAME_MS + GRID_STALL_POLL_MS);
    await flushResync();
    expect(MockWS.instances).toHaveLength(before);
    sock.close();
  });

  it("does not unmount by clearing outbound state on reconnect — last send is replayed", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess", { drive: true });
    sock.setDrive(true);
    const first = MockWS.last!;
    first.readyState = 3;
    sock.sendInput("\x1b[<65;2;3M");
    await flushResync();
    MockWS.last!.openNow();
    const inputs = parsed().filter(
      (f) => (f as { action?: string }).action === "input",
    );
    expect(inputs).toEqual([{ action: "input", text: "\x1b[<65;2;3M" }]);
    sock.close();
  });

  it("RPC companion WS module is not imported by the grid socket", async () => {
    const grid = await import("./gridSocket");
    const rpc = await import("./websocket");
    expect(grid.GridSocket).not.toBe(rpc.CompanionWebSocket);
    expect("CompanionWebSocket" in grid).toBe(false);
  });
});
