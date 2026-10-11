// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  createWorkspace: vi.fn(),
  getFsInfo: vi.fn(async () => ({ ok: true, data: { home: "/Users/r", separator: "/", os: "macos" } })),
  updateProjectLook: vi.fn(async () => ({ ok: true, data: {} })),
  assignFocusGroup: vi.fn(async () => ({ ok: true, data: {} })),
  ensurePinnedChat: vi.fn(async () => ({ ok: true, data: { sessionId: "s1" } })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(),
  postProjectGroupMessage: vi.fn(),
}));

import {
  assignFocusGroup,
  createWorkspace,
  ensurePinnedChat,
  getFsInfo,
  updateProjectLook,
} from "../api/client";
import { NewWorkspaceSheet } from "./NewWorkspaceSheet";
import type { StubAgent } from "./stubData";
import { FOCUS_OFF } from "./serverPins";
import { useZenStore } from "./zenStore";

const original = useZenStore.getState();

function agent(path: string, addr: string | null, extra: Partial<StubAgent> = {}): StubAgent {
  const name = path.split("/").pop() || path;
  return { id: path, name, initial: name[0].toUpperCase(), path, addr, kind: "agent", ...extra } as StubAgent;
}

const EXISTING = [agent("/Users/r/Dev/alpha", "alpha"), agent("/Users/r/Dev/bravo", "bravo")];

let setAgent: ReturnType<typeof vi.fn>;
let hydrate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(createWorkspace).mockReset();
  vi.mocked(updateProjectLook).mockClear();
  vi.mocked(assignFocusGroup).mockClear();
  vi.mocked(ensurePinnedChat).mockClear();
  vi.mocked(getFsInfo).mockClear();
  setAgent = vi.fn();
  hydrate = vi.fn(async () => {
    useZenStore.setState({
      agents: [...EXISTING, agent("/Users/r/Dev/my-project", "my-project")],
    });
  });
  useZenStore.setState({
    agentSource: "live",
    agents: EXISTING,
    serverProjects: [],
    focus: FOCUS_OFF,
    screen: "list",
    setAgent,
    hydrateAgents: hydrate,
  });
});

afterEach(() => {
  cleanup();
  useZenStore.setState({
    setAgent: original.setAgent,
    hydrateAgents: original.hydrateAgents,
    agents: [],
    focus: FOCUS_OFF,
  });
});

function typeName(v: string) {
  fireEvent.change(screen.getByTestId("new-workspace-name"), { target: { value: v } });
}

