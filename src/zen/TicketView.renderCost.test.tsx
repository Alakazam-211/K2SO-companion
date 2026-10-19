// @vitest-environment jsdom
// Render cost of the open ticket (ThreadPane.renderCost.test.tsx's twin):
// typing in the comment composer, a refetch handing over new-but-equal
// comments and the keyboard moving must not re-render (or re-parse the
// markdown of) the comment rows that did not change. Counts:
//   - comment bubble renders (useDeliverBrighten runs once per
//     TicketBubbleBox render),
//   - markdown parses (remark-gfm's attacher runs once per processor,
//     i.e. once per ReactMarkdown render),
//   - TicketView renders (useKeyboardFlip runs once per TicketView render).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const counts = vi.hoisted(() => ({ bubble: 0, parse: 0, pane: 0 }));

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock("../api/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/feedback")>();
  return {
    ...actual,
    resolveFeedback: vi.fn(async () => undefined),
    commentFeedback: vi.fn(),
    fetchFeedbackShow: vi.fn(),
    fetchAllFeedback: vi.fn(async () => []),
    fetchTicketUsers: vi.fn(async () => ["owner", "u"]),
  };
});
vi.mock("./ticketEvents", () => ({
  connectTicketEvents: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("../lib/useSessionIdentity", () => {
  const me = { username: "u", owner: false };
  return { useSessionIdentity: () => me };
});
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

import type { FeedbackComment, FeedbackShow } from "../api/feedback";
import { useFeedbackStore } from "../stores/feedback";
import { useComposerDrafts } from "./composerDrafts";
import { TicketView } from "./TicketView";
import { WINDOW_ROWS } from "./threadWindow";

const NOW = Math.floor(Date.now() / 1000);
let N = 50;

function comments(): FeedbackComment[] {
  const out: FeedbackComment[] = [];
  for (let i = 0; i < N; i++) {
    const mine = i % 3 === 0;
    out.push({
      author: mine ? "u" : "sales",
      at: NOW - (N - i) * 60,
      body: mine
        ? `Can we look at \`src/zen/TicketView.tsx\` line ${i}?`
        : `**Done** with step ${i}.\n\n- edited \`src/a${i}.ts\`\n- ran the tests\n\n| a | b |\n|---|---|\n| ${i} | ok |\n\nSee https://example.com/${i}`,
    });
  }
  return out;
}

function ticket(): FeedbackShow {
  return {
    id: "t1",
    projectId: "p1",
    sessionId: null,
    sessionKind: null,
    agentName: "sales",
    kind: "question",
    title: "Which pricing tier for Acme?",
    body: "One-line summary",
    options: ["Pro", "Business"],
    priority: 2,
    status: "needs_discussion",
    answer: null,
    createdAt: NOW - 3600,
    updatedAt: NOW - 60,
    answeredAt: null,
    commentCount: N,
    assignees: ["u"],
    hasBrief: false,
    workspace: "Skin",
    projectPath: "/tmp/skin",
    comments: comments(),
  };
}

const reset = () => {
  counts.bubble = 0;
  counts.parse = 0;
  counts.pane = 0;
};
const snap = () => ({ ...counts });
const input = () => screen.getByTestId("ticket-composer-input") as HTMLTextAreaElement;
const drawnRows = () => Math.min(N, WINDOW_ROWS);

function mount(viewportHeight?: number) {
  const t = performance.now();
  const view = render(
    <div style={{ position: "relative", height: viewportHeight ?? 800 }}>
      <TicketView id="t1" linked onBack={() => {}} />
    </div>
  );
  const ms = performance.now() - t;
  console.info(
    `[render-cost] ticket N=${N} open: rows=${document.querySelectorAll("[data-ticket-msg]").length} domNodes=${document.querySelectorAll("*").length} ms=${ms.toFixed(1)}`
  );
  return view;
}

beforeEach(() => {
  localStorage.clear();
  useComposerDrafts.getState().reload();
});

afterEach(() => {
  cleanup();
});

for (const size of [50, 300]) describe(`Ticket render cost (${size} comments)`, () => {
  beforeEach(() => {
    N = size;
    useFeedbackStore.setState({ openId: "t1", openItem: ticket(), commentOutbox: [] });
  });

  it("opens with the comment rows capped by the render window", () => {
    mount();
    expect(screen.getAllByTestId("ticket-comment").length).toBe(drawnRows());
    // The brief leads the ticket: the window starts at the oldest comment.
    expect(screen.getAllByTestId("ticket-comment")[0].textContent).toContain("line 0?");
  });

  it("a keystroke re-renders no comment row and parses no markdown", () => {
    mount();
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
      `[render-cost] ticket N=${N} keystroke: bubbles=${avg((s) => s.bubble)} parses=${avg((s) => s.parse)} pane=${avg((s) => s.pane)} ms=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}`
    );
    expect(input().value).toBe(text);
    expect(avg((s) => s.bubble)).toBe(0);
    expect(avg((s) => s.parse)).toBe(0);
    // The ticket hears only the field turning non-blank (the first key).
    expect(per.slice(1).every((s) => s.pane === 0)).toBe(true);
  });

  it("a refetch with the same comments (new objects) re-renders no row", () => {
    mount();
    reset();
    const t = performance.now();
    act(() => useFeedbackStore.setState({ openItem: ticket() }));
    act(() => useFeedbackStore.setState({ openItem: ticket() }));
    const ms = performance.now() - t;
    console.info(
      `[render-cost] ticket N=${N} 2 refetches: bubbles=${counts.bubble} parses=${counts.parse} pane=${counts.pane} ms=${ms.toFixed(2)}`
    );
    expect(counts.pane).toBeGreaterThan(0);
    expect(counts.bubble).toBe(0);
    expect(counts.parse).toBe(0);
  });

  it("a new comment renders just its own row", () => {
    mount();
    // Following the newest (the reader scrolled to the bottom).
    const scroller = screen.getByTestId("ticket-scroller");
    fireEvent.scroll(scroller);
    const arrive = (body: string) => {
      const cur = useFeedbackStore.getState().openItem as FeedbackShow;
      const next = { ...cur, comments: [...cur.comments, { author: "sales", body, at: NOW }] };
      act(() => useFeedbackStore.setState({ openItem: next }));
    };
    // The first arrival brings the window down to the newest (it opened at
    // the oldest); the next draws only itself.
    arrive("One **thing**");
    reset();
    arrive("One more **thing**");
    console.info(
      `[render-cost] ticket N=${N} 1 arrival: bubbles=${counts.bubble} parses=${counts.parse} pane=${counts.pane}`
    );
    expect(counts.bubble).toBeLessThanOrEqual(1);
    expect(counts.parse).toBeLessThanOrEqual(1);
  });
});
