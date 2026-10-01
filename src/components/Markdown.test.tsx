// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import remarkGfm from "remark-gfm";
import Markdown from "./Markdown";

vi.mock("../lib/openExternal", () => ({
  openExternal: vi.fn(),
}));

import { openExternal } from "../lib/openExternal";

afterEach(() => {
  cleanup();
  vi.mocked(openExternal).mockReset();
});

describe("Markdown links", () => {
  it("opens an http(s) link in the browser", () => {
    render(
      <Markdown remarkPlugins={[remarkGfm]}>
        {"see https://k2.dev/docs please"}
      </Markdown>
    );
    const a = screen.getByTestId("chat-web-link");
    expect(a.getAttribute("href")).toBe("https://k2.dev/docs");
    fireEvent.click(a);
    expect(openExternal).toHaveBeenCalledWith("https://k2.dev/docs");
  });

  it("opens a markdown file link via onFileLink", () => {
    const onFileLink = vi.fn();
    render(
      <Markdown remarkPlugins={[remarkGfm]} onFileLink={onFileLink}>
        {"open [AGENTS.md](AGENTS.md)"}
      </Markdown>
    );
    fireEvent.click(screen.getByTestId("chat-file-link"));
    expect(onFileLink).toHaveBeenCalledWith("AGENTS.md");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens an inline backtick path via onFileLink", () => {
    const onFileLink = vi.fn();
    render(
      <Markdown remarkPlugins={[remarkGfm]} onFileLink={onFileLink}>
        {"see `src/zen/ThreadPane.tsx`"}
      </Markdown>
    );
    fireEvent.click(screen.getByTestId("chat-file-ref"));
    expect(onFileLink).toHaveBeenCalledWith("src/zen/ThreadPane.tsx");
  });
});
