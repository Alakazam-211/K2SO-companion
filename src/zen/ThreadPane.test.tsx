// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, uploadFsBinary: vi.fn() };
});

import { uploadFsBinary } from "../api/client";
import { COMPOSER_MAX_PX, ThreadPane, composerHeight } from "./ThreadPane";
import { normaliseThreadItem } from "./threadModel";
import { useZenStore } from "./zenStore";

afterEach(() => {
  cleanup();
  vi.mocked(uploadFsBinary).mockReset();
});

describe("ThreadPane", () => {
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
    expect(screen.getByText(/left/)).not.toBeNull();
    expect(screen.getByText(/right/)).not.toBeNull();
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
});