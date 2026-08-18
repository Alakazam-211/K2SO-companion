import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  }
  send(data: string) {
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
}

function parsed(): unknown[] {
  return MockWS.last?.sent ?? [];
}

describe("GridSocket Drive / Watch wire", () => {
  beforeEach(() => {
    MockWS.last = null;
    vi.stubGlobal("WebSocket", MockWS);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Watch attach sends set_mode:viewer (never 80×24 / set_active)", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    MockWS.last!.openNow();
    expect(parsed()).toEqual([{ action: "set_mode", mode: "viewer" }]);
    expect(JSON.stringify(parsed())).not.toContain('"cols":80');
    sock.close();
  });

  it("Drive tap before OPEN flushes measured set_active on open", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    sock.setDrive(true);
    sock.noteClaim(42, 18);
    expect(parsed()).toEqual([]);
    MockWS.last!.openNow();
    expect(parsed()).toEqual([
      { action: "set_mode", mode: "claimer" },
      { action: "set_active", active: true, cols: 42, rows: 18 },
      { action: "resize", cols: 42, rows: 18 },
    ]);
    expect(JSON.stringify(parsed())).not.toContain('"cols":80');
    expect(JSON.stringify(parsed())).not.toContain('"rows":24');
    sock.close();
  });

  it("same-dims remasure after reconnect still sends set_active", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    sock.setDrive(true);
    sock.noteClaim(42, 18);
    MockWS.last!.openNow();
    const first = MockWS.last!;
    // Internal reopen (same drive + claimDims) — connect() would reset drive.
    first.close();
    sock.connect("sess", { drive: true });
    MockWS.last!.openNow();
    expect(parsed()).toEqual([
      { action: "set_mode", mode: "claimer" },
      { action: "set_active", active: true, cols: 42, rows: 18 },
      { action: "resize", cols: 42, rows: 18 },
    ]);
    sock.reassertClaim();
    expect(parsed().filter((f) => (f as { action?: string }).action === "set_active")).toHaveLength(
      2,
    );
    sock.close();
  });

  it("Watch Direct/accessory bytes flip claimer then input — no set_active", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    MockWS.last!.openNow();
    sock.sendPtyBytes("\x1b");
    expect(parsed()).toEqual([
      { action: "set_mode", mode: "viewer" },
      { action: "set_mode", mode: "claimer" },
      { action: "input", text: "\x1b" },
    ]);
    sock.sendPtyBytes("\x1b\r");
    expect(parsed().at(-1)).toEqual({ action: "input", text: "\x1b\r" });
    expect(JSON.stringify(parsed())).not.toContain("set_active");
    sock.close();
  });

  it("Drive sendPtyBytes is input only (already claimer)", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    sock.setDrive(true);
    sock.noteClaim(42, 18);
    MockWS.last!.openNow();
    const before = parsed().length;
    sock.sendPtyBytes("hi");
    expect(parsed().slice(before)).toEqual([{ action: "input", text: "hi" }]);
    sock.close();
  });

  it("Watch never invents 80×24 when a leftover fit exists", async () => {
    const { GridSocket } = await import("./gridSocket");
    const sock = new GridSocket(() => {});
    sock.connect("sess");
    sock.setDrive(true);
    sock.noteClaim(80, 24);
    sock.setDrive(false);
    MockWS.last!.openNow();
    expect(parsed()).toEqual([{ action: "set_mode", mode: "viewer" }]);
    expect(JSON.stringify(parsed())).not.toContain('"cols"');
    sock.close();
  });
});
