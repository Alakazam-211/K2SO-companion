// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(async () => ({ ok: true, data: [] })),
}));

vi.mock("../api/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/feedback")>();
  return {
    ...actual,
    commentFeedback: vi.fn(async () => ({ ok: true, id: "t", commentId: "c", author: "u", answered: true, delivered: true })),
    fetchFeedbackShow: vi.fn(),
    fetchAllFeedback: vi.fn(async () => []),
    fetchTicketUsers: vi.fn(async () => ["owner"]),
    resolveFeedback: vi.fn(async () => undefined),
  };
});

import { commentFeedback, fetchFeedbackShow, type FeedbackShow } from "../api/feedback";
import { useFeedbackStore } from "../stores/feedback";
import { useServersStore } from "../stores/servers";
import { FeedbackThread } from "./FeedbackThread";

const SHOW: FeedbackShow = {
  id: "t1",
  projectId: "p",
  sessionId: null,
  sessionKind: null,
  agentName: "sales",
  kind: "question",
  title: "Which tier?",
  body: null,
  options: ["Pro", "Business"],
  priority: 3,
  status: "needs_discussion",
  answer: null,
  createdAt: 1,
  updatedAt: 1,
  answeredAt: null,
  commentCount: 0,
  assignees: [],
  workspace: "K2",
  projectPath: "/k2",
  comments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "t", url: "https://x.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t" },
  });
  useFeedbackStore.setState({ rows: [], openId: null, openItem: null, openError: null, briefs: {} });
  vi.mocked(fetchFeedbackShow).mockResolvedValue(SHOW);
});

afterEach(() => cleanup());

describe("classic FeedbackThread", () => {
  it("option taps answer with optionPick (live while needs_discussion)", async () => {
    render(
      <MemoryRouter initialEntries={["/feedback/t1"]}>
        <Routes>
          <Route path="/feedback/:id" element={<FeedbackThread />} />
        </Routes>
      </MemoryRouter>
    );
    const pro = await waitFor(() => screen.getByRole("button", { name: "Pro" }));
    expect((pro as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pro);
    await waitFor(() => {
      expect(commentFeedback).toHaveBeenCalledWith("t1", "Pro", { optionPick: true });
    });
  });
});
