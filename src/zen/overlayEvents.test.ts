import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeScope } from "../test/fakeScope";

// MA21: the socket is opened on a scope.
const SCOPE = fakeScope({ id: "s1", base: "https://host.k2.dev", token: "tok" });

import { connectOverlayEvents, OVERLAY_POLL_MS } from "./overlayEvents";

class MockWS {
  static last: MockWS | null = null;
  static instances: MockWS[] = [];
  readyState = 0;
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
});
