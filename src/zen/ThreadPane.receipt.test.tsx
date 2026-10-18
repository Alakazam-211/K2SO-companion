// @vitest-environment jsdom
// iMessage in the Thread: one "Delivered" under the newest confirmed send
// (moving to a newer one once it is confirmed, "Read" once the agent picks
// it up), and bubble runs — a tail on the last bubble of a run only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
vi.mock("../api/projectGroups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/projectGroups")>();
  return { ...actual, postProjectGroupMessage: vi.fn() };
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
import { connectOverlayEvents } from "./overlayEvents";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import type { ThreadMessage } from "./threadModel";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const T0 = 1_700_000_000;
const msg = (id: string, seq: number, text: string, mine: boolean, at: number, from = mine ? "baden" : "appa"): ThreadMessage => ({
  id,
  seq,
  text,
  from,
  at,
  mine,
  kind: "text",
  choice: null,
});
const wire = (id: string, seq: number, body: string, at: number, from = "baden") => ({
  id,
  seq,
  doc: { id, from, body, created_at: at },
});

function openRoom(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: [],
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
    ...over,
  });
}

const rowOf = (text: string) =>
  screen
    .getAllByTestId("thread-bubble")
    .find((b) => b.textContent?.includes(text))!
    .closest("[data-thread-msg]") as HTMLElement;
const lineOf = (text: string) =>
  rowOf(text).querySelector('[data-testid="thread-msg-time"]') as HTMLElement | null;
const bubbleOf = (text: string) => rowOf(text).querySelector('[data-testid="thread-bubble"]') as HTMLElement;
const receipts = () => Array.from(document.querySelectorAll("[data-receipt]"));
function send(text: string) {
  fireEvent.change(screen.getByTestId("composer-input"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("composer-form"));
}

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  openRoom();
});

afterEach(() => {
  cleanup();
  vi.mocked(postThread).mockReset();
  vi.mocked(getThread).mockReset();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.restoreAllMocks();
  // @ts-expect-error test cleanup
  delete window.matchMedia;
});

describe("Delivered", () => {
  it("sits under the newest confirmed send only, and moves to a newer one once it is confirmed", async () => {
    openRoom({ thread: [msg("m1", 1, "first", true, T0)] });
    let answer!: (v: Awaited<ReturnType<typeof postThread>>) => void;
    vi.mocked(postThread).mockReturnValue(new Promise((ok) => (answer = ok)));
    render(<ThreadPane />);
    expect(lineOf("first")?.getAttribute("data-receipt")).toBe("delivered");
    expect(receipts()).toHaveLength(1);

    // Pending: no label under it (it breathes); the older one keeps it.
    send("second");
    expect(lineOf("second")?.getAttribute("data-receipt")).toBeNull();
    expect(lineOf("second")?.getAttribute("data-status")).toBe("sending");
    expect(lineOf("first")?.getAttribute("data-receipt")).toBe("delivered");

    // Confirmed (well after the first: its own run): the label moves. The
    // old line stays (same box, no layout change), its time back in view.
    vi.mocked(getThread).mockResolvedValue({
      ok: true,
      data: { items: [wire("m1", 1, "first", T0), wire("n2", 2, "second", T0 + 600)] },
    });
    const oldLine = lineOf("first");
    await act(async () => answer({ ok: true, data: { id: "n2", seq: 2, body: "second" } }));
    await waitFor(() => expect(lineOf("second")?.getAttribute("data-receipt")).toBe("delivered"));
    expect(lineOf("first")).toBe(oldLine);
    expect(oldLine?.getAttribute("data-receipt")).toBeNull();
    expect(receipts()).toHaveLength(1);
    // The words are CSS over the fixed-height line: its text is the time.
    expect(lineOf("second")?.className).toContain("zen-receipt");
    expect(lineOf("second")?.className).toContain("h-4");
    expect(lineOf("second")?.textContent).not.toContain("Delivered");
  });

  it("a failed send keeps its Not sent line; the label stays on the last delivered one", async () => {
    openRoom({ thread: [msg("m1", 1, "first", true, T0)] });
    vi.mocked(postThread).mockResolvedValue({ ok: false, error: "nope" } as never);
    render(<ThreadPane />);
    send("second");
    await waitFor(() => expect(screen.getByTestId("outgoing-retry")).not.toBeNull());
    expect(lineOf("second")?.getAttribute("data-receipt")).toBeNull();
    expect(lineOf("first")?.getAttribute("data-receipt")).toBe("delivered");
  });

  it("reduced motion: no flight, the label still shows once confirmed", async () => {
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as never;
    const animate = vi.fn();
    Element.prototype.animate = animate as never;
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 1 } });
    vi.mocked(getThread).mockResolvedValue({ ok: true, data: { items: [wire("n1", 1, "hello", T0)] } });
    try {
      render(<ThreadPane />);
      send("hello");
      await waitFor(() => expect(lineOf("hello")?.getAttribute("data-receipt")).toBe("delivered"));
      expect(animate).not.toHaveBeenCalled();
      expect(screen.queryByTestId("send-fly-clone")).toBeNull();
    } finally {
      // @ts-expect-error test cleanup
      delete Element.prototype.animate;
    }
  });
});

