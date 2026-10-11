// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getFsReadDir: vi.fn(),
  createFsFolder: vi.fn(),
  renameFsEntry: vi.fn(),
  getFsReadFile: vi.fn(async () => ({ ok: true, data: { content: "hi" } })),
  getWorkspaceResources: vi.fn(async () => ({ ok: true, data: { docs: [] } })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroupShow: vi.fn(),
  fetchProjectGroupResources: vi.fn(async () => ({ ok: true, data: { docs: [] } })),
}));

import { getFsReadDir, type FsDirEntry } from "../api/client";
import { FilePane } from "./FilePane";
import { RESOURCES_COLLAPSED_KEY } from "./fileTreeModel";
import { RESOURCES_EMPTY_TITLE } from "./workspaceResources";
import { useZenStore } from "./zenStore";

const WS = "/Users/Baden/Appa";
const entry = (name: string, isDirectory = false): FsDirEntry => ({ name, path: `${WS}/${name}`, isDirectory });

const RESOURCES = [
  { id: `${WS}/docs/plan.md`, name: "plan.md", body: "", hint: "docs" },
  { id: `${WS}/package.json`, name: "package.json", body: "", hint: null },
  { id: `${WS}/Dockerfile`, name: "Dockerfile", body: "", hint: null },
];

function live(files: unknown[] = RESOURCES) {
  useZenStore.setState({
    filesOpen: true,
    fileSource: "live",
    agentSource: "live",
    fileError: null,
    openFileIds: [],
    focusId: null,
    files: files as never,
    groupRoot: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: WS, addr: "appa" }],
  });
}

const iconOf = (row: HTMLElement) => row.querySelector("[data-testid='entry-icon']")?.getAttribute("data-icon");

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getFsReadDir).mockReset();
  vi.mocked(getFsReadDir).mockImplementation(async () => ({
    ok: true,
    data: [entry("src", true), entry("node_modules", true), entry("App.tsx"), entry("notes.md"), entry("weird.zzzz")],
  }));
});

afterEach(() => cleanup());

describe("Workspace Resources section", () => {
  it("is a disclosure with the count, expanded by default", () => {
    live();
    render(<FilePane />);
    const toggle = screen.getByTestId("resources-toggle");
    expect(toggle.textContent).toContain("Workspace Resources");
    expect(screen.getByTestId("resources-count").textContent).toBe("· 3");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("resource-row")).toHaveLength(3);
  });

  it("collapses and expands, and remembers the choice per device", () => {
    live();
    const first = render(<FilePane />);
    fireEvent.click(screen.getByTestId("resources-toggle"));
    expect(screen.getByTestId("resources-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("resource-row")).toHaveLength(0);
    // The count stays on the folded heading.
    expect(screen.getByTestId("resources-count").textContent).toBe("· 3");
    expect(localStorage.getItem(RESOURCES_COLLAPSED_KEY)).toBe("1");

    first.unmount();
    render(<FilePane />);
    expect(screen.getByTestId("resources-toggle").getAttribute("data-state")).toBe("collapsed");
    expect(screen.queryAllByTestId("resource-row")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("resources-toggle"));
    expect(screen.getAllByTestId("resource-row")).toHaveLength(3);
    expect(localStorage.getItem(RESOURCES_COLLAPSED_KEY)).toBe("0");
  });

  it("storage that throws still renders expanded", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      live();
      render(<FilePane />);
      expect(screen.getByTestId("resources-toggle").getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getByTestId("resources-toggle"));
      expect(screen.getByTestId("resources-toggle").getAttribute("aria-expanded")).toBe("false");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("empty: count 0 and the empty note while expanded", () => {
    live([]);
    render(<FilePane />);
    expect(screen.getByTestId("resources-count").textContent).toBe("· 0");
    expect(screen.getByText(RESOURCES_EMPTY_TITLE)).not.toBeNull();
    fireEvent.click(screen.getByTestId("resources-toggle"));
    expect(screen.queryByTestId("resources-empty")).toBeNull();
  });

  it("no count while loading", () => {
    live([]);
    useZenStore.setState({ fileSource: "loading" });
    render(<FilePane />);
    expect(screen.queryByTestId("resources-count")).toBeNull();
  });

  it("a divider sits between resources and the tree, folded or not", async () => {
    live();
    render(<FilePane />);
    await screen.findByTestId("file-tree");
    const divider = () => screen.getByTestId("resources-divider");
    const before = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(divider().getAttribute("role")).toBe("separator");
    expect(divider().getAttribute("style")).toMatch(/--tile-edge/);
    const rows = screen.getAllByTestId("resource-row");
    expect(before(rows[rows.length - 1], divider())).toBe(true);
    expect(before(divider(), screen.getByTestId("files-tree-section"))).toBe(true);
    fireEvent.click(screen.getByTestId("resources-toggle"));
    expect(divider()).not.toBeNull();
    expect(before(divider(), screen.getByTestId("files-tree-section"))).toBe(true);
  });
});

describe("K2 file icons in the drawer", () => {
  it("every resource row has its Seti icon on the left", () => {
    live();
    render(<FilePane />);
    const rows = screen.getAllByTestId("resource-row");
    expect(rows.map(iconOf)).toEqual(["_markdown", "_npm_1", "_docker"]);
    for (const r of rows) {
      const icon = r.querySelector("[data-testid='entry-icon']")!;
      // Left of the name: the first thing in the row.
      expect(r.firstElementChild?.contains(icon)).toBe(true);
      expect((icon as HTMLElement).style.fontFamily).toMatch(/k2-seti/);
    }
  });

  it("every tree row has a file or folder icon, folders open when expanded", async () => {
    live([]);
    render(<FilePane />);
    await screen.findByText("App.tsx");
    const byName = (n: string) =>
      screen.getAllByTestId(/tree-(dir|file)/).find((b) => b.getAttribute("data-file-name") === n)!;
    expect(iconOf(byName("App.tsx"))).toBe("_react");
    expect(iconOf(byName("notes.md"))).toBe("_markdown");
    expect(iconOf(byName("weird.zzzz"))).toBe("_default");
    expect(iconOf(byName("src"))).toBe("folder");
    expect(iconOf(screen.getByTestId("tree-root"))).toBe("folder-open");
    for (const row of screen.getAllByTestId(/tree-(dir|file)/)) expect(iconOf(row)).toBeTruthy();
    fireEvent.click(byName("src"));
    expect(iconOf(byName("src"))).toBe("folder-open");
  });
});
