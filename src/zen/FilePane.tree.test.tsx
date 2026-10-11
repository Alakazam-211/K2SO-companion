// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

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

import { createFsFolder, getFsReadDir, renameFsEntry, type FsDirEntry } from "../api/client";
import { fetchProjectGroupShow } from "../api/projectGroups";
import { FilePane } from "./FilePane";
import { GlassComposer } from "./GlassComposer";
import { SHOW_HIDDEN_KEY } from "./fileTreeModel";
import { useFileDrag } from "./fileDrag";
import { useZenStore } from "./zenStore";

const WS = "/Users/Baden/Appa";

const dir = (name: string): FsDirEntry => ({ name, path: `${WS}/${name}`, isDirectory: true });
const file = (name: string, parent = WS): FsDirEntry => ({
  name,
  path: `${parent}/${name}`,
  isDirectory: false,
});

const LISTING: Record<string, FsDirEntry[]> = {
  [WS]: [file("zeta.md"), dir("src"), file(".env"), dir(".git"), dir("node_modules"), file("Alpha.ts"), dir("docs")],
  [`${WS}/src`]: [file("main.ts", `${WS}/src`)],
  [`${WS}/docs`]: [],
};

function rect(left: number, top: number, right: number, bottom: number) {
  return () =>
    ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function live(extra: Record<string, unknown> = {}) {
  useZenStore.setState({
    filesOpen: true,
    fileSource: "live",
    agentSource: "live",
    fileError: null,
    openFileIds: [],
    focusId: null,
    files: [],
    groupRoot: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: WS, addr: "appa" }],
    ...extra,
  });
}

/** FilePane next to a live composer (the Thread's draft). */
function Harness() {
  const [draft, setDraft] = useState("look at");
  return (
    <div>
      <FilePane />
      <GlassComposer value={draft} onChange={setDraft} onSubmit={() => {}} canSend sendReady={false} />
      <output data-testid="draft">{draft}</output>
    </div>
  );
}

const treeFiles = () => screen.getAllByTestId(/tree-(dir|file)/).map((b) => b.getAttribute("data-file-name"));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getFsReadDir).mockReset();
  vi.mocked(getFsReadDir).mockImplementation(async (_scope, p: string) => ({ ok: true, data: LISTING[p] ?? [] }));
  vi.mocked(createFsFolder).mockReset();
  vi.mocked(renameFsEntry).mockReset();
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
  useFileDrag.setState({ drag: null, overComposer: false, pendingInsert: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Files drawer header", () => {
  it("shows Files with the eye and + folder buttons", async () => {
    live();
    render(<FilePane />);
    expect(screen.getByTestId("files-title").textContent).toBe("Files");
    expect(screen.getByLabelText("Show hidden files")).not.toBeNull();
    expect(screen.getByLabelText("New folder")).not.toBeNull();
    expect(screen.getByTestId("files-eye").className).toMatch(/zen-glass/);
    expect(screen.getByTestId("files-new-folder").className).toMatch(/zen-glass/);
    // Workspace Resources stays first, the tree under it.
    expect(screen.getByText("Workspace Resources")).not.toBeNull();
    expect(await screen.findByTestId("file-tree")).not.toBeNull();
  });

  it("the eye shows dotfiles and heavy folders, and remembers per device", async () => {
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    expect(treeFiles()).toEqual(["docs", "src", "Alpha.ts", "zeta.md"]);
    expect(screen.getByTestId("files-eye").getAttribute("data-state")).toBe("hidden");
    fireEvent.click(screen.getByTestId("files-eye"));
    expect(treeFiles()).toEqual([".git", "docs", "node_modules", "src", ".env", "Alpha.ts", "zeta.md"]);
    expect(screen.getByLabelText("Hide hidden files")).not.toBeNull();
    expect(localStorage.getItem(SHOW_HIDDEN_KEY)).toBe("1");
    // Filtered on the phone: one read of the root, with hidden entries.
    expect(getFsReadDir).toHaveBeenCalledTimes(1);
    expect(getFsReadDir).toHaveBeenCalledWith(expect.anything(), WS, true);
    cleanup();
    render(<FilePane />);
    await screen.findByText(".env");
    expect(screen.getByTestId("files-eye").getAttribute("data-state")).toBe("shown");
  });
});

