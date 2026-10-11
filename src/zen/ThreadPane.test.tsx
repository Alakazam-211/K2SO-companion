// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    uploadFsBinary: vi.fn(),
    answerThread: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});

vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));

import { act } from "@testing-library/react";
import { answerThread, getThreadActivity, uploadFsBinary } from "../api/client";
import { connectOverlayEvents } from "./overlayEvents";
import { COMPOSER_MAX_PX, ThreadPane, composerHeight, threadTopPadding } from "./ThreadPane";
import { composerPlaceholder } from "./GlassComposer";
import { normaliseThreadItem } from "./threadModel";
import { useZenStore } from "./zenStore";

afterEach(() => {
  cleanup();
  vi.mocked(uploadFsBinary).mockReset();
  vi.mocked(answerThread).mockReset();
  vi.mocked(connectOverlayEvents).mockClear();
  useZenStore.setState({
    threadConversationId: null,
    threadGroupId: null,
    threadAddr: null,
    agentId: "",
    agents: [],
    answeringId: null,
    answerError: null,
    answerErrorId: null,
  });
});

describe("composerPlaceholder", () => {
  it("main chat: Message <Agent>", () => {
    expect(composerPlaceholder({ name: "K2 Companion", addr: "k2c" })).toBe(
      "Message K2 Companion"
    );
  });
  it("sidecar: Message <Agent>/<suffix>, not the renamed title", () => {
    expect(composerPlaceholder({ name: "K2", addr: "k2/reviewer", sidecar: "Renamed" })).toBe(
      "Message K2/reviewer"
    );
  });
  it("main addr with a sidecar title uses the title", () => {
    expect(composerPlaceholder({ name: "K2", addr: "k2", sidecar: "codex" })).toBe(
      "Message K2/codex"
    );
  });
  it("project group: Message <group>", () => {
    expect(composerPlaceholder({ name: "Launch", kind: "group" })).toBe("Message Launch");
  });
  it("falls back to Message", () => {
    expect(composerPlaceholder(null)).toBe("Message");
    expect(composerPlaceholder({ name: "  " })).toBe("Message");
    expect(composerPlaceholder({ name: "—", addr: "k2/1" })).toBe("Message");
  });
});

