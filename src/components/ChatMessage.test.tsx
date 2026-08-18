// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage, ChatMessageBody } from "./ChatMessage";

describe("ChatMessageBody", () => {
  it("renders markdown lists, emphasis, and code", () => {
    render(
      <ChatMessageBody text={"**Hello**\n\n- one\n- two\n\n`code`"} />,
    );
    expect(screen.getByText("Hello").tagName).toBe("STRONG");
    expect(screen.getByText("one").closest("li")).not.toBeNull();
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("renders a fenced code block", () => {
    render(<ChatMessageBody text={"```\nconst x = 1\n```"} />);
    expect(screen.getByText("const x = 1")).not.toBeNull();
    expect(document.querySelector("pre")).not.toBeNull();
  });
});

describe("ChatMessage", () => {
  it("labels the owner as given (You) and others by author", () => {
    const { rerender } = render(
      <ChatMessage
        author="You"
        isOwner
        timeLabel="now"
        body="mine"
      />,
    );
    expect(screen.getByText("You")).not.toBeNull();
    rerender(
      <ChatMessage
        author="k2-agent"
        isOwner={false}
        timeLabel="1m"
        body="theirs"
      />,
    );
    expect(screen.getByText("k2-agent")).not.toBeNull();
  });
});
