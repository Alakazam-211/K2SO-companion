// @vitest-environment jsdom
// The working drawer across your sends, fed the frames K2 really sends: a
// post while the agent works ends the turn on screen `superseded` at once
// (thread_activity.rs `start`), and the next turn's first frame follows
// once the message is delivered. The drawer must not hide in between.
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
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));
vi.mock("../stores/notifyPrefs", () => ({
  useNotifyPrefsStore: Object.assign(
    (sel: (s: { threadPush: Record<string, boolean> }) => unknown) => sel({ threadPush: {} }),
    { getState: () => ({ probe: async () => {} }) }
  ),
}));

import { getThreadActivity, postThread } from "../api/client";
import { connectOverlayEvents } from "./overlayEvents";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { useComposerDrafts } from "./composerDrafts";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

/** One `collection:"activity"` frame, shaped like the daemon's `body()`. */
function frame(turnId: string, rev: number, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    collection: "activity",
    seq: 0,
    id: turnId,
    activity: {
      turnId,
      state: "working",
      phase: "tool",
      phaseSince: now - 1_000,
      line: "Running `npm test`",
      startedAt: now - 20_000,
      since: now - 20_000,
      subagents: 0,
      subagentsDone: 0,
      background: 0,
      tally: { read: 2, search: 0, cmd: 1, edit: 0 },
      waitingOn: null,
      end: null,
      serverNow: now,
      rev,
      ...over,
    },
  };
}
const ended = (turnId: string, rev: number, reason: string, state = "stopped") =>
  frame(turnId, rev, { state, end: { reason, detail: null, at: Date.now() } });

const socket = () => vi.mocked(connectOverlayEvents).mock.calls[0][0];
const push = (raw: unknown) => act(() => socket().onItem(raw as never));
const strip = () => screen.queryByTestId("thread-working-strip");

beforeEach(() => {
  localStorage.clear();
  useComposerDrafts.getState().reload();
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
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
    sending: false,
    sendError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.mocked(postThread).mockReset();
  vi.mocked(getThreadActivity).mockClear();
});

describe("working drawer across sends", () => {
  it("each send while the agent works keeps it up: no slide out, swapped in place", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    push(frame("turn-1", 1));
    const el = strip();
    expect(el).not.toBeNull();

    for (const [prev, next] of [
      ["turn-1", "turn-2"],
      ["turn-2", "turn-3"],
    ]) {
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: `more for ${next}` } });
      fireEvent.submit(screen.getByTestId("composer-form"));
      const step = screen.getByTestId("thread-strip-step-text").textContent;
      // The post supersedes the turn on screen at once…
      push(ended(prev, 9, "superseded"));
      expect(strip()).toBe(el);
      expect(strip()?.getAttribute("data-leaving")).toBeNull();
      expect(screen.getByTestId("thread-strip-step-text").textContent).toBe(step);
      // …a socket reopen in the gap catches up `{turn:null}` (the new turn
      // has not opened yet): still up…
      await act(async () => socket().onOpen?.());
      expect(vi.mocked(getThreadActivity)).toHaveBeenCalled();
      expect(strip()).toBe(el);
      expect(strip()?.getAttribute("data-leaving")).toBeNull();
      // …and the next turn opens once the message is delivered.
      push(frame(next, 1, { phase: "working", line: null, startedAt: Date.now(), phaseSince: Date.now() }));
      expect(strip()).toBe(el);
      expect(strip()?.getAttribute("data-leaving")).toBeNull();
      expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Working");
    }
  });

  it("the agent really finishing still takes it down", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    push(frame("turn-1", 1));
    push(ended("turn-1", 2, "done", "idle"));
    expect(strip()?.getAttribute("data-leaving")).toBe("true");
  });
});
