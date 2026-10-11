// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FileStage } from "./FileStage";
import { folderLine } from "./files/FileViewer";
import { STUB_FILES } from "./stubData";
import { useZenStore } from "./zenStore";

const WS = "/Users/Baden/Appa";

beforeEach(() => {
  useZenStore.setState({
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: WS, addr: "appa" }],
    fileSource: "live",
    files: [
      { id: `${WS}/docs/plan.md`, name: "plan.md", body: "# Plan", loaded: true, hint: "docs" },
      { id: `${WS}/AGENTS.md`, name: "AGENTS.md", body: "hi", loaded: true, linked: true },
    ],
    openFileIds: [`${WS}/docs/plan.md`],
    focusId: `${WS}/docs/plan.md`,
    filesOpen: true,
    fileReturn: "chat",
  });
});

afterEach(() => cleanup());

describe("full-screen file viewer", () => {
  it("is a fixed overlay on <body>, not inside the mounting box", () => {
    const { container } = render(<FileStage />);
    const viewer = screen.getByTestId("file-viewer");
    expect(container.contains(viewer)).toBe(false);
    expect(viewer.parentElement).toBe(document.body);
    expect(viewer.className).toContain("fixed");
    expect(viewer.className).toContain("inset-0");
  });

  it("shows the document name top-left with its folder under it", () => {
    render(<FileStage />);
    const header = screen.getByTestId("file-viewer-header");
    const title = screen.getByTestId("file-viewer-title");
    expect(header.firstElementChild).toBe(title);
    expect(screen.getByTestId("file-viewer-name").textContent).toBe("plan.md");
    expect(screen.getByTestId("file-viewer-folder").textContent).toBe("docs");
  });

  it("puts the file's K2 (Seti) icon left of the name", () => {
    render(<FileStage />);
    const icon = screen.getByTestId("file-viewer-icon");
    expect(icon.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("_markdown");
    const name = screen.getByTestId("file-viewer-name");
    expect(icon.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has a round glass close button top-right that closes the file", () => {
    render(<FileStage />);
    const close = screen.getByRole("button", { name: "Close" });
    const header = screen.getByTestId("file-viewer-header");
    const buttons = Array.from(header.querySelectorAll(":scope > button"));
    expect(buttons[buttons.length - 1]).toBe(close);
    expect(close.className).toContain("zen-glass");
    expect(close.className).toContain("zen-glass-pill");
    expect(close.style.width).toBe("34px");
    fireEvent.click(close);
    const s = useZenStore.getState();
    expect(s.openFileIds).toEqual([]);
    // Opened from the chat: closing goes back to the chat.
    expect(s.filesOpen).toBe(false);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });

  it("closing returns to the Files list when it was opened from there", () => {
    useZenStore.setState({ fileReturn: "files" });
    render(<FileStage />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useZenStore.getState().filesOpen).toBe(true);
  });

  it("with two files open, the title menu switches and close shows the one under", () => {
    useZenStore.setState({
      openFileIds: [`${WS}/docs/plan.md`, `${WS}/AGENTS.md`],
      focusId: `${WS}/AGENTS.md`,
    });
    render(<FileStage />);
    expect(screen.queryByTestId("file-viewer-folder")).toBeNull();
    fireEvent.click(screen.getByTestId("file-viewer-title"));
    const menu = screen.getByTestId("file-viewer-menu");
    fireEvent.click(Array.from(menu.querySelectorAll("[role='menuitem']")).find((b) => b.textContent === "plan.md")!);
    expect(useZenStore.getState().focusId).toBe(`${WS}/docs/plan.md`);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useZenStore.getState().focusId).toBe(`${WS}/AGENTS.md`);
  });

  it("offers Source for markdown and not for plain text", () => {
    const { unmount } = render(<FileStage />);
    expect(screen.getByTestId("file-viewer-source").textContent).toBe("Source");
    unmount();
    useZenStore.setState({
      files: [{ id: `${WS}/notes.txt`, name: "notes.txt", body: "x", loaded: true }],
      openFileIds: [`${WS}/notes.txt`],
      focusId: `${WS}/notes.txt`,
    });
    render(<FileStage />);
    expect(screen.queryByTestId("file-viewer-source")).toBeNull();
  });

  it("a stub file keeps its STUB mark; a live one has none", () => {
    useZenStore.setState({
      fileSource: "stub",
      files: STUB_FILES,
      openFileIds: [STUB_FILES[0].id],
      focusId: STUB_FILES[0].id,
    });
    const { unmount } = render(<FileStage />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(1);
    unmount();
    useZenStore.setState({
      fileSource: "live",
      files: [{ id: "/ws/a.md", name: "a.md", body: "x" }],
      openFileIds: ["/ws/a.md"],
      focusId: "/ws/a.md",
    });
    render(<FileStage />);
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
  });

  it("renders nothing with no open file", () => {
    useZenStore.setState({ openFileIds: [], focusId: null });
    render(<FileStage />);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });
});

describe("folderLine", () => {
  it("uses the resource hint, else the folder relative to the workspace", () => {
    expect(folderLine(`${WS}/a/b.md`, "pinned", WS)).toBe("pinned");
    expect(folderLine(`${WS}/src/zen/x.ts`, null, WS)).toBe("src/zen");
    expect(folderLine(`${WS}/AGENTS.md`, null, WS)).toBeNull();
    expect(folderLine("/etc/hosts", null, WS)).toBe("/etc");
    expect(folderLine("stub-id", null, WS)).toBeNull();
  });
});
