import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeScope } from "../test/fakeScope";

// MA21: hubs are opened on a scope (one per server id).
const HOST = fakeScope({ id: "host", base: "https://host.k2.dev", token: "tok" });
const OTHER = fakeScope({ id: "other", base: "https://other.k2.dev", token: "tok" });

import {
  TICKET_EVENT_DEBOUNCE_MS,
  connectProjectEvents,
  connectTicketEvents,
  isProjectsChangedFrame,
  subscribeAppEvents,
} from "./ticketEvents";

class MockWS {
  static instances: MockWS[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("shared sessions/events socket", () => {
  beforeEach(() => {
    MockWS.instances = [];
    vi.stubGlobal("WebSocket", MockWS);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("projects_changed refetches pins once per burst (300 ms debounce)", () => {
    const onPins = vi.fn();
    const h = connectProjectEvents(HOST, onPins);
    const ws = MockWS.instances[0];
    expect(ws.url).toBe("wss://host.k2.dev/cli/sessions/events?path=&token=tok");
    ws.onopen?.();
    ws.deliver({ kind: "projects_changed" });
    ws.deliver({ kind: "projects_changed" });
    ws.deliver({ kind: "ticket_changed", id: "t1" });
    vi.advanceTimersByTime(TICKET_EVENT_DEBOUNCE_MS - 1);
    expect(onPins).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPins).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("the Agents list and the Tickets overlay share one socket per server", () => {
    const onPins = vi.fn();
    const onTickets = vi.fn();
    const pins = connectProjectEvents(HOST, onPins);
    const tickets = connectTicketEvents(HOST, onTickets);
    expect(MockWS.instances).toHaveLength(1);
    const ws = MockWS.instances[0];
    ws.onopen?.();
    ws.deliver({ kind: "feedback_changed" });
    vi.advanceTimersByTime(TICKET_EVENT_DEBOUNCE_MS);
    expect(onTickets).toHaveBeenCalledTimes(1);
    expect(onPins).not.toHaveBeenCalled();
    tickets.stop();
    expect(ws.closed).toBe(false);
    pins.stop();
    expect(ws.closed).toBe(true);
  });

  it("a frame subscriber gets each frame at once; onChange only on a re-pull", () => {
    const onFrame = vi.fn();
    const onChange = vi.fn();
    const h = subscribeAppEvents(
      HOST,
      (f) => (f as { kind?: string }).kind === "thread_read",
      onChange,
      onFrame
    );
    const ws = MockWS.instances[0];
    ws.onopen?.();
    ws.deliver({ kind: "thread_read", id: "c1", total: 1 });
    ws.deliver({ kind: "thread_read", id: "c2", total: 2 });
    ws.deliver({ kind: "projects_changed" });
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[1][0]).toEqual({ kind: "thread_read", id: "c2", total: 2 });
    vi.advanceTimersByTime(TICKET_EVENT_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
    // The socket drops and reopens: frames may be lost, so re-pull.
    ws.close();
    vi.advanceTimersByTime(5_000);
    const ws2 = MockWS.instances[1];
    ws2.onopen?.();
    vi.advanceTimersByTime(TICKET_EVENT_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("another server gets its own socket", () => {
    const a = connectProjectEvents(HOST, vi.fn());
    const b = connectProjectEvents(OTHER, vi.fn());
    expect(MockWS.instances.map((w) => w.url.split("/cli")[0])).toEqual([
      "wss://host.k2.dev",
      "wss://other.k2.dev",
    ]);
    a.stop();
    b.stop();
  });

  it("a reopen dials the hub's own server, never another (MS6)", () => {
    const a = connectProjectEvents(HOST, vi.fn());
    const b = connectProjectEvents(OTHER, vi.fn());
    const [wsA] = MockWS.instances;
    wsA.onopen?.();
    // The token rotates on HOST; OTHER is untouched.
    HOST.setToken("tok-2");
    wsA.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1000);
    const redial = MockWS.instances[2];
    expect(redial.url).toBe("wss://host.k2.dev/cli/sessions/events?path=&token=tok-2");
    a.stop();
    b.stop();
  });

  it("4001 (kicked) stops the hub: no reconnect", () => {
    const a = connectProjectEvents(HOST, vi.fn());
    const ws = MockWS.instances[0];
    ws.onopen?.();
    ws.onclose?.({ code: 4001 });
    vi.advanceTimersByTime(60_000);
    expect(MockWS.instances).toHaveLength(1);
    a.stop();
  });

  it("matches only projects_changed frames", () => {
    expect(isProjectsChangedFrame({ kind: "projects_changed" })).toBe(true);
    expect(isProjectsChangedFrame({ kind: "active_changed" })).toBe(false);
    expect(isProjectsChangedFrame(null)).toBe(false);
  });
});
