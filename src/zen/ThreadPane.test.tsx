// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadPane } from "./ThreadPane";
import { normaliseThreadItem } from "./threadModel";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

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
    expect(input.className).toMatch(/min-w-0/);
    const pill = input.parentElement;
    expect(pill?.className).toMatch(/min-w-0/);
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
});