// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(async () => ({
    ok: true,
    data: [{ name: "Skin", path: "/tmp/skin" }],
  })),
}));

vi.mock("../api/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/feedback")>();
  return {
    ...actual,
    resolveFeedback: vi.fn(async () => undefined),
    commentFeedback: vi.fn(async () => ({ ok: true, id: "t", commentId: "c", author: "u", delivered: true })),
    fetchFeedbackShow: vi.fn(),
    fetchAllFeedback: vi.fn(async () => []),
    fetchTicketUsers: vi.fn(async () => ["owner", "u"]),
    assignFeedback: vi.fn(async () => ({ assignees: [] })),
  };
});

vi.mock("./ticketEvents", () => ({
  connectTicketEvents: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../lib/openExternal", () => ({ openExternal: vi.fn(async () => undefined) }));

import {
  assignFeedback,
  commentFeedback,
  fetchAllFeedback,
  fetchFeedbackShow,
  resolveFeedback,
  type FeedbackBrief,
  type FeedbackListRow,
  type FeedbackShow,
} from "../api/feedback";
import { openExternal } from "../lib/openExternal";
import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { connectTicketEvents } from "./ticketEvents";
import { TICKETS_HEADER_PX, TicketsOverlay } from "./TicketsOverlay";
import { TICKET_HEADER_PX } from "./TicketView";

const NOW = Math.floor(Date.now() / 1000);

const ROW: FeedbackListRow = {
  id: "t-wait",
  projectId: "p1",
  sessionId: null,
  sessionKind: null,
  agentName: "sales",
  kind: "question",
  title: "Which pricing tier for Acme?",
  body: "One-line summary",
  options: ["Pro", "Business"],
  priority: 2,
  status: "waiting",
  answer: null,
  createdAt: NOW - 120,
  updatedAt: NOW - 120,
  answeredAt: null,
  commentCount: 1,
  assignees: ["u"],
  hasBrief: false,
  projectPath: "/tmp/skin",
  projectName: "Skin",
};

const BRIEF: FeedbackBrief = {
  html:
    '<h2>Problem</h2><p>Read <a href="https://example.com/spec">the spec</a>.</p>' +
    '<ol class="k2-options"><li><strong>Starter</strong> — cheap</li><li><strong>Enterprise</strong> — SSO</li></ol>',
  text: "Problem\nRead the spec.",
  bytes: 210,
  sha256: "sha-1",
  sanitizer: "k2-brief-v1",
  createdAt: NOW - 120,
};

function showOf(row: FeedbackListRow, over: Partial<FeedbackShow> = {}): FeedbackShow {
  return {
    ...row,
    workspace: row.projectName,
    projectPath: row.projectPath,
    comments: [
      { author: "sales", body: "Filed. Brief attached.", at: NOW - 120 },
      { author: "u", body: "Looking now", at: NOW - 60 },
    ],
    ...over,
  };
}

/** Serve `show` for one row: brief=1 adds the brief, plain show doesn't. */
function serve(row: FeedbackListRow, brief: FeedbackBrief | null = null, over: Partial<FeedbackShow> = {}) {
  vi.mocked(fetchFeedbackShow).mockImplementation(async (_id, opts) =>
    opts?.brief ? { ...showOf(row, over), brief } : showOf(row, over)
  );
}

function setRows(rows: FeedbackListRow[]) {
  useFeedbackStore.setState({ rows, waitingCount: 0 });
  vi.mocked(fetchAllFeedback).mockResolvedValue(rows);
}

async function openTicket(title: string) {
  fireEvent.click(screen.getByText(title));
  await waitFor(() => screen.getByTestId("ticket-view"));
  await waitFor(() => screen.getByTestId("ticket-comments"));
}

beforeEach(() => {
  vi.clearAllMocks();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useFeedbackStore.setState({
    rows: [],
    waitingCount: 0,
    isLoading: false,
    error: null,
    loadedForServer: "s1",
    openId: null,
    openItem: null,
    openError: null,
    briefs: {},
  });
  setRows([ROW]);
  serve(ROW);
});

afterEach(() => cleanup());

describe("Tickets list", () => {
  it("defaults to Waiting on me and starts live refresh", async () => {
    setRows([
      ROW,
      { ...ROW, id: "t-other", title: "Someone else's", assignees: ["bob"] },
      { ...ROW, id: "t-ans", title: "Mine but answered", status: "answered" },
    ]);
    render(<TicketsOverlay onClose={() => {}} />);
    expect(screen.getByTestId("scope-waiting").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => screen.getByText("Which pricing tier for Acme?"));
    expect(screen.queryByText("Someone else's")).toBeNull();
    expect(screen.queryByText("Mine but answered")).toBeNull();
    expect(connectTicketEvents).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("scope-mine"));
    expect(screen.getByText("Mine but answered")).not.toBeNull();
    fireEvent.click(screen.getByTestId("scope-all"));
    expect(screen.getByText("Someone else's")).not.toBeNull();
  });

  it("an empty Waiting on me says nothing is waiting on you", async () => {
    setRows([{ ...ROW, assignees: ["bob"] }]);
    render(<TicketsOverlay onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("tickets-empty").textContent).toBe("Nothing is waiting on you");
    });
  });

  it("sections run Waiting, Needs discussion, Answered, Planned, Closed and mark HTML briefs", async () => {
    setRows([
      { ...ROW, id: "c", title: "closed one", status: "resolved" },
      { ...ROW, id: "p", title: "planned one", status: "planned" },
      { ...ROW, id: "a", title: "answered one", status: "answered" },
      { ...ROW, id: "n", title: "discuss one", status: "needs_discussion" },
      { ...ROW, id: "w", title: "waiting one", hasBrief: true },
    ]);
    render(<TicketsOverlay onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("scope-all"));
    await waitFor(() => screen.getByText("waiting one"));
    const labels = screen.getAllByTestId("ticket-section").map((s) => s.getAttribute("data-label"));
    expect(labels).toEqual(["Waiting", "Needs discussion", "Answered", "Planned", "Closed"]);
    expect(screen.getAllByTestId("ticket-html-mark")).toHaveLength(1);
  });
});

