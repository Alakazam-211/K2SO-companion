// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    fetchFeedbackShow: vi.fn(),
    fetchAllFeedback: vi.fn(async () => []),
    fetchTicketUsers: vi.fn(async () => ["owner"]),
    assignFeedback: vi.fn(async () => ({ assignees: [] })),
  };
});

import {
  fetchAllFeedback,
  fetchFeedbackShow,
  resolveFeedback,
  type FeedbackListRow,
  type FeedbackShow,
} from "../api/feedback";
import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { TicketSheet } from "../components/TicketSheet";
import { TicketsOverlay } from "./TicketsOverlay";

const NOW = 1_800_000_000;

const WAITING_ROW: FeedbackListRow = {
  id: "t-wait",
  projectId: "p1",
  sessionId: null,
  sessionKind: null,
  agentName: "skin-test-a",
  kind: "question",
  title: "Close me from overlay",
  body: "body",
  options: null,
  priority: 1,
  status: "waiting",
  answer: null,
  createdAt: NOW - 60,
  updatedAt: NOW - 60,
  answeredAt: null,
  commentCount: 0,
  projectPath: "/tmp/skin",
  projectName: "Skin",
};

function showOf(row: FeedbackListRow, status = row.status): FeedbackShow {
  return {
    ...row,
    status,
    workspace: row.projectName,
    projectPath: row.projectPath,
    comments: [],
  };
}

beforeEach(() => {
  useServersStore.setState({
    servers: [
      {
        id: "s1",
        nickname: "test",
        url: "https://example.k2.dev",
        username: "u",
        rememberPassword: false,
      },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useFeedbackStore.setState({
    rows: [WAITING_ROW],
    waitingCount: 1,
    isLoading: false,
    error: null,
    loadedForServer: "s1",
    openId: null,
    openItem: null,
    openError: null,
  });
  vi.mocked(fetchFeedbackShow).mockResolvedValue(showOf(WAITING_ROW));
  vi.mocked(fetchAllFeedback).mockResolvedValue([WAITING_ROW]);
  vi.mocked(resolveFeedback).mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("TicketsOverlay close", () => {
  it("opens a waiting ticket with Resolve and Dismiss", async () => {
    render(<TicketsOverlay onClose={() => {}} />);
    fireEvent.click(screen.getByText("Close me from overlay"));
    await waitFor(() => {
      expect(screen.getByTestId("overlay-ticket-resolve")).not.toBeNull();
    });
    expect(screen.getByTestId("overlay-ticket-dismiss")).not.toBeNull();
    expect(screen.queryByTestId("overlay-ticket-reopen")).toBeNull();
  });

  it("Resolve posts resolved and the sheet switches to Reopen", async () => {
    vi.mocked(resolveFeedback).mockImplementation(async () => {
      vi.mocked(fetchFeedbackShow).mockResolvedValue(showOf(WAITING_ROW, "resolved"));
      vi.mocked(fetchAllFeedback).mockResolvedValue([
        { ...WAITING_ROW, status: "resolved" },
      ]);
    });
    render(<TicketsOverlay onClose={() => {}} />);
    fireEvent.click(screen.getByText("Close me from overlay"));
    await waitFor(() => screen.getByTestId("overlay-ticket-resolve"));
    fireEvent.click(screen.getByTestId("overlay-ticket-resolve"));
    await waitFor(() => {
      expect(resolveFeedback).toHaveBeenCalledWith("t-wait", "resolved");
      expect(screen.getByTestId("overlay-ticket-reopen")).not.toBeNull();
    });
    expect(screen.queryByTestId("overlay-ticket-resolve")).toBeNull();
  });

  it("ensureLive refetches when this server is already loaded so resolved tickets drop the badge", async () => {
    useFeedbackStore.setState({
      rows: [WAITING_ROW, { ...WAITING_ROW, id: "t-wait-2" }],
      waitingCount: 2,
      loadedForServer: "s1",
    });
    vi.mocked(fetchAllFeedback).mockResolvedValue([
      { ...WAITING_ROW, status: "resolved" },
      { ...WAITING_ROW, id: "t-wait-2", status: "resolved" },
    ]);
    useFeedbackStore.getState().ensureLive();
    await waitFor(() => {
      expect(useFeedbackStore.getState().waitingCount).toBe(0);
    });
  });

  it("a closed ticket shows Reopen, not Resolve", async () => {
    const closed = { ...WAITING_ROW, status: "resolved" as const };
    useFeedbackStore.setState({
      rows: [closed],
      waitingCount: 0,
      openId: closed.id,
      openItem: showOf(closed),
    });
    vi.mocked(fetchFeedbackShow).mockResolvedValue(showOf(closed));
    render(<TicketsOverlay onClose={() => {}} />);
    fireEvent.click(screen.getByText("Close me from overlay"));
    await waitFor(() => screen.getByTestId("overlay-ticket-reopen"));
    expect(screen.queryByTestId("overlay-ticket-resolve")).toBeNull();
  });
});

describe("TicketSheet classic path", () => {
  it("has no Resolve when onSetStatus is omitted", () => {
    render(
      <TicketSheet
        item={showOf(WAITING_ROW)}
        nowSec={NOW}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("overlay-ticket-resolve")).toBeNull();
    expect(screen.queryByTestId("overlay-ticket-dismiss")).toBeNull();
  });
});
