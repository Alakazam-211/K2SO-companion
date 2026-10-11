// MA9 / MS25: in Zen the feedback store rides the server's ONE app socket
// (`/cli/sessions/events?path=`), shared with the Agents list. No legacy
// `/events` socket, and one ticket change refetches the list once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));
const { fetchAllFeedback, fetchFeedbackShow } = vi.hoisted(() => ({
  fetchAllFeedback: vi.fn(async (_scope: { id: string }, _projects: unknown[]) => [] as unknown[]),
  fetchFeedbackShow: vi.fn(),
}));
vi.mock("../api/feedback", () => ({
  fetchAllFeedback,
  fetchFeedbackShow,
  countWaiting: () => 0,
  feedbackEventTargets: () => null,
}));

import { useFeedbackStore } from "./feedback";
import { useServersStore } from "./servers";
import { useWorkspacesStore } from "./workspaces";
import { connectProjectEvents, TICKET_EVENT_DEBOUNCE_MS } from "../zen/ticketEvents";
import { scopeFor } from "../api/scope";

class MockWS {
  static instances: MockWS[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
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
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal("WebSocket", MockWS);
  vi.useFakeTimers();
  fetchAllFeedback.mockClear();
  useServersStore.setState({
    hydrated: true,
    servers: [{ id: "s1", nickname: "S", url: "https://s1.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok" },
    recovery: {},
  });
  useWorkspacesStore.setState({ projects: [{ id: "p", name: "P", path: "/p" } as never] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Zen feedback live (MA9)", () => {
  it("uses the shared sessions/events hub, never /events, and refetches once per change", async () => {
    const pins = connectProjectEvents(scopeFor("s1"), () => {});
    useFeedbackStore.getState().ensureLive({ via: "hub" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAllFeedback).toHaveBeenCalledTimes(1);
    expect(MockWS.instances.map((w) => w.url)).toEqual([
      "wss://s1.k2.dev/cli/sessions/events?path=&token=tok",
    ]);
    // A second ensureLive (remount) keeps the one socket.
    useFeedbackStore.getState().ensureLive({ via: "hub" });
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWS.instances).toHaveLength(1);
    fetchAllFeedback.mockClear();

    MockWS.instances[0].onopen?.();
    MockWS.instances[0].deliver({ kind: "feedback_changed", id: "t1" });
    MockWS.instances[0].deliver({ kind: "ticket_changed", id: "t1" });
    await vi.advanceTimersByTimeAsync(TICKET_EVENT_DEBOUNCE_MS + 300);
    expect(fetchAllFeedback).toHaveBeenCalledTimes(1);
    expect(fetchAllFeedback.mock.calls[0][0]).toMatchObject({ id: "s1" });
    pins.stop();
  });
});