describe("Files tree", () => {
  it("loads lazily, folders first, and a tap opens the file in the viewer", async () => {
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    expect(getFsReadDir).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("main.ts")).toBeNull();
    fireEvent.click(screen.getByLabelText("src"));
    expect(await screen.findByText("main.ts")).not.toBeNull();
    expect(getFsReadDir).toHaveBeenLastCalledWith(expect.anything(), `${WS}/src`, true);
    fireEvent.click(screen.getByLabelText("main.ts"));
    const s = useZenStore.getState();
    expect(s.openFileIds).toEqual([`${WS}/src/main.ts`]);
    expect(s.focusId).toBe(`${WS}/src/main.ts`);
  });

  it("drops entries the daemon returns outside the workspace", async () => {
    live();
    vi.mocked(getFsReadDir).mockImplementation(async () => ({
      ok: true,
      data: [file("ok.md"), { name: "passwd", path: "/etc/passwd", isDirectory: false }],
    }));
    render(<FilePane />);
    await screen.findByText("ok.md");
    expect(screen.queryByText("passwd")).toBeNull();
  });

  it("a project chat roots the tree at its PoC member's workspace", async () => {
    vi.mocked(fetchProjectGroupShow).mockResolvedValue({
      ok: true,
      data: {
        id: "g1",
        name: "Launch",
        pocWorkspaceId: "w-appa",
        pinned: false,
        color: null,
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
        memberCount: 2,
        members: [
          { workspaceId: "w-other", name: "o", path: "/Users/Baden/Other", agentName: null, createdAt: 0 },
          { workspaceId: "w-appa", name: "appa", path: WS, agentName: null, createdAt: 0 },
        ],
      },
    });
    live({
      agentId: "group:g1",
      agents: [{ id: "group:g1", name: "Launch", initial: "L", addr: null, kind: "group", groupId: "g1" }],
    });
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    expect(useZenStore.getState().groupRoot).toBe(WS);
    fireEvent.click(screen.getByLabelText("zeta.md"));
    expect(useZenStore.getState().openFileIds).toEqual([`${WS}/zeta.md`]);
  });
});

describe("+ folder", () => {
  it("creates inside the selected folder, shows the target, refreshes it", async () => {
    live();
    vi.mocked(createFsFolder).mockResolvedValue({ ok: true, data: { success: true } });
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    fireEvent.click(screen.getByLabelText("docs"));
    await waitFor(() => expect(getFsReadDir).toHaveBeenCalledWith(expect.anything(), `${WS}/docs`, true));
    fireEvent.click(screen.getByTestId("files-new-folder"));
    expect(screen.getByTestId("files-sheet-target").getAttribute("data-full")).toBe("Appa/docs");
    fireEvent.change(screen.getByTestId("files-name-input"), { target: { value: "notes" } });
    const before = vi.mocked(getFsReadDir).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("files-name-save"));
    });
    expect(createFsFolder).toHaveBeenCalledWith(expect.anything(), `${WS}/docs/notes`);
    expect(vi.mocked(getFsReadDir).mock.calls.slice(before).map((c) => c[1])).toContain(`${WS}/docs`);
    expect(screen.queryByTestId("files-name-sheet")).toBeNull();
  });

  it("with nothing selected, creates at the workspace root", async () => {
    live();
    vi.mocked(createFsFolder).mockResolvedValue({ ok: true, data: { success: true } });
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    fireEvent.click(screen.getByTestId("files-new-folder"));
    expect(screen.getByTestId("files-sheet-target").getAttribute("data-full")).toBe("Appa");
    fireEvent.change(screen.getByTestId("files-name-input"), { target: { value: "new" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("files-name-save"));
    });
    expect(createFsFolder).toHaveBeenCalledWith(expect.anything(), `${WS}/new`);
  });

  it("validates the name: empty, slashes, duplicates", async () => {
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    fireEvent.click(screen.getByTestId("files-new-folder"));
    await waitFor(() => expect(vi.mocked(getFsReadDir).mock.calls.length).toBeGreaterThan(1));
    const input = screen.getByTestId("files-name-input");
    const save = screen.getByTestId("files-name-save") as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByTestId("files-name-error").textContent).toMatch(/Enter a name/);
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(screen.getByTestId("files-name-error").textContent).toMatch(/slashes/);
    fireEvent.change(input, { target: { value: "SRC" } });
    await waitFor(() =>
      expect(screen.getByTestId("files-name-error").textContent).toMatch(/already here/)
    );
    expect(createFsFolder).not.toHaveBeenCalled();
  });

  it("a server without the create route hides the button (no faking)", async () => {
    live();
    vi.mocked(createFsFolder).mockResolvedValue({ ok: false, status: 404, error: "route not found" });
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    fireEvent.click(screen.getByTestId("files-new-folder"));
    fireEvent.change(screen.getByTestId("files-name-input"), { target: { value: "x" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("files-name-save"));
    });
    expect(screen.queryByTestId("files-new-folder")).toBeNull();
  });
});

