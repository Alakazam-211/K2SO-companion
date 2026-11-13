// @vitest-environment jsdom
// K2 0.46.13 tombstones in the Thread: one muted "Message deleted" line on
// the sender's side (no bubble, name, time, receipt, files or hold menu),
// and the receipt moves to the message before it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
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

import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { type ThreadMessage } from "./threadModel";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const T0 = 1_700_000_000;
const msg = (id: string, seq: number, text: string, mine: boolean, at: number): ThreadMessage => ({
  id,
  seq,
  text,
  from: mine ? "baden" : "appa",
  at,
  mine,
  kind: "text",
  choice: null,
});

function openRoom(thread: ThreadMessage[]) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread,
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
  });
}

const receipts = () => Array.from(document.querySelectorAll("[data-receipt]"));
const rowWith = (text: string) =>
  screen
    .getAllByTestId("thread-bubble")
    .find((b) => b.textContent?.includes(text))!
    .closest("[data-thread-msg]") as HTMLElement;

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error test cleanup
  delete window.matchMedia;
});

describe("a deleted message", () => {
  it("a live tombstone frame replaces my bubble with one muted line, and the receipt moves back", async () => {
    openRoom([msg("m1", 1, "first", true, T0), msg("m2", 2, "second", true, T0 + 600)]);
    render(<ThreadPane />);
    expect(rowWith("second").querySelector("[data-receipt]")?.getAttribute("data-receipt")).toBe("delivered");

    await act(async () => {
      useZenStore.getState().ingestThreadRaw({
        id: "m2",
        seq: 2,
        doc: { id: "m2", from: "baden", created_at: T0 + 600, deleted: true, deletedAt: T0 + 700, deletedBy: "baden" },
      } as never);
    });

    expect(screen.queryByText("second")).toBeNull();
    const line = screen.getByTestId("thread-msg-deleted");
    expect(line.textContent).toBe("Message deleted");
    expect(line.className).toContain("self-end");
    expect(line.querySelector('[data-testid="thread-bubble"]')).toBeNull();
    expect(line.querySelector("[data-receipt]")).toBeNull();
    expect(line.querySelector('[data-testid="thread-msg-time"]')).toBeNull();
    // The receipt is under the message before it, and only there.
    expect(receipts()).toHaveLength(1);
    expect(rowWith("first").querySelector("[data-receipt]")?.getAttribute("data-receipt")).toBe("delivered");
  });

  it("theirs: on their side, with no name or picture", () => {
    openRoom([
      msg("m1", 1, "hello", true, T0),
      { ...msg("m2", 2, "", false, T0 + 5), deleted: true },
    ]);
    render(<ThreadPane />);
    const line = screen.getByTestId("thread-msg-deleted");
    expect(line.className).toContain("self-start");
    expect(line.querySelector('[data-testid="thread-msg-meta"]')).toBeNull();
    expect(line.querySelector('[data-testid="thread-msg-picture"]')).toBeNull();
  });
});