/** The shared floating-header contract (chat header c39c0ac). */
function expectBlurHeader(header: HTMLElement, blur: HTMLElement) {
  expect(header.className).toMatch(/absolute/);
  expect(header.style.pointerEvents).toBe("none");
  expect(header.contains(blur)).toBe(true);
  expect(blur.className).toBe("zen-header-blur");
  expect(blur.style.pointerEvents).toBe("none");
  expect(blur.getAttribute("aria-hidden")).not.toBeNull();
  expect(blur.querySelectorAll("[class^='zen-header-blur-']").length).toBe(4);
  expect(blur.querySelector(".zen-header-tint")).not.toBeNull();
}

describe("Floating blur headers", () => {
  it("the list header floats over the cards; Done and the tabs still take taps", async () => {
    const onClose = vi.fn();
    render(<TicketsOverlay onClose={onClose} />);
    const header = screen.getByTestId("tickets-header");
    expectBlurHeader(header, screen.getByTestId("tickets-header-blur"));
    expect(screen.getByTestId("overlay-tickets").style.paddingTop).toBe("");

    const tabs = screen.getByTestId("ticket-scopes");
    expect(header.contains(tabs)).toBe(true);
    expect(tabs.style.pointerEvents).toBe("auto");
    const done = within(header).getByRole("button", { name: "Done" });
    expect(done.style.pointerEvents).toBe("auto");

    // Cards start under the header: safe area plus the measured height
    // (jsdom measures 0, so the resting height).
    const scroller = screen.getByTestId("tickets-scroller");
    expect(header.contains(scroller)).toBe(false);
    const pad = scroller.style.paddingTop;
    expect(pad).toMatch(/env\(safe-area-inset-top\)/);
    expect(pad).toContain(`${TICKETS_HEADER_PX}px`);
    await waitFor(() => screen.getByText("Which pricing tier for Acme?"));
    expect(scroller.contains(screen.getAllByTestId("ticket-card")[0])).toBe(true);

    fireEvent.click(screen.getByTestId("scope-all"));
    expect(screen.getByTestId("scope-all").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an open ticket's header floats over the conversation; its menus still work", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    const header = screen.getByTestId("ticket-header");
    expectBlurHeader(header, screen.getByTestId("ticket-header-blur"));
    expect(screen.getByTestId("ticket-view").style.paddingTop).toBe("");
    // Under the brief reader (12) and the sheets (14).
    expect(Number(header.style.zIndex)).toBeLessThan(12);

    expect(screen.getByTestId("ticket-back").style.pointerEvents).toBe("auto");
    expect(screen.getByTestId("ticket-more-wrap").style.pointerEvents).toBe("auto");
    expect(screen.getByTestId("ticket-status-wrap").style.pointerEvents).toBe("auto");
    expect(header.contains(screen.getByTestId("ticket-title"))).toBe(true);

    const scroller = screen.getByTestId("ticket-scroller");
    expect(header.contains(scroller)).toBe(false);
    expect(scroller.style.paddingTop).toMatch(/env\(safe-area-inset-top\)/);
    const pad = Number(scroller.style.paddingTop.match(/(\d+)px/)![1]);
    expect(pad).toBeGreaterThanOrEqual(TICKET_HEADER_PX);
    expect(scroller.contains(screen.getByTestId("ticket-comments"))).toBe(true);

    fireEvent.click(screen.getByTestId("ticket-status"));
    expect(screen.getByTestId("ticket-status-menu")).not.toBeNull();
    fireEvent.click(screen.getByTestId("ticket-more"));
    fireEvent.click(screen.getByTestId("ticket-reassign-item"));
    expect(screen.getByTestId("ticket-reassign")).not.toBeNull();
  });
});

describe("Open ticket — answering", () => {
  it("an option tap sends optionPick:true; free text sends a plain comment", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");

    fireEvent.click(within(screen.getByTestId("answer-card")).getByText("Pro"));
    await waitFor(() => {
      expect(commentFeedback).toHaveBeenCalledWith("t-wait", "Pro", { optionPick: true });
    });

    const input = screen.getByTestId("ticket-composer-input");
    fireEvent.change(input, { target: { value: "Let's talk first" } });
    fireEvent.submit(screen.getByTestId("ticket-composer"));
    await waitFor(() => {
      expect(commentFeedback).toHaveBeenLastCalledWith("t-wait", "Let's talk first");
    });
  });

  it("highlights the accepted pill and shows a delivery miss", async () => {
    serve(ROW, null, { status: "answered", answer: "Business" });
    vi.mocked(commentFeedback).mockResolvedValueOnce({
      ok: true,
      id: "t-wait",
      commentId: "c",
      author: "u",
      delivered: false,
      deliveryReason: "session_gone",
    });
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    const pills = screen.getAllByTestId("answer-pill");
    expect(pills.map((p) => p.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(pills[1].textContent).toBe("✓ Business");
    fireEvent.click(pills[0]);
    await waitFor(() => {
      expect(screen.getByTestId("delivery-miss").textContent).toBe(
        "Saved. The agent did not receive it (session gone)."
      );
    });
  });

  it("comments render as You on the right, others with their name", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    const bubbles = screen.getAllByTestId("ticket-comment");
    expect(bubbles.map((b) => b.getAttribute("data-mine"))).toEqual(["0", "1"]);
    expect(bubbles[0].textContent).toContain("sales");
    expect(bubbles[1].textContent).toContain("You");
  });

  it("the status menu sets planned, and Answered asks what was agreed", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    fireEvent.click(screen.getByTestId("ticket-status"));
    fireEvent.click(screen.getByTestId("status-planned"));
    await waitFor(() => expect(resolveFeedback).toHaveBeenCalledWith("t-wait", "planned"));

    fireEvent.click(screen.getByTestId("ticket-status"));
    fireEvent.click(screen.getByTestId("status-answered"));
    fireEvent.change(screen.getByTestId("agreed-input"), { target: { value: "Pro for a year" } });
    fireEvent.click(screen.getByTestId("agreed-save"));
    await waitFor(() =>
      expect(resolveFeedback).toHaveBeenCalledWith("t-wait", "answered", "Pro for a year")
    );
  });

  it("Reassign posts the checked people", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    fireEvent.click(screen.getByTestId("ticket-more"));
    fireEvent.click(screen.getByTestId("ticket-reassign-item"));
    await waitFor(() => screen.getByText("owner"));
    fireEvent.click(screen.getByText("owner"));
    fireEvent.click(screen.getByTestId("reassign-save"));
    await waitFor(() => expect(assignFeedback).toHaveBeenCalledWith("t-wait", ["u", "owner"]));
  });
});

