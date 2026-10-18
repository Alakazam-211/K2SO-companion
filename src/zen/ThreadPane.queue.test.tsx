// @vitest-environment jsdom
// Auto reconnect, sends: while the room's server is down the composer stays
// on (the banner says it is reconnecting), a send is QUEUED instead of
// failing, and every queued send of the room goes out, in order, once the
// server is back. A send whose POST finds the server gone is queued too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
    uploadFsBinary: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));
vi.mock("../stores/notifyPrefs", () => ({
  useNotifyPrefsStore: Object.assign(
    (sel: (s: { threadPush: Record<string, boolean> }) => unknown) => sel({ threadPush: {} }),
    { getState: () => ({ probe: async () => {} }) }
  ),
}));

import { getThread, postThread } from "../api/client";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { __resetHealthForTests, clearDown, healthStore, markDown } from "./multi/serverHealth";
import { useMultiServerPrefs } from "./multi/prefs";

const wireItem = (id: string, seq: number, body: string, from = "baden") => ({
  id,
  seq,
  doc: { id, from, body, created_at: 1_700_000_000 },
});

const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;
function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}
function send() {
  fireEvent.submit(screen.getByTestId("composer-form"));
}
const statuses = () => useZenStore.getState().outbox.map((o) => [o.text, o.status]);

function Room() {
  // What Zen passes while the room's server is down: the banner, input on.
  return <ThreadPane roomBanner={<div data-testid="banner">Reconnecting to Box…</div>} roomQueuesInput />;
}

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  __resetHealthForTests();
  useMultiServerPrefs.setState({ multiServer: true });
  useZenStore.setState({
    agentSource: "error",
    threadSource: "error",
    threadError: "Could not reach server: host is down",
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: [],
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
  });
  let n = 0;
  vi.mocked(postThread).mockImplementation(async (_s, _a, body) => {
    n += 1;
    return { ok: true, data: { id: `n${n}`, seq: n, body } };
  });
  vi.mocked(getThread).mockImplementation(async () => ({
    ok: true,
    data: {
      items: vi.mocked(postThread).mock.calls.map((c, i) => wireItem(`n${i + 1}`, i + 1, String(c[2]))),
    },
  }));
});

afterEach(() => {
  cleanup();
  vi.mocked(postThread).mockReset();
  vi.mocked(getThread).mockReset();
  vi.restoreAllMocks();
});

describe("sends while the server is down", () => {
  it("are queued (input stays on), then go out in order once the server is back", async () => {
    markDown("s1");
    render(<Room />);
    expect(screen.getByTestId("banner")).toBeTruthy();
    expect(input().disabled).toBe(false);
    type("first");
    send();
    type("second");
    send();
    await act(async () => {});
    expect(postThread).not.toHaveBeenCalled();
    expect(statuses()).toEqual([
      ["first", "queued"],
      ["second", "queued"],
    ]);
    expect(screen.getAllByText("Waiting for connection…")).toHaveLength(2);

    // The reconnect clears the down state: the queue drains, oldest first.
    act(() => clearDown("s1"));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(vi.mocked(postThread).mock.calls.map((c) => c[2])).toEqual(["first", "second"]);
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("a POST that finds the server gone is queued, marks it down, and goes out after", async () => {
    vi.mocked(postThread).mockResolvedValueOnce({ ok: false, error: "Could not reach server: host is down" });
    render(<ThreadPane />);
    type("hello");
    send();
    await waitFor(() => expect(statuses()).toEqual([["hello", "queued"]]));
    expect(healthStore.getState().downSince.s1).toBeDefined();
    expect(screen.queryByTestId("outgoing-retry")).toBeNull();

    act(() => clearDown("s1"));
    await waitFor(() => expect(useZenStore.getState().outbox).toEqual([]));
    expect(vi.mocked(postThread).mock.calls.map((c) => c[2])).toEqual(["hello", "hello"]);
  });

  it("an app error is still 'Not sent' (not queued)", async () => {
    vi.mocked(postThread).mockResolvedValueOnce({ ok: false, error: "tunnel down" });
    render(<ThreadPane />);
    type("hello");
    send();
    await screen.findByTestId("outgoing-retry");
    expect(statuses()).toEqual([["hello", "failed"]]);
  });

  it("flag off: nothing is queued", async () => {
    useMultiServerPrefs.setState({ multiServer: false });
    markDown("s1");
    render(<ThreadPane />);
    type("hello");
    send();
    await waitFor(() => expect(postThread).toHaveBeenCalledTimes(1));
  });
});
