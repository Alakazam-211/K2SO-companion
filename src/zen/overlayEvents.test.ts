import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeScope } from "../test/fakeScope";

// MA21: the socket is opened on a scope.
const SCOPE = fakeScope({ id: "s1", base: "https://host.k2.dev", token: "tok" });

import { connectOverlayEvents, OVERLAY_POLL_MS, VIEWING_REPEAT_MS } from "./overlayEvents";
import { onHomesFrame } from "../api/homesSync";

class MockWS {
  static last: MockWS | null = null;
  static instances: MockWS[] = [];
  readyState = 0;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.last = this;
    MockWS.instances.push(this);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  openNow() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("connectOverlayEvents", () => {
  beforeEach(() => {
    MockWS.last = null;
    MockWS.instances = [];
    vi.stubGlobal("WebSocket", MockWS);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers a socket frame as a thread item", () => {
    const onItem = vi.fn();
    const onNeedCatchUp = vi.fn();
    const h = connectOverlayEvents({
      scope: SCOPE,
      conversationId: "conv-1",
      onItem,
      onNeedCatchUp,
    });
    expect(MockWS.last?.url).toContain("/cli/overlay/events?conversation=conv-1");
    MockWS.last?.openNow();
    expect(onNeedCatchUp).not.toHaveBeenCalled();
    MockWS.last?.deliver({
      id: "m1",
      seq: 1,
      doc: { from: "appa", body: "hi" },
    });
    expect(onItem).toHaveBeenCalledWith({
      id: "m1",
      seq: 1,
      doc: { from: "appa", body: "hi" },
    });
    h.stop();
  });

  it("Homes sync frames go to the sync engine, never into the Thread", () => {
    const onItem = vi.fn();
    const seen: string[] = [];
    const stopFrames = onHomesFrame((sid, f) => seen.push(`${sid}:${f.type}`));
    const h = connectOverlayEvents({ scope: SCOPE, conversationId: "conv-1", onItem, onNeedCatchUp: vi.fn() });
    MockWS.last?.openNow();
    MockWS.last?.deliver({ kind: "homes_changed" });
    MockWS.last?.deliver({ kind: "homes_device_removed", deviceId: "d1" });
    expect(seen).toEqual(["s1:changed", "s1:device_removed"]);
    expect(onItem).not.toHaveBeenCalled();
    stopFrames();
    h.stop();
  });

  it("polls after two handshake failures", () => {
    const onItem = vi.fn();
    const onNeedCatchUp = vi.fn();
    const h = connectOverlayEvents({
      scope: SCOPE,
      conversationId: "conv-1",
      onItem,
      onNeedCatchUp,
    });
    MockWS.last?.close();
    vi.advanceTimersByTime(2000);
    expect(MockWS.instances.length).toBe(2);
    MockWS.last?.close();
    expect(onNeedCatchUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OVERLAY_POLL_MS);
    expect(onNeedCatchUp).toHaveBeenCalled();
    h.stop();
  });

  describe("viewing frames", () => {
    const frames = (ws: MockWS) => ws.sent.map((f) => JSON.parse(f));
    const handle = () =>
      connectOverlayEvents({ scope: SCOPE, conversationId: "c1", onItem: vi.fn(), onNeedCatchUp: vi.fn() });

    it("true at once when the socket is open, then every 30 s; false on hide", () => {
      const h = handle();
      const ws = MockWS.last!;
      ws.openNow();
      h.setViewing(true);
      expect(frames(ws)).toEqual([{ t: "viewing", visible: true }]);
      vi.advanceTimersByTime(VIEWING_REPEAT_MS);
      expect(frames(ws)).toHaveLength(2);
      vi.advanceTimersByTime(VIEWING_REPEAT_MS);
      expect(frames(ws)).toHaveLength(3);
      h.setViewing(false);
      expect(frames(ws)[frames(ws).length - 1]).toEqual({ t: "viewing", visible: false });
      vi.advanceTimersByTime(VIEWING_REPEAT_MS * 3);
      expect(frames(ws)).toHaveLength(4);
      h.stop();
    });

    it("a view asked before the socket opens goes out on open (and on re-open)", () => {
      const h = handle();
      const ws = MockWS.last!;
      h.setViewing(true);
      expect(ws.sent).toEqual([]);
      ws.openNow();
      expect(frames(ws)).toEqual([{ t: "viewing", visible: true }]);
      h.stop();
    });

    it("stop (unmount) sends false while viewing", () => {
      const h = handle();
      const ws = MockWS.last!;
      ws.openNow();
      h.setViewing(true);
      h.stop();
      expect(frames(ws)[frames(ws).length - 1]).toEqual({ t: "viewing", visible: false });
    });

    it("never sends anything when it was never viewing", () => {
      const h = handle();
      const ws = MockWS.last!;
      ws.openNow();
      h.setViewing(false);
      vi.advanceTimersByTime(VIEWING_REPEAT_MS * 2);
      h.stop();
      expect(ws.sent).toEqual([]);
    });
  });
});