async function holdStill(el: HTMLElement) {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
  act(() => {
    vi.advanceTimersByTime(520);
  });
}

describe("press-and-hold menu", () => {
  it("holding still opens exactly Copy Path and Rename (no Insert in message)", async () => {
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    vi.useFakeTimers();
    const row = screen.getByLabelText("Alpha.ts");
    await holdStill(row);
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual(["Copy Path", "Rename"]);
    expect(screen.queryByText(/Insert in message/)).toBeNull();
    // The release after the menu does not open the file.
    fireEvent.pointerUp(row, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.click(row);
    expect(useZenStore.getState().openFileIds).toEqual([]);
  });

  it("folders get the same menu", async () => {
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    vi.useFakeTimers();
    await holdStill(screen.getByLabelText("src"));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy Path", "Rename"]);
  });

  it("Copy Path writes the absolute server path and says Copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    vi.useFakeTimers();
    await holdStill(screen.getByLabelText("Alpha.ts"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("file-menu-copy"));
    });
    expect(writeText).toHaveBeenCalledWith(`${WS}/Alpha.ts`);
    expect(screen.getByTestId("files-toast").textContent).toBe("Copied");
    expect(screen.queryByTestId("file-menu")).toBeNull();
  });

  it("Rename preselects the stem, calls the route, refreshes, follows open tabs", async () => {
    live();
    vi.mocked(renameFsEntry).mockResolvedValue({ ok: true, data: { path: `${WS}/Beta.ts` } });
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    useZenStore.getState().openFileFromPath(`${WS}/Alpha.ts`);
    vi.useFakeTimers();
    await holdStill(screen.getByLabelText("Alpha.ts"));
    fireEvent.click(screen.getByTestId("file-menu-rename"));
    vi.useRealTimers();
    const input = screen.getByTestId("files-name-input") as HTMLInputElement;
    expect(input.value).toBe("Alpha.ts");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
    fireEvent.change(input, { target: { value: "Beta.ts" } });
    const before = vi.mocked(getFsReadDir).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("files-name-save"));
    });
    expect(renameFsEntry).toHaveBeenCalledWith(expect.anything(), `${WS}/Alpha.ts`, "Beta.ts");
    expect(vi.mocked(getFsReadDir).mock.calls.slice(before).map((c) => c[1])).toContain(WS);
    expect(useZenStore.getState().openFileIds).toEqual([`${WS}/Beta.ts`]);
  });

  it("rename validation refuses a sibling's name and the same name", async () => {
    live();
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    vi.useFakeTimers();
    await holdStill(screen.getByLabelText("Alpha.ts"));
    fireEvent.click(screen.getByTestId("file-menu-rename"));
    vi.useRealTimers();
    const input = screen.getByTestId("files-name-input");
    fireEvent.change(input, { target: { value: "zeta.md" } });
    await waitFor(() =>
      expect(screen.getByTestId("files-name-error").textContent).toMatch(/already here/)
    );
    fireEvent.change(input, { target: { value: "Alpha.ts" } });
    expect(screen.getByTestId("files-name-error").textContent).toMatch(/current name/);
    fireEvent.change(input, { target: { value: "x/y" } });
    expect(screen.getByTestId("files-name-error").textContent).toMatch(/slashes/);
    expect(renameFsEntry).not.toHaveBeenCalled();
  });

  it("Workspace Resources rows get the same menu", async () => {
    live({ files: [{ id: `${WS}/docs/plan.md`, name: "plan.md", body: "", hint: "docs" }] });
    render(<FilePane />);
    await screen.findByText("Alpha.ts");
    vi.useFakeTimers();
    await holdStill(screen.getByTestId("resource-row"));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Copy Path", "Rename"]);
  });
});