describe("Open ticket — brief", () => {
  const BRIEF_ROW: FeedbackListRow = { ...ROW, hasBrief: true, briefBytes: 210 };

  it("fetches the brief once, renders it inert, and keeps it across refetches", async () => {
    setRows([BRIEF_ROW]);
    serve(BRIEF_ROW, BRIEF);
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");

    const frame = await waitFor(() => screen.getByTestId("brief-preview-frame"));
    expect(frame.getAttribute("sandbox")).toBe("");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc.indexOf('<meta http-equiv="Content-Security-Policy"')).toBe(
      "<!doctype html><html><head>".length
    );
    expect(srcdoc).not.toMatch(/<script/i);
    expect(srcdoc).not.toMatch(/href=/i);

    // Brief options win over item.options.
    const pills = screen.getAllByTestId("answer-pill").map((p) => p.textContent);
    expect(pills).toEqual(["Starter", "Enterprise"]);

    // Links in this brief → system browser.
    fireEvent.click(screen.getByTestId("brief-link"));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/spec");

    // Refetch (events / poll) and re-open: still exactly one brief=1 fetch.
    await act(async () => {
      await useFeedbackStore.getState().refetchOpen();
    });
    fireEvent.click(screen.getByTestId("ticket-back"));
    await openTicket("Which pricing tier for Acme?");
    const briefCalls = vi
      .mocked(fetchFeedbackShow)
      .mock.calls.filter(([, opts]) => opts?.brief === true);
    expect(briefCalls).toHaveLength(1);
    expect(screen.getByTestId("brief-preview-frame")).not.toBeNull();

    // Read full brief → reader with the frame and pinned answers.
    fireEvent.click(screen.getByTestId("brief-read-full"));
    expect(screen.getByTestId("brief-reader-frame").getAttribute("sandbox")).toBe("");
    expect(within(screen.getByTestId("brief-reader-footer")).getAllByTestId("answer-pill")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("brief-reader-close"));
    expect(screen.queryByTestId("brief-reader")).toBeNull();
  });

  it("falls back to brief.text when the sanitizer is unknown", async () => {
    setRows([BRIEF_ROW]);
    serve(BRIEF_ROW, { ...BRIEF, sha256: "sha-old", sanitizer: "something-else", html: "<script>x()</script>" });
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    const card = await waitFor(() => screen.getByTestId("brief-fallback"));
    expect(card.textContent).toContain("Read the spec.");
    expect(screen.queryByTestId("brief-preview-frame")).toBeNull();
    // No brief options: item.options drive the pills.
    expect(screen.getAllByTestId("answer-pill").map((p) => p.textContent)).toEqual(["Pro", "Business"]);
  });

  it("no brief: the body shows as Summary; no body, no card", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    await openTicket("Which pricing tier for Acme?");
    expect(screen.getByTestId("ticket-summary").textContent).toContain("One-line summary");
    expect(vi.mocked(fetchFeedbackShow).mock.calls.every(([, o]) => !o?.brief)).toBe(true);

    fireEvent.click(screen.getByTestId("ticket-back"));
    const bare = { ...ROW, id: "t-bare", title: "No body here", body: null };
    setRows([bare]);
    serve(bare);
    await waitFor(() => screen.getByText("No body here"));
    await openTicket("No body here");
    expect(screen.queryByTestId("ticket-summary")).toBeNull();
    expect(screen.queryByTestId("brief-card")).toBeNull();
  });
});

describe("Open ticket — unlinked workspace", () => {
  it("is read-only with Resolve and Dismiss only", async () => {
    const gone = { ...ROW, linked: false, projectName: "", projectPath: "" };
    setRows([gone]);
    serve(gone);
    render(<TicketsOverlay onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("scope-all"));
    await openTicket("Which pricing tier for Acme?");
    expect(screen.getByTestId("ticket-unlinked-footer")).not.toBeNull();
    expect(screen.queryByTestId("ticket-composer")).toBeNull();
    expect(screen.queryByTestId("answer-card")).toBeNull();

    fireEvent.click(screen.getByTestId("ticket-status"));
    expect(
      within(screen.getByTestId("ticket-status-menu"))
        .getAllByRole("menuitem")
        .map((m) => m.getAttribute("data-testid"))
    ).toEqual(["status-resolved", "status-dismissed"]);
    fireEvent.click(screen.getByTestId("ticket-status"));

    fireEvent.click(screen.getByTestId("ticket-resolve"));
    await waitFor(() => expect(resolveFeedback).toHaveBeenCalledWith("t-wait", "resolved"));
  });
});
