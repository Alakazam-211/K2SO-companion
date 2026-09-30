// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

describe("ThreadPane", () => {
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
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByPlaceholderText(/POST \/cli\/thread\/post not proven/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
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
        },
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByText("hello from the agent")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByPlaceholderText(/not proven/)).not.toBeNull();
  });
});