describe("drag a file into the chat", () => {
  async function mountWithComposer() {
    live();
    render(<Harness />);
    await screen.findByText("Alpha.ts");
    screen.getByTestId("composer-field").getBoundingClientRect = rect(0, 700, 400, 750);
  }

  it("hold, then move lifts a ghost; dropping on the composer inserts the reference", async () => {
    await mountWithComposer();
    vi.useFakeTimers();
    const row = screen.getByLabelText("Alpha.ts");
    fireEvent.pointerDown(row, { clientX: 300, clientY: 100, button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerMove(row, { clientX: 300, clientY: 140, pointerId: 1 });
    expect(screen.getByTestId("file-drag-ghost").textContent).toMatch("Alpha.ts");
    // No menu: moving after the hold is a drag.
    expect(screen.queryByTestId("file-menu")).toBeNull();
    fireEvent.pointerMove(row, { clientX: 200, clientY: 720, pointerId: 1 });
    expect(screen.getByTestId("composer-field").getAttribute("data-drop-target")).toBe("hot");
    fireEvent.pointerUp(row, { clientX: 200, clientY: 720, pointerId: 1 });
    expect(screen.getByTestId("draft").textContent).toBe("look at `Alpha.ts` ");
    expect(screen.queryByTestId("file-drag-ghost")).toBeNull();
    // The release did not also open the file.
    fireEvent.click(row);
    expect(useZenStore.getState().openFileIds).toEqual([]);
  });

  it("a drop anywhere else cancels", async () => {
    await mountWithComposer();
    vi.useFakeTimers();
    const row = screen.getByLabelText("zeta.md");
    fireEvent.pointerDown(row, { clientX: 300, clientY: 100, button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerMove(row, { clientX: 300, clientY: 160, pointerId: 1 });
    expect(screen.getByTestId("file-drag-ghost")).not.toBeNull();
    fireEvent.pointerUp(row, { clientX: 200, clientY: 300, pointerId: 1 });
    expect(screen.getByTestId("draft").textContent).toBe("look at");
    expect(screen.queryByTestId("file-drag-ghost")).toBeNull();
  });

  it("moving before the hold arms is a scroll, not a drag", async () => {
    await mountWithComposer();
    vi.useFakeTimers();
    const row = screen.getByLabelText("zeta.md");
    fireEvent.pointerDown(row, { clientX: 300, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 300, clientY: 160, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId("file-drag-ghost")).toBeNull();
    expect(screen.queryByTestId("file-menu")).toBeNull();
  });

  it("a Workspace Resource drags in too", async () => {
    live({ files: [{ id: `${WS}/docs/plan.md`, name: "plan.md", body: "", hint: "docs" }] });
    render(<Harness />);
    await screen.findByText("Alpha.ts");
    screen.getByTestId("composer-field").getBoundingClientRect = rect(0, 700, 400, 750);
    vi.useFakeTimers();
    const row = screen.getByTestId("resource-row");
    fireEvent.pointerDown(row, { clientX: 300, clientY: 100, button: 0, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.pointerMove(row, { clientX: 250, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(row, { clientX: 200, clientY: 720, pointerId: 1 });
    expect(screen.getByTestId("draft").textContent).toBe("look at `docs/plan.md` ");
  });
});
