// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FilePane } from "./FilePane";
import { STUB_FILES } from "./stubData";
import { RESOURCES_EMPTY_LINE, RESOURCES_EMPTY_TITLE } from "./workspaceResources";
import { useZenStore } from "./zenStore";

afterEach(() => cleanup());

describe("FilePane stub markers", () => {
  it("renders nothing when the files pane is closed — no side bar", () => {
    useZenStore.setState({
      filesOpen: false,
      fileSource: "live",
      files: STUB_FILES,
      fileError: null,
    });
    const { container } = render(<FilePane />);
    expect(container.textContent).toBe("");
    expect(screen.queryByLabelText(/View Files/i)).toBeNull();
    expect(screen.queryByLabelText(/STUB files/i)).toBeNull();
  });

  it("each stub file row carries its own STUB mark", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "stub",
      files: STUB_FILES,
      fileError: null,
      openFileIds: [],
    });
    render(<FilePane />);
    const marks = document.querySelectorAll("[data-stub='true']");
    expect(marks.length).toBe(STUB_FILES.length);
  });

  it("loading does not say LIVE or empty", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "loading",
      files: [],
      fileError: null,
      openFileIds: [],
    });
    render(<FilePane />);
    expect(screen.getByText("LOADING resources")).not.toBeNull();
    expect(screen.getByText("loading")).not.toBeNull();
    expect(screen.queryByText("Workspace Resources")).toBeNull();
    expect(screen.queryByText("empty")).toBeNull();
    expect(screen.queryByTestId("resources-empty")).toBeNull();
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
  });

  it("live read fail shows the error and no stub rows", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "error",
      files: [],
      fileError: "HTTP 500",
      openFileIds: [],
    });
    render(<FilePane />);
    expect(screen.getByText("HTTP 500")).not.toBeNull();
    expect(screen.queryByTestId("resources-empty")).toBeNull();
    expect(document.querySelectorAll("[data-stub='true']").length).toBe(0);
    expect(screen.queryByText(/not-a-real-file/)).toBeNull();
  });
});

describe("FilePane lists Workspace Resources", () => {
  const WS = "/Users/Baden/Appa";

  it("renders each resource with its folder, not a directory listing", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "live",
      fileError: null,
      openFileIds: [],
      files: [
        { id: `${WS}/docs/plan.md`, name: "plan.md", body: "", hint: "docs" },
        { id: `${WS}/AGENTS.md`, name: "AGENTS.md", body: "", hint: null },
      ],
    });
    render(<FilePane />);
    expect(screen.getByText("Workspace Resources")).not.toBeNull();
    expect(screen.getByText("plan.md")).not.toBeNull();
    expect(screen.getByText("docs")).not.toBeNull();
    expect(screen.getByText("AGENTS.md")).not.toBeNull();
    expect(screen.queryByTestId("resources-empty")).toBeNull();
  });

  it("a missing resource reads Unavailable and cannot be opened", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "live",
      fileError: null,
      openFileIds: [],
      focusId: null,
      agentId: "appa",
      agents: [{ id: "appa", name: "appa", initial: "A", path: WS, addr: "appa" }],
      files: [{ id: `${WS}/gone.md`, name: "gone.md", body: "", missing: true }],
    });
    render(<FilePane />);
    const row = screen.getByText("gone.md").closest("button")!;
    expect(screen.getByText("Unavailable")).not.toBeNull();
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    useZenStore.getState().openFile(`${WS}/gone.md`);
    expect(useZenStore.getState().openFileIds).toEqual([]);
  });

  it("no resources shows the ask-your-agent note", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "live",
      fileError: null,
      openFileIds: [],
      files: [],
    });
    render(<FilePane />);
    expect(screen.getByTestId("resources-empty").className).toMatch(/k2-tile/);
    expect(screen.getByText(RESOURCES_EMPTY_TITLE)).not.toBeNull();
    expect(screen.getByText(RESOURCES_EMPTY_LINE)).not.toBeNull();
    expect(RESOURCES_EMPTY_LINE).toBe(
      "Ask your agent to add files to Workspace Resources to see them here."
    );
  });

  it("a file opened from a chat link is not listed as a resource", () => {
    useZenStore.setState({
      filesOpen: true,
      fileSource: "live",
      fileError: null,
      openFileIds: [`${WS}/src/x.ts`],
      files: [{ id: `${WS}/src/x.ts`, name: "x.ts", body: "", linked: true }],
    });
    render(<FilePane />);
    expect(screen.queryByText("x.ts")).toBeNull();
    expect(screen.getByText(RESOURCES_EMPTY_TITLE)).not.toBeNull();
  });
});
