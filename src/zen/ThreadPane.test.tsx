// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadPane } from "./ThreadPane";
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
    expect(screen.getByPlaceholderText(/not proven/)).not.toBeNull();
  });

  it("labels the composer on stub and live — POST is not proven", () => {
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
    expect(screen.getByPlaceholderText(/POST \/cli\/thread\/post not proven/)).not.toBeNull();
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
      threadError: "no overlay addr",
      thread: [],
    });
    render(<ThreadPane />);
    expect(screen.getByText("no overlay addr")).not.toBeNull();
    expect(screen.queryByTestId("thread-empty")).toBeNull();
  });

  it("composer row is min-w-0 so the pill cannot span the files column", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [],
    });
    render(<ThreadPane />);
    const input = screen.getByPlaceholderText(/not proven/);
    expect(input.className).toMatch(/min-w-0/);
    const pill = input.parentElement;
    expect(pill?.className).toMatch(/min-w-0/);
    expect(pill?.parentElement?.className).toMatch(/min-w-0/);
  });

  it("renders live bubbles without a send control", () => {
    useZenStore.setState({
      threadSource: "live",
      threadError: null,
      thread: [
        {
          id: "m1",
          seq: 1,
          text: "hello from the agent",
          from: "k2so-Skin-Test-A",
          at: 1759198521,
          mine: false,
          kind: "text",
          choice: null,
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByText("hello from the agent")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByPlaceholderText(/not proven/)).not.toBeNull();
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
});