describe("NewWorkspaceSheet", () => {
  it("previews the folder slug and full path under the default parent", () => {
    render(<NewWorkspaceSheet onClose={() => {}} />);
    expect((screen.getByTestId("new-workspace-parent") as HTMLInputElement).value).toBe(
      "/Users/r/Dev"
    );
    typeName("My Project");
    expect(screen.getByTestId("new-workspace-slug").textContent).toBe("Folder: my-project");
    expect(screen.getByTestId("new-workspace-path").textContent).toBe("/Users/r/Dev/my-project");
    expect(getFsInfo).not.toHaveBeenCalled();
  });

  it("asks the host for home when no workspace gives a parent", async () => {
    useZenStore.setState({ agents: [] });
    render(<NewWorkspaceSheet onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByTestId("new-workspace-parent") as HTMLInputElement).value).toBe("/Users/r")
    );
    typeName("x");
    expect(screen.getByTestId("new-workspace-path").textContent).toBe("/Users/r/x");
  });

  it("create posts the path, names it, starts the main chat, refreshes and lands in the thread", async () => {
    vi.mocked(createWorkspace).mockResolvedValue({
      ok: true,
      data: { success: true, projectId: "p9", path: "/Users/r/Dev/my-project", name: "my-project" },
    });
    const onClose = vi.fn();
    const onListed = vi.fn();
    render(<NewWorkspaceSheet onClose={onClose} onListed={onListed} />);
    typeName("My Project");
    fireEvent.click(screen.getByTestId("new-workspace-color-22c55e"));
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    expect(screen.getByTestId("new-workspace-create").textContent).toBe("Creating…");
    await waitFor(() => expect(setAgent).toHaveBeenCalledWith("/Users/r/Dev/my-project"));
    expect(createWorkspace).toHaveBeenCalledWith("/Users/r/Dev/my-project");
    expect(updateProjectLook).toHaveBeenCalledWith("p9", { name: "My Project", color: "#22c55e" });
    expect(ensurePinnedChat).toHaveBeenCalledWith("/Users/r/Dev/my-project");
    expect(hydrate).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(onListed).not.toHaveBeenCalled();
    expect(assignFocusGroup).not.toHaveBeenCalled();
  });

  it("a slug name with the default colour sends no update", async () => {
    vi.mocked(createWorkspace).mockResolvedValue({ ok: true, data: { projectId: "p9" } });
    render(<NewWorkspaceSheet onClose={() => {}} />);
    typeName("my-project");
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    await waitFor(() => expect(setAgent).toHaveBeenCalled());
    expect(updateProjectLook).not.toHaveBeenCalled();
  });

  it("assigns the picked focus group when groups are on (current group by default)", async () => {
    useZenStore.setState({
      focus: {
        enabled: true,
        currentId: "g1",
        groups: [
          { id: "g1", name: "Work", color: null },
          { id: "g2", name: "Home", color: null },
        ],
      },
    });
    vi.mocked(createWorkspace).mockResolvedValue({ ok: true, data: { projectId: "p9" } });
    render(<NewWorkspaceSheet onClose={() => {}} />);
    expect(screen.getByTestId("new-workspace-group-g1").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("new-workspace-group-g2"));
    typeName("my-project");
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    await waitFor(() => expect(setAgent).toHaveBeenCalled());
    expect(assignFocusGroup).toHaveBeenCalledWith("p9", "g2");
  });

  it("lands on the list with the row highlighted when the new row is not chattable", async () => {
    hydrate.mockImplementation(async () => {
      useZenStore.setState({
        agents: [...EXISTING, agent("/Users/r/Dev/my-project", null, { joinMiss: "no handle" })],
      });
    });
    vi.mocked(createWorkspace).mockResolvedValue({ ok: true, data: { projectId: "p9" } });
    const onListed = vi.fn();
    render(<NewWorkspaceSheet onClose={() => {}} onListed={onListed} />);
    typeName("my-project");
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    await waitFor(() => expect(onListed).toHaveBeenCalledWith("/Users/r/Dev/my-project"));
    expect(setAgent).not.toHaveBeenCalled();
  });

  it("shows daemon refusals inline and stays open", async () => {
    vi.mocked(createWorkspace).mockResolvedValue({
      ok: false,
      error: "Directory already exists: /Users/r/Dev/my-project",
      status: 400,
    });
    const onClose = vi.fn();
    render(<NewWorkspaceSheet onClose={onClose} />);
    typeName("my-project");
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    await waitFor(() =>
      expect(screen.getByTestId("new-workspace-error").textContent).toMatch(/folder already exists/)
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(ensurePinnedChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-workspace-create").textContent).toBe("Create");

    vi.mocked(createWorkspace).mockResolvedValue({ ok: false, error: "role_required", status: 403 });
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    await waitFor(() =>
      expect(screen.getByTestId("new-workspace-error").textContent).toMatch(/can’t create workspaces/)
    );
  });

  it("blocks invalid names and existing paths before calling the server", () => {
    render(<NewWorkspaceSheet onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    expect(screen.getByTestId("new-workspace-error").textContent).toBe("Enter a name");
    typeName("a/b");
    expect(screen.getByTestId("new-workspace-error").textContent).toMatch(/letters or numbers/);
    typeName("Alpha");
    expect(screen.getByTestId("new-workspace-error").textContent).toBe(
      "A workspace already uses /Users/r/Dev/alpha"
    );
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    fireEvent.change(screen.getByTestId("new-workspace-parent"), { target: { value: "Dev" } });
    typeName("fresh");
    expect(screen.getByTestId("new-workspace-error").textContent).toMatch(/full path/);
    fireEvent.click(screen.getByTestId("new-workspace-create"));
    expect(createWorkspace).not.toHaveBeenCalled();
  });
});
