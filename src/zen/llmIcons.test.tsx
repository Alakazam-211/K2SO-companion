// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { llmIconId, llmIconSvg } from "./llmIcons";
import { LlmIcon } from "./LlmIcon";

afterEach(cleanup);

describe("llmIconId", () => {
  it.each([
    ["claude", "claude"],
    ["codex", "codex"],
    ["gemini", "gemini"],
    ["grok", "grok"],
    ["cursor", "cursor"],
    ["cursor-agent", "cursor"],
    ["Cursor Agent", "cursor"],
    ["copilot", "copilot"],
    ["goose", "goose"],
    ["ollama", "ollama"],
    ["opencode", "opencode"],
    ["OpenCode", "opencode"],
    ["interpreter", "interpreter"],
    ["hermes", "hermes"],
    ["aider", "aider"],
    ["pi", "pi"],
    ["Claude Code", "claude"],
  ])("%s → %s", (harness, id) => {
    expect(llmIconId(harness)).toBe(id);
    expect(llmIconSvg(harness)).toMatch(/^<svg/);
  });

  it("falls back to null for shells, unknown programs and pi look-alikes", () => {
    for (const h of [null, undefined, "", "zsh", "shell", "clawg", "api", "gemmapi", "spike"]) {
      expect(llmIconId(h)).toBeNull();
      expect(llmIconSvg(h)).toBeNull();
    }
  });
});

describe("LlmIcon", () => {
  it("inlines the mark at 20px", () => {
    render(<LlmIcon harness="grok" />);
    const el = screen.getByTestId("llm-icon");
    expect(el.getAttribute("data-llm")).toBe("grok");
    expect(el.style.width).toBe("20px");
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("shows >_ when there is no mark", () => {
    render(<LlmIcon harness={null} />);
    const el = screen.getByTestId("llm-icon");
    expect(el.getAttribute("data-llm")).toBe("shell");
    expect(el.querySelector("polyline")).not.toBeNull();
  });

  it("shows a custom preset's emoji", () => {
    render(<LlmIcon harness="clawg" emoji="🦀" />);
    const el = screen.getByTestId("llm-icon");
    expect(el.getAttribute("data-llm")).toBe("emoji");
    expect(el.textContent).toBe("🦀");
  });
});