describe("Read", () => {
  it("once the agent replied after it", () => {
    openRoom({ thread: [msg("m1", 1, "do it", true, T0), msg("a1", 2, "on it", false, T0 + 5)] });
    render(<ThreadPane />);
    expect(lineOf("do it")?.getAttribute("data-receipt")).toBe("read");
  });

  it("once the agent's turn picks it up (activity frames); delivering is not yet", async () => {
    openRoom({ thread: [msg("m1", 1, "do it", true, T0)] });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const onItem = vi.mocked(connectOverlayEvents).mock.calls[0][0].onItem;
    const frame = (phase: string, rev: number) => ({
      collection: "activity",
      seq: 0,
      id: "turn-1",
      activity: {
        turnId: "turn-1",
        state: "working",
        phase,
        phaseSince: T0 * 1000 + 400,
        startedAt: T0 * 1000 + 300,
        serverNow: T0 * 1000 + 500,
        tally: { read: 0, search: 0, cmd: 0, edit: 0 },
        end: null,
        rev,
      },
    });
    expect(lineOf("do it")?.getAttribute("data-receipt")).toBe("delivered");
    act(() => onItem(frame("delivering", 1) as never));
    expect(lineOf("do it")?.getAttribute("data-receipt")).toBe("delivered");
    act(() => onItem(frame("working", 2) as never));
    expect(lineOf("do it")?.getAttribute("data-receipt")).toBe("read");
    // Same line element: Delivered → Read is a crossfade, nothing re-laid out.
    expect(receipts()).toHaveLength(1);
  });

  it("project chats stay Delivered (no one reader)", () => {
    openRoom({
      threadGroupId: "pg1",
      thread: [msg("m1", 1, "team", true, T0), msg("b1", 2, "ok", false, T0 + 5, "bo")],
    });
    render(<ThreadPane />);
    expect(lineOf("team")?.getAttribute("data-receipt")).toBe("delivered");
  });
});

describe("runs and tails", () => {
  it("a tail on the last bubble of each run; one meta line per incoming run; mine status on the run's last", () => {
    openRoom({
      thread: [
        msg("a1", 1, "alpha", false, T0),
        msg("a2", 2, "beta", false, T0 + 10),
        msg("m1", 3, "gamma", true, T0 + 20),
        msg("m2", 4, "delta", true, T0 + 30),
        msg("a3", 5, "later", false, T0 + 3600),
      ],
    });
    render(<ThreadPane />);
    expect(bubbleOf("alpha").getAttribute("data-tail")).toBeNull();
    expect(bubbleOf("beta").getAttribute("data-tail")).toBe("theirs");
    expect(bubbleOf("gamma").getAttribute("data-tail")).toBeNull();
    expect(bubbleOf("delta").getAttribute("data-tail")).toBe("mine");
    expect(bubbleOf("delta").className).toContain("zen-tail");
    expect(bubbleOf("later").getAttribute("data-tail")).toBe("theirs");
    // Theirs: name • time above the first of a run only.
    expect(rowOf("alpha").querySelector('[data-testid="thread-msg-meta"]')).not.toBeNull();
    expect(rowOf("beta").querySelector('[data-testid="thread-msg-meta"]')).toBeNull();
    expect(rowOf("later").querySelector('[data-testid="thread-msg-meta"]')).not.toBeNull();
    // Mine: the status line under the run's last only (it carries "Read":
    // the agent replied after).
    expect(lineOf("gamma")).toBeNull();
    expect(lineOf("delta")?.getAttribute("data-receipt")).toBe("read");
    // Tighter inside a run, a gap between runs.
    expect(rowOf("beta").className).not.toContain("mt-1.5");
    expect(rowOf("gamma").className).toContain("mt-1.5");
    expect(rowOf("delta").getAttribute("data-run")).toBe("last");
  });

  it("a send joining my run moves the tail to it; the flight carries the tail on its blue", () => {
    openRoom({ thread: [msg("m1", 1, "first", true, Math.floor(Date.now() / 1000))] });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute("data-testid");
      const r =
        id === "composer-input"
          ? { left: 20, top: 700, width: 300, height: 24 }
          : id === "thread-bubble"
            ? { left: 200, top: 500, width: 80, height: 36 }
            : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
    Element.prototype.animate = vi.fn(() => ({ onfinish: null, oncancel: null, cancel: vi.fn() })) as never;
    vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
    try {
      render(<ThreadPane />);
      expect(bubbleOf("first").getAttribute("data-tail")).toBe("mine");
      send("second");
      expect(bubbleOf("first").getAttribute("data-tail")).toBeNull();
      expect(bubbleOf("second").getAttribute("data-tail")).toBe("mine");
      const tail = screen.getByTestId("send-fly-shape").querySelector('[data-fly-part="tail"]') as HTMLElement;
      expect(tail.getAttribute("data-tail")).toBe("mine");
      expect(tail.className).toBe("zen-tail-solo");
    } finally {
      // @ts-expect-error test cleanup
      delete Element.prototype.animate;
    }
  });
});
