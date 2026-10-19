// @vitest-environment jsdom
// Render cost of the open Thread: typing in the composer, an activity
// frame and the keyboard moving must not re-render (or re-parse the
// markdown of) the message rows that did not change. Counts:
//   - Bubble renders (useDeliverBrighten runs once per Bubble render),
//   - markdown parses (remark-gfm's attacher runs once per processor,
//     i.e. once per ReactMarkdown render),
//   - ThreadPane renders (useKeyboardFlip runs once per ThreadPane render).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const counts = vi.hoisted(() => ({ bubble: 0, parse: 0, pane: 0 }));

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
vi.mock("./useDeliverBrighten", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useDeliverBrighten")>();
  return {
    ...actual,
    useDeliverBrighten: (...args: Parameters<typeof actual.useDeliverBrighten>) => {
      counts.bubble++;
      return actual.useDeliverBrighten(...args);
    },
  };
});
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  const gfm = actual.default;
  return {
    default: function countedGfm(this: unknown, ...args: unknown[]) {
      counts.parse++;
      return (gfm as (...a: unknown[]) => unknown).apply(this, args);
    },
  };
});
vi.mock("../kit/mobileChat/useKeyboardFlip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kit/mobileChat/useKeyboardFlip")>();
  return {
    ...actual,
    useKeyboardFlip: (...args: Parameters<typeof actual.useKeyboardFlip>) => {
      counts.pane++;
      return actual.useKeyboardFlip(...args);
    },
  };
});

import { connectOverlayEvents } from "./overlayEvents";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { useComposerDrafts } from "./composerDrafts";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import type { ThreadMessage } from "./threadModel";

const N = 50;

function messages(): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  const t0 = Date.now() - N * 60_000;
  for (let i = 0; i < N; i++) {
    const mine = i % 3 === 0;
    out.push({
      id: `m${i}`,
      seq: i + 1,
      text: mine
        ? `Can you look at \`src/zen/ThreadPane.tsx\` line ${i}?`
        : `**Done** with step ${i}.\n\n- edited \`src/a${i}.ts\`\n- ran the tests\n\n| a | b |\n|---|---|\n| ${i} | ok |\n\nSee https://example.com/${i}`,
      from: mine ? "owner" : "appa",
      at: t0 + i * 60_000,
      mine,
      kind: "text",
      choice: null,
    });
  }
  return out;
}

function frame(turnId: string, rev: number) {
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
      line: `Running step ${rev}`,
      startedAt: now - 20_000,
      since: now - 20_000,
      subagents: 0,
      subagentsDone: 0,
      background: 0,
      tally: { read: rev, search: 0, cmd: 1, edit: 0 },
      waitingOn: null,
      end: null,
      serverNow: now,
      rev,
    },
  };
}

const reset = () => {
  counts.bubble = 0;
  counts.parse = 0;
  counts.pane = 0;
};
const snap = () => ({ ...counts });
const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
  useComposerDrafts.getState().reload();
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: messages(),
    threadHasMore: false,
    outbox: [],
    sending: false,
    sendError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(connectOverlayEvents).mockClear();
});

async function mounted() {
  render(<ThreadPane />);
  await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
  // Progressive first paint widens on the next idle frame.
  await waitFor(() => expect(screen.getAllByTestId("thread-bubble").length).toBe(N));
  await act(async () => {});
}

describe("Thread render cost (50 messages)", () => {
  it("a keystroke re-renders no message row and parses no markdown", async () => {
    await mounted();
    const per: ReturnType<typeof snap>[] = [];
    const times: number[] = [];
    let text = "";
    for (let k = 0; k < 10; k++) {
      text += "x";
      reset();
      const t = performance.now();
      fireEvent.change(input(), { target: { value: text } });
      times.push(performance.now() - t);
      per.push(snap());
    }
    const avg = (f: (s: ReturnType<typeof snap>) => number) =>
      per.reduce((a, s) => a + f(s), 0) / per.length;
    console.info(
      `[render-cost] keystroke: bubbles=${avg((s) => s.bubble)} parses=${avg((s) => s.parse)} pane=${avg((s) => s.pane)} ms=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}`
    );
    expect(input().value).toBe(text);
    expect(avg((s) => s.bubble)).toBe(0);
    expect(avg((s) => s.parse)).toBe(0);
  });

  it("an activity frame re-renders no unchanged row", async () => {
    await mounted();
    const socket = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    reset();
    const t = performance.now();
    act(() => socket.onItem(frame("turn-1", 1) as never));
    act(() => socket.onItem(frame("turn-1", 2) as never));
    const ms = performance.now() - t;
    console.info(
      `[render-cost] 2 activity frames: bubbles=${counts.bubble} parses=${counts.parse} pane=${counts.pane} ms=${ms.toFixed(2)}`
    );
    expect(counts.bubble).toBe(0);
    expect(counts.parse).toBe(0);
  });

  it("the keyboard moving (viewport height) re-renders no row", async () => {
    const { rerender } = render(<ThreadPane viewportHeight={800} />);
    await waitFor(() => expect(screen.getAllByTestId("thread-bubble").length).toBe(N));
    await act(async () => {});
    reset();
    for (const h of [700, 600, 500, 480]) rerender(<ThreadPane viewportHeight={h} />);
    console.info(
      `[render-cost] 4 viewport changes: bubbles=${counts.bubble} parses=${counts.parse} pane=${counts.pane}`
    );
    expect(counts.bubble).toBe(0);
    expect(counts.parse).toBe(0);
  });
});
