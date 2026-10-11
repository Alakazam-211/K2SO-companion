import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let base = "https://host.k2.dev";
vi.mock("../api/client", () => ({
  getBaseUrl: () => base,
  getToken: () => "tok",
}));

import {
  TICKET_EVENT_DEBOUNCE_MS,
  connectProjectEvents,
  connectTicketEvents,
  isProjectsChangedFrame,
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
    base = "https://host.k2.dev";
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
    const h = connectProjectEvents(onPins);
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
    const pins = connectProjectEvents(onPins);
    const tickets = connectTicketEvents(onTickets);
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

  it("another server gets its own socket", () => {
    const a = connectProjectEvents(vi.fn());
    base = "https://other.k2.dev";
    const b = connectProjectEvents(vi.fn());
    expect(MockWS.instances.map((w) => w.url.split("/cli")[0])).toEqual([
      "wss://host.k2.dev",
      "wss://other.k2.dev",
    ]);
    a.stop();
    b.stop();
  });

  it("matches only projects_changed frames", () => {
    expect(isProjectsChangedFrame({ kind: "projects_changed" })).toBe(true);
    expect(isProjectsChangedFrame({ kind: "active_changed" })).toBe(false);
    expect(isProjectsChangedFrame(null)).toBe(false);
  });
});
