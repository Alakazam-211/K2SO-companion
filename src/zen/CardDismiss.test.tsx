// @vitest-environment jsdom
// Dismissing a question card on the phone (K2 0.46.11, prd-popup-close-
// and-card-dismiss-v1): Dismiss → optional reason → POST /cli/thread/void;
// closed cards read closed ("Dismissed by …: why", "Withdrawn by <agent>"),
// a daemon close is not drawn, an expired card takes no answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
    voidThreadCard: vi.fn(),
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

import { voidThreadCard } from "../api/client";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { cardAuthorLabel, closedCardLine, normaliseThreadItem, type ThreadMessage } from "./threadModel";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const T0 = 1_700_000_000;
const card = (id: string, seq: number, choice: Record<string, unknown>): ThreadMessage =>
  normaliseThreadItem(
    { id, seq, doc: { id, seq, kind: "choice", from: "aspen", created_at: T0 + seq, choice: { prompt: `Question ${id}?`, options: ["Yes", "No"], ...choice } } },
    "bob"
  )!;

function openRoom(thread: ThreadMessage[]) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "aspen",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "aspen",
    agents: [{ id: "aspen", name: "aspen", initial: "A", path: "/Users/Bob/Aspen", addr: "aspen" }],
    thread,
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
    answeringId: null,
    answerError: null,
    answerErrorId: null,
  });
}

beforeEach(() => {
  setZenScope(fakeScope({ id: "s1", username: "bob" }));
});

afterEach(() => {
  cleanup();
  vi.mocked(voidThreadCard).mockReset();
  vi.restoreAllMocks();
  // @ts-expect-error test cleanup
  delete window.matchMedia;
});

describe("the card model", () => {
  it("reads status, closedAs, closeReason and answeredBy", () => {
    const m = card("c1", 1, {
      status: "voided",
      closedAs: "dismissed",
      closeReason: "  Shipped yesterday ",
      answeredBy: { kind: "user", login: "jamie" },
    });
    expect(m.choice).toMatchObject({
      status: "voided",
      closedAs: "dismissed",
      closeReason: "Shipped yesterday",
      closedBy: { kind: "user", login: "jamie" },
    });
  });

  it("says who as the desktop does", () => {
    expect(cardAuthorLabel({ kind: "user", login: "Bob" }, "bob")).toBe("You");
    expect(cardAuthorLabel({ kind: "owner", login: "owner", name: "Riley" }, "jamie")).toBe("Riley");
    expect(cardAuthorLabel({ kind: "owner", login: "owner" }, "jamie")).toBe("the owner");
    expect(cardAuthorLabel({ kind: "user", login: "jamie" }, "bob")).toBe("jamie");
    expect(closedCardLine("dismissed", "You", "aspen", "Not needed")).toBe("Dismissed by You: Not needed");
    expect(closedCardLine("withdrawn", "You", "aspen")).toBe("Withdrawn by aspen");
  });
});

describe("Dismiss on a waiting card", () => {
  it("asks for an optional reason, posts it, and the card reads closed", async () => {
    openRoom([card("c1", 1, { status: "pending" })]);
    vi.mocked(voidThreadCard).mockResolvedValue({ ok: true, data: {} } as never);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-card-dismiss"));
    expect(screen.getByText("Closes the card without answering. The agent is told; nothing is decided.")).not.toBeNull();
    fireEvent.change(screen.getByTestId("thread-card-dismiss-reason"), { target: { value: "  Not needed any more " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("thread-card-dismiss-confirm"));
    });
    expect(voidThreadCard).toHaveBeenCalledWith(expect.anything(), "aspen", "c1", "Not needed any more");
    await waitFor(() => expect(screen.getByTestId("choice-closed").textContent).toBe("Dismissed by You: Not needed any more"));
    expect(screen.queryByTestId("thread-card-dismiss")).toBeNull();
    for (const b of screen.getAllByRole("button", { name: /^(Yes|No)$/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it("Keep closes the form without posting; no reason sends none", async () => {
    openRoom([card("c1", 1, {})]);
    vi.mocked(voidThreadCard).mockResolvedValue({ ok: true, data: {} } as never);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-card-dismiss"));
    fireEvent.click(screen.getByTestId("thread-card-dismiss-keep"));
    expect(screen.queryByTestId("thread-card-dismiss-form")).toBeNull();
    expect(voidThreadCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("thread-card-dismiss"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("thread-card-dismiss-confirm"));
    });
    expect(voidThreadCard).toHaveBeenCalledWith(expect.anything(), "aspen", "c1", undefined);
  });

  it("a refusal shows on the card in the daemon's words and the card stays open", async () => {
    openRoom([card("c1", 1, { status: "pending" })]);
    vi.mocked(voidThreadCard).mockResolvedValue({ ok: false, error: "card_not_yours" } as never);
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("thread-card-dismiss"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("thread-card-dismiss-confirm"));
    });
    expect(screen.getByTestId("thread-card-dismiss-error").textContent).toBe("card_not_yours");
    expect(screen.queryByTestId("choice-closed")).toBeNull();
  });
});

describe("closed cards", () => {
  it("withdrawn by its agent: dimmed, 'Withdrawn by aspen: why', no Dismiss, no answers", () => {
    openRoom([card("c1", 1, { status: "voided", closedAs: "withdrawn", closeReason: "Asked in the wrong room" })]);
    render(<ThreadPane />);
    expect(screen.getByTestId("choice-closed").textContent).toBe("Withdrawn by aspen: Asked in the wrong room");
    expect(screen.queryByTestId("thread-card-dismiss")).toBeNull();
    expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a daemon close (voided, no closedAs) is not drawn; an expired card takes no answer", () => {
    openRoom([card("c1", 1, { status: "voided" }), card("c2", 2, { status: "expired" })]);
    render(<ThreadPane />);
    expect(screen.queryByText("Question c1?")).toBeNull();
    expect(screen.getByText("Question c2?")).not.toBeNull();
    expect(screen.getByTestId("choice-expired")).not.toBeNull();
    expect(screen.queryByTestId("thread-card-dismiss")).toBeNull();
    expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a live frame closing the card replaces it in place", async () => {
    openRoom([card("c1", 1, { status: "pending" })]);
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-card-dismiss")).not.toBeNull();
    await act(async () => {
      useZenStore.getState().ingestThreadRaw({
        id: "c1",
        seq: 1,
        doc: {
          id: "c1",
          seq: 1,
          kind: "choice",
          from: "aspen",
          created_at: T0 + 1,
          choice: { prompt: "Question c1?", options: ["Yes", "No"], status: "voided", closedAs: "dismissed", answeredBy: { kind: "user", login: "jamie" } },
        },
      } as never);
    });
    expect(screen.getByTestId("choice-closed").textContent).toBe("Dismissed by jamie");
    expect(screen.queryByTestId("thread-card-dismiss")).toBeNull();
  });
});