describe("ThreadPane", () => {
  const live = {
    threadSource: "live" as const,
    threadError: null,
    sendError: null,
    sending: false,
    thread: [],
  };

  it("main chat placeholder: Message <Agent>", () => {
    useZenStore.setState({
      ...live,
      threadAddr: "k2",
      agentId: "a1",
      agents: [{ id: "a1", name: "K2", initial: "K", addr: "k2" }],
    });
    render(<ThreadPane />);
    const input = screen.getByTestId("composer-input");
    expect(input.getAttribute("placeholder")).toBe("Message K2");
    expect(input.getAttribute("aria-label")).toBe("Message K2");
    expect(input.className).toMatch(/placeholder:text-ellipsis/);
  });

  it("sidecar placeholder: Message <Agent>/<sidecar>", () => {
    useZenStore.setState({
      ...live,
      threadAddr: "k2/reviewer",
      agentId: "s1",
      agents: [
        { id: "s1", name: "K2", initial: "K", addr: "k2/reviewer", chatTitle: "Code review" },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe(
      "Message K2/reviewer"
    );
  });

  it("project chat placeholder: Message <group>", () => {
    useZenStore.setState({
      ...live,
      threadAddr: null,
      threadGroupId: "g1",
      agentId: "grp",
      agents: [{ id: "grp", name: "Launch", initial: "L", kind: "group", groupId: "g1" }],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe(
      "Message Launch"
    );
  });

  it("placeholder falls back to Message with no agent", () => {
    useZenStore.setState({ ...live, threadAddr: "k2", agentId: "", agents: [] });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-input").getAttribute("placeholder")).toBe("Message");
  });

  it("renders a structured daemon error as text, not a throw", () => {
    useZenStore.setState({
      threadSource: "error",
      threadError: { code: "not_found", hint: "unknown overlay addr 'k2so-Skin-Test-A'" } as unknown as string,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByText(/unknown overlay addr/)).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByPlaceholderText("Message")).not.toBeNull();
  });

  it("labels the composer on stub — POST is not proven", () => {
    useZenStore.setState({
      threadSource: "stub",
      threadError: null,
      thread: [
        {
          id: "s1",
          seq: 0,
          text: "STUB thread",
          from: "[STUB] not-a-real-agent-1",
          at: null,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-label").textContent).toMatch(
      /STUB — Cannot send — POST \/cli\/thread\/post not proven/
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("live empty thread is labelled No messages, not a blank pane", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-empty").textContent).toBe("No messages");
    expect(screen.queryByText(/unknown overlay addr/)).toBeNull();
  });

  it("error pane does not also say No messages", () => {
    useZenStore.setState({
      threadSource: "error",
      threadError: "Not chattable",
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByText("Not chattable")).not.toBeNull();
    expect(screen.queryByTestId("thread-empty")).toBeNull();
  });

  it("composer row is min-w-0 so the pill cannot span the files column", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    const label = screen.getByTestId("composer-label");
    expect(label.className).toMatch(/break-words/);
    const input = screen.getByPlaceholderText("Message");
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.className).toMatch(/min-w-0/);
    expect(input.className).toMatch(/resize-none/);
    expect(input.className).toMatch(/overflow-x-hidden/);
    expect(input.className).toMatch(/whitespace-pre-wrap/);
    const pill = input.parentElement;
    expect(pill?.className).toMatch(/min-w-0/);
    expect(pill?.className).toMatch(/items-end/);
  });

  it("composer height grows then caps", () => {
    expect(composerHeight(22)).toBe(24);
    expect(composerHeight(88)).toBe(88);
    expect(composerHeight(400)).toBe(COMPOSER_MAX_PX);
  });

  it("a sidecar with a thread GET error can still send", () => {
    useZenStore.setState({
      threadSource: "error",
      threadAddr: "appa/1",
      threadError: "unknown overlay addr 'appa/1'",
      sendError: null,
      sending: false,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Not chattable/);
  });

  it("live thread that is not a test room can send", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "hello from the agent",
          from: "appa",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByText("hello from the agent")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Cannot send/);
  });

  it("live test-room thread shows Send", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "skin-test-a",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "hello from the agent",
          from: "skin-test-a",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Cannot send/);
  });

  it("renders markdown and choice options, not raw asterisks or a blank card", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [
        {
          id: "md",
          seq: 1,
          text: "**bold one**",
          from: "k2so-companion-qa",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
        {
          id: "ch",
          seq: 2,
          text: "",
          from: "k2",
          at: 1759198521,
          mine: false,
          kind: "choice",
          choice: { prompt: "Pick one", options: ["left", "right"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByText("bold one")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/\*\*bold one\*\*/);
    expect(screen.getByText("Pick one")).not.toBeNull();
    expect(screen.getByRole("button", { name: "left" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "right" })).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/Reply is not wired/);
  });

  it("bubbles and the composer follow Settings → Text Size (--zen-text-scale)", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [
        {
          id: "t1",
          seq: 1,
          text: "hello",
          from: "k2",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    const bubble = screen.getByTestId("thread-bubble");
    expect(bubble.getAttribute("style")).toContain("var(--zen-text-scale");
    expect(bubble.querySelector(".chat-markdown")?.getAttribute("style")).toContain(
      "var(--zen-text-scale"
    );
    expect(screen.getByTestId("composer-input").getAttribute("style")).toContain(
      "var(--zen-text-scale"
    );
  });

  it("tapping a choice POSTs /cli/thread/answer with the option text", async () => {
    vi.mocked(answerThread).mockResolvedValue({ ok: true, data: {} });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadError: null,
      threadAddr: "appa",
      threadGroupId: null,
      thread: [
        {
          id: "ch",
          seq: 2,
          text: "",
          from: "appa",
          at: 1759198521,
          mine: false,
          kind: "choice",
          choice: { prompt: "Approve this?", options: ["Yes", "No"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => {
      expect(answerThread).toHaveBeenCalledWith("appa", "ch", "Yes");
    });
    await waitFor(() => {
      expect(screen.getByText("Answered.")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "Yes" })).toHaveProperty("disabled", true);
  });

  it("does not POST a choice on a project chat", () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadError: null,
      threadAddr: null,
      threadGroupId: "g1",
      thread: [
        {
          id: "ch",
          seq: 2,
          text: "",
          from: "appa",
          at: 1,
          mine: false,
          kind: "choice",
          choice: { prompt: "Pick", options: ["A"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(answerThread).not.toHaveBeenCalled();
  });

  it("secret cards have no answer buttons", () => {
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadError: null,
      threadAddr: "appa",
      thread: [
        {
          id: "sec",
          seq: 3,
          text: "Need a secret",
          from: "appa",
          at: 1,
          mine: false,
          kind: "secret",
          choice: { prompt: "Need a secret", options: ["ok"], answer: null },
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.queryByRole("button", { name: "ok" })).toBeNull();
    expect(answerThread).not.toHaveBeenCalled();
  });

  it("renders choice option labels from wire objects, not [object Object]", () => {
    const m = normaliseThreadItem(
      {
        id: "c18",
        seq: 18,
        doc: {
          kind: "choice",
          from: "k2so-companion-qa",
          choice: {
            prompt: "How do you want to sign in?",
            options: [{ label: "Secret" }, { label: "Phone" }, { label: "Hold" }],
          },
        },
      },
      "baden"
    );
    expect(m).not.toBeNull();
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [m!],
    });
    render(<ThreadPane />);
    expect(screen.getByText(/Secret/)).not.toBeNull();
    expect(screen.getByText(/Phone/)).not.toBeNull();
    expect(screen.getByText(/Hold/)).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/\[object Object\]/);
  });

  it("lands the scroller on the newest message on first layout", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? 1800 : 0;
      },
    });
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        {
          id: "old",
          seq: 1,
          text: "oldest",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
        {
          id: "new",
          seq: 19,
          text: "newest",
          from: "appa",
          at: 2,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-scroller").scrollTop).toBe(1800);
    expect(screen.getByText("newest")).not.toBeNull();
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 0;
      },
    });
  });

  it("keyboard resize re-sticks to the newest only when the reader was there", () => {
    let height = 1800;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? height : 0;
      },
    });
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
        { id: "b", seq: 2, text: "two", from: "appa", at: 2, mine: false, kind: "text", choice: null },
      ],
    });
    const { rerender } = render(<ThreadPane viewportHeight={800} />);
    const el = screen.getByTestId("thread-scroller");
    expect(el.scrollTop).toBe(1800);

    // Keyboard opens: the column shrinks, the reader was at the newest.
    height = 2100;
    rerender(<ThreadPane viewportHeight={464} />);
    expect(el.scrollTop).toBe(2100);

    // Reader scrolls up to history: a resize must not yank them down.
    el.scrollTop = 200;
    fireEvent.scroll(el);
    height = 2400;
    rerender(<ThreadPane viewportHeight={800} />);
    expect(el.scrollTop).toBe(200);

    expect(screen.getByTestId("composer-bar").className).toMatch(/zen-composer-bar/);
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 0;
      },
    });
  });

  it("pads the scroller under a floating header and keeps the newest in view when it grows", () => {
    expect(threadTopPadding(undefined)).toBeUndefined();
    expect(threadTopPadding(0)).toBeUndefined();
    expect(threadTopPadding(84)).toBe("calc(env(safe-area-inset-top) + 92px)");

    let height = 1800;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-scroller" ? height : 0;
      },
    });
    useZenStore.setState({
      agentId: "appa",
      threadSource: "live",
      threadError: null,
      threadHasMore: false,
      thread: [
        { id: "a", seq: 1, text: "one", from: "appa", at: 1, mine: false, kind: "text", choice: null },
      ],
    });
    const { rerender } = render(<ThreadPane viewportHeight={800} topInset={84} />);
    const el = screen.getByTestId("thread-scroller");
    expect(el.style.paddingTop).toMatch(/env\(safe-area-inset-top\)/);
    expect(el.style.paddingTop).toMatch(/92px/);
    expect(el.scrollTop).toBe(1800);

    // Sidecar line appears: header grows, padding grows, tail stays stuck.
    height = 1820;
    rerender(<ThreadPane viewportHeight={800} topInset={104} />);
    expect(el.style.paddingTop).toMatch(/112px/);
    expect(el.scrollTop).toBe(1820);

    // Without a floating header the stock padding applies.
    rerender(<ThreadPane viewportHeight={800} />);
    expect(el.style.paddingTop).toBe("");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 0;
      },
    });
  });

  it("outgoing bubbles shrink so a code block cannot clip the left edge", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      thread: [
        {
          id: "m1",
          seq: 0,
          text: "```\n" + "x".repeat(200) + "\n```",
          from: "baden",
          at: 10,
          mine: true,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    const row = document.querySelector("[data-thread-msg]");
    expect(row?.className).toMatch(/min-w-0/);
    expect(row?.className).toMatch(/max-w-\[78%\]/);
  });

  it("a live project chat shows Send", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: null,
      threadGroupId: "pg1",
      threadError: null,
      sendError: null,
      sending: false,
      thread: [
        {
          id: "m1",
          seq: 0,
          text: "hello project",
          from: "owner",
          at: 10,
          mine: true,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.getByPlaceholderText("Message")).toHaveProperty("disabled", false);
    expect(screen.getByTestId("composer-label").textContent).not.toMatch(/Not chattable/);
    expect(screen.getByTestId("composer-attach")).toHaveProperty("disabled", true);
  });

  it("loading hides leftover bubbles", () => {
    useZenStore.setState({
      threadSource: "loading",
      threadError: null,
      thread: [
        {
          id: "stale",
          seq: 1,
          text: "STALE BUBBLE",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("thread-loading").textContent).toMatch(/LOADING thread/);
    expect(screen.queryByText("STALE BUBBLE")).toBeNull();
  });

  it("live workspace thread has an Add file control and paste lands a chip", () => {
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByRole("button", { name: "Add file" })).not.toBeNull();
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: {
        files: [file],
        items: [],
      },
    });
    expect(screen.getByTestId("attach-chip").textContent).toMatch(/shot.png/);
  });

  it("uploads into this agent's own absolute workspace path", async () => {
    vi.mocked(uploadFsBinary).mockResolvedValue({
      ok: true,
      data: { path: "/Users/Baden/Appa/shot.png" },
    });
    const sendThread = vi.fn(async () => {});
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
      sendThread,
    });
    render(<ThreadPane />);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: {
        files: [file],
        items: [],
      },
    });
    fireEvent.submit(screen.getByTestId("composer-form"));
    await waitFor(() => expect(uploadFsBinary).toHaveBeenCalled());
    expect(vi.mocked(uploadFsBinary).mock.calls[0][0]).toBe("appa");
    expect(vi.mocked(uploadFsBinary).mock.calls[0][1]).toBe("/Users/Baden/Appa");
    expect(vi.mocked(uploadFsBinary).mock.calls[0][2]).toBe("shot.png");
    await waitFor(() =>
      expect(sendThread).toHaveBeenCalledWith("/Users/Baden/Appa/shot.png")
    );
  });

  it("does not upload when the agent path is the daemon cwd", async () => {
    const sendThread = vi.fn(async () => {});
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: ".",
          addr: "appa",
        },
      ],
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      sendError: null,
      sending: false,
      thread: [],
      sendThread,
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("composer-attach")).toHaveProperty("disabled", true);
    const file = new File(["x"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: {
        files: [file],
        items: [],
      },
    });
    expect(screen.queryByTestId("attach-chip")).toBeNull();
    expect(uploadFsBinary).not.toHaveBeenCalled();
  });

  it("tapping an @file mention opens that file in the stage", () => {
    useZenStore.setState({
      agentId: "appa",
      agents: [
        {
          id: "appa",
          name: "appa",
          initial: "A",
          path: "/Users/Baden/Appa",
          addr: "appa",
        },
      ],
      fileSource: "live",
      files: [
        { id: "/Users/Baden/Appa/AGENTS.md", name: "AGENTS.md", body: "hi" },
      ],
      openFileIds: [],
      focusId: null,
      filesOpen: false,
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadError: null,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "see @AGENTS.md",
          from: "appa",
          at: 1,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("chat-file-link"));
    expect(useZenStore.getState().openFileIds).toEqual([
      "/Users/Baden/Appa/AGENTS.md",
    ]);
    expect(useZenStore.getState().filesOpen).toBe(true);
  });

  it("opens the overlay events socket for a live conversation", () => {
    const stop = vi.fn();
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop, setViewing: vi.fn() });
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "k2so-companion",
      threadGroupId: null,
      threadConversationId: "conv-live",
      threadError: null,
      thread: [],
    });
    const { unmount } = render(<ThreadPane />);
    expect(connectOverlayEvents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectOverlayEvents).mock.calls[0][0].conversationId).toBe(
      "conv-live"
    );
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("shows the working strip from an activity frame, never as a message", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "k2so-companion",
      threadGroupId: null,
      threadConversationId: "conv-live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const opts = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    const now = Date.now();
    act(() => {
      opts.onItem({
        collection: "activity",
        seq: 0,
        id: "t-1",
        activity: {
          turnId: "t-1",
          state: "working",
          phase: "tool",
          phaseSince: now - 3_000,
          line: "Running `npm test`",
          startedAt: now - 12_000,
          subagents: 1,
          subagentsDone: 0,
          background: 0,
          tally: { read: 2, search: 0, cmd: 1, edit: 0 },
          waitingOn: null,
          end: null,
          serverNow: now,
          rev: 3,
        },
      } as never);
    });
    const strip = screen.getByTestId("thread-working-strip");
    expect(strip.getAttribute("data-tone")).toBe("working");
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Running npm test");
    expect(screen.getByTestId("thread-strip-tally").textContent).toBe(
      "Read 2 files · ran 1 command · 1 subagent running"
    );
    expect(useZenStore.getState().thread).toEqual([]);
    act(() => {
      opts.onItem({
        collection: "activity",
        seq: 0,
        id: "t-1",
        activity: {
          turnId: "t-1",
          state: "idle",
          phase: "working",
          phaseSince: now,
          startedAt: now - 12_000,
          tally: {},
          end: { reason: "reply", detail: null, at: now },
          serverNow: now,
          rev: 4,
        },
      } as never);
    });
    expect(screen.queryByTestId("thread-working-strip")).toBeNull();
  });

  it("re-reads the live turn on every socket open", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    vi.mocked(getThreadActivity).mockClear();
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: "conv-2",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    // No catch-up before the socket: onOpen fires on the first open too.
    expect(getThreadActivity).not.toHaveBeenCalled();
    const now = Date.now();
    vi.mocked(getThreadActivity).mockResolvedValueOnce({
      ok: true,
      data: {
        turn: {
          turnId: "t-9",
          state: "needs-you",
          phase: "waiting",
          phaseSince: now - 5_000,
          startedAt: now - 60_000,
          waitingOn: "permission",
          end: null,
          serverNow: now,
          rev: 2,
        },
      },
    } as never);
    act(() => vi.mocked(connectOverlayEvents).mock.calls[0][0].onOpen?.());
    await waitFor(() => expect(screen.getByTestId("thread-working-strip")).not.toBeNull());
    expect(screen.getByTestId("thread-strip-state").textContent).toBe("Needs you");
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe(
      "Stuck on a permission prompt"
    );
  });

  it("keeps a late {turn:null} catch-up from clearing a newer live turn", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    vi.mocked(getThreadActivity).mockClear();
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: "conv-3",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const now = Date.now();
    let resolveOld: (v: unknown) => void = () => {};
    vi.mocked(getThreadActivity)
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)) as never)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          turn: {
            turnId: "t-5",
            state: "working",
            phase: "working",
            phaseSince: now - 1_000,
            startedAt: now - 9_000,
            end: null,
            serverNow: now,
            rev: 1,
          },
        },
      } as never);
    const opts = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    act(() => opts.onOpen?.());
    act(() => opts.onNeedCatchUp());
    await waitFor(() => expect(screen.getByTestId("thread-working-strip")).not.toBeNull());
    await act(async () => resolveOld({ ok: true, data: { turn: null } }));
    expect(screen.getByTestId("thread-working-strip")).not.toBeNull();
  });

  it("keeps chatter and other non-thread frames out of the message list", async () => {
    vi.mocked(connectOverlayEvents).mockReturnValue({ stop: vi.fn(), setViewing: vi.fn() });
    useZenStore.setState({
      agentSource: "live",
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: "conv-4",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const opts = vi.mocked(connectOverlayEvents).mock.calls[0][0];
    const doc = (id: string, body: string) => ({
      id,
      kind: "text",
      from: "appa",
      to: "owner",
      created_at: 1_760_190_000,
      body,
      via: "thread",
    });
    act(() => {
      opts.onItem({ collection: "chatter", seq: 7, id: "c-1", doc: doc("c-1", "chatter") } as never);
      opts.onItem({ collection: "chatterlog", seq: 8, id: "c-2", doc: doc("c-2", "log") } as never);
    });
    expect(useZenStore.getState().thread).toEqual([]);
    act(() => {
      opts.onItem({ collection: "thread", seq: 9, id: "m-1", doc: doc("m-1", "hello") } as never);
    });
    expect(useZenStore.getState().thread.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("does not open the overlay events socket without a conversation id", () => {
    useZenStore.setState({
      threadSource: "live",
      threadAddr: "appa",
      threadGroupId: null,
      threadConversationId: null,
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    expect(connectOverlayEvents).not.toHaveBeenCalled();
  });

  describe("composer field (iMessage layout)", () => {
    const liveState = () =>
      useZenStore.setState({
        threadSource: "live",
        threadAddr: "skin-test-a",
        threadGroupId: null,
        threadError: null,
        sendError: null,
        sending: false,
        thread: [],
      });

    it("send is disabled with an empty draft and enabled after typing", () => {
      liveState();
      render(<ThreadPane />);
      const send = screen.getByRole("button", { name: "Send" });
      expect(send).toHaveProperty("disabled", true);
      expect(send.getAttribute("type")).toBe("submit");
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "   " } });
      expect(send).toHaveProperty("disabled", true);
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hi" } });
      expect(screen.getByTestId("composer-send")).toHaveProperty("disabled", false);
      expect(screen.getByTestId("composer-send").querySelector("svg")).not.toBeNull();
    });

    it("renders attach, input and send inside the one field", () => {
      liveState();
      render(<ThreadPane />);
      const field = screen.getByTestId("composer-field");
      expect(field.contains(screen.getByTestId("composer-attach"))).toBe(true);
      expect(field.contains(screen.getByTestId("composer-input"))).toBe(true);
      expect(field.contains(screen.getByTestId("composer-send"))).toBe(true);
      expect(screen.getByRole("button", { name: "Add file" })).not.toBeNull();
    });
  });
});