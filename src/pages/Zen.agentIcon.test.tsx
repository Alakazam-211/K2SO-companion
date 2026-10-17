// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api/client", () => ({
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(async () => ({ ok: true, data: {} })),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setProjectPinned: vi.fn(async () => ({ ok: true, data: {} })),
  reorderProjects: vi.fn(async () => ({ ok: true, data: {} })),
  getAppSettings: vi.fn(async () => ({ ok: true, data: {} })),
  getFocusGroupsList: vi.fn(async () => ({ ok: true, data: [] })),
  updateProjectLook: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({ ok: true, data: { messages: [], truncated: false } })),
  postProjectGroupMessage: vi.fn(),
}));

const who = vi.hoisted(() => ({
  identity: { username: "u", owner: false, role: "member" } as {
    username: string;
    owner: boolean;
    role?: string | null;
  } | null,
}));
vi.mock("../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => who.identity,
}));

import { getCliProjectsList, updateProjectLook } from "../api/client";
import { useServersStore } from "../stores/servers";
import type { ServerProject } from "../zen/serverPins";
import type { StubAgent } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

const ICON = "data:image/png;base64,OLD";
const SQUARE = "data:image/png;base64,SQUARE256";

const main: StubAgent = {
  id: "/w/alpha",
  name: "Alpha",
  initial: "A",
  path: "/w/alpha",
  addr: "alpha",
  joinMiss: null,
  kind: "agent",
  color: "#3b82f6",
  iconUrl: null,
};
const side: StubAgent = {
  ...main,
  id: "/w/alpha::alpha/notes",
  name: "Alpha",
  addr: "alpha/notes",
  chatTitle: "notes",
};
const other: StubAgent = { ...main, id: "/w/beta", name: "Beta", path: "/w/beta", addr: "beta", color: "#ef4444" };
const projects: ServerProject[] = [
  { id: "p-alpha", name: "Alpha", path: "/w/alpha", handle: "alpha", pinned: false, tabOrder: 0, focusGroupId: null },
  { id: "p-beta", name: "Beta", path: "/w/beta", handle: "beta", pinned: false, tabOrder: 1, focusGroupId: null },
];

let drawImage: ReturnType<typeof vi.fn>;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1200;
  naturalHeight = 900;
  width = 1200;
  height = 900;
  set src(_v: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

beforeEach(() => {
  // Flag-off parity: `zen.multiServer` now defaults on; pin it off.
  useMultiServerPrefs.setState({ multiServer: false });
  who.identity = { username: "u", owner: false, role: "member" };
  vi.mocked(updateProjectLook).mockReset();
  vi.mocked(getCliProjectsList).mockReset();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    // Signed out (the old `getToken` mock returned ""): the list stays stub.
    tokens: {},
    recovery: { s1: "connected" },
  });
  drawImage = vi.fn();
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(SQUARE);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openChat(agentId: string, agents: StubAgent[] = [main, side, other]) {
  render(
    <MemoryRouter>
      <Zen />
    </MemoryRouter>
  );
  await waitFor(() => expect(useZenStore.getState().agentSource).toBe("stub"));
  act(() => {
    useZenStore.setState({ agents, serverProjects: projects, screen: "thread", agentId });
  });
}

function rowById(id: string) {
  return useZenStore.getState().agents.find((a) => a.id === id)!;
}

async function pickPhoto() {
  const input = screen.getByTestId("agent-icon-file") as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "me.jpg", { type: "image/jpeg" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByTestId("agent-icon-preview").getAttribute("data-icon")).toBe(SQUARE)
  );
}

describe("Zen header avatar → Change icon", () => {
  it("tapping the header avatar opens the sheet, titled for the workspace", async () => {
    await openChat(main.id);
    const avatar = screen.getByRole("button", { name: "Change icon for Alpha" });
    fireEvent.click(avatar);
    expect(screen.getByRole("dialog", { name: "Change icon" })).not.toBeNull();
    expect(screen.getByTestId("agent-icon-subtitle").textContent).toBe("Icon for Alpha");
  });

  it("a sidecar chat edits its parent workspace's icon", async () => {
    await openChat(side.id);
    fireEvent.click(screen.getByTestId("chat-header-avatar"));
    expect(screen.getByTestId("agent-icon-subtitle").textContent).toBe("Icon for Alpha");
  });

  it("a picked photo is centre-cropped to a 256px square and previewed", async () => {
    await openChat(main.id);
    fireEvent.click(screen.getByTestId("chat-header-avatar"));
    await pickPhoto();
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 150, 0, 900, 900, 0, 0, 256, 256);
    // Not saved yet.
    expect(updateProjectLook).not.toHaveBeenCalled();
    expect(rowById(main.id).iconUrl).toBeNull();
  });

  it("Save writes projects/update, patches every row optimistically, then settles", async () => {
    let resolve!: (v: { ok: boolean; data?: unknown }) => void;
    vi.mocked(updateProjectLook).mockReturnValue(new Promise((r) => (resolve = r)));
    vi.mocked(getCliProjectsList).mockResolvedValue({
      ok: true,
      data: [
        { id: "p-alpha", name: "Alpha", handle: "alpha", path: "/w/alpha", color: "#22c55e", iconUrl: SQUARE },
        { id: "p-beta", name: "Beta", handle: "beta", path: "/w/beta", color: "#ef4444" },
      ],
    });
    await openChat(main.id);
    fireEvent.click(screen.getByTestId("chat-header-avatar"));
    await pickPhoto();
    fireEvent.click(screen.getByTestId("agent-icon-color-22c55e"));
    fireEvent.click(screen.getByTestId("agent-icon-save"));

    expect(updateProjectLook).toHaveBeenCalledWith(expect.anything(), "p-alpha", { iconUrl: SQUARE, color: "#22c55e" });
    // Optimistic: the workspace row, its sidecar and the header avatar.
    expect(rowById(main.id)).toMatchObject({ iconUrl: SQUARE, color: "#22c55e" });
    expect(rowById(side.id)).toMatchObject({ iconUrl: SQUARE, color: "#22c55e" });
    expect(rowById(other.id)).toMatchObject({ iconUrl: null, color: "#ef4444" });
    const headerImg = screen.getByTestId("chat-header-avatar").querySelector("img");
    expect(headerImg?.getAttribute("src")).toBe(SQUARE);

    await act(async () => resolve({ ok: true, data: {} }));
    await waitFor(() => expect(screen.queryByTestId("agent-icon-sheet")).toBeNull());
    expect(getCliProjectsList).toHaveBeenCalled();
    expect(rowById(side.id).iconUrl).toBe(SQUARE);
  });

  it("a refused save rolls back and shows the error inline", async () => {
    vi.mocked(updateProjectLook).mockResolvedValue({ ok: false, status: 403, error: "role_required" });
    await openChat(main.id);
    fireEvent.click(screen.getByTestId("chat-header-avatar"));
    await pickPhoto();
    fireEvent.click(screen.getByTestId("agent-icon-save"));
    await waitFor(() => expect(screen.getByTestId("agent-icon-error").textContent).toMatch(/can’t change icons/));
    expect(rowById(main.id).iconUrl).toBeNull();
    expect(rowById(side.id).iconUrl).toBeNull();
    expect(screen.getByTestId("agent-icon-sheet")).not.toBeNull();
    expect(getCliProjectsList).not.toHaveBeenCalled();
  });

  it("Remove icon clears it with an empty iconUrl", async () => {
    vi.mocked(updateProjectLook).mockResolvedValue({ ok: true, data: {} });
    vi.mocked(getCliProjectsList).mockResolvedValue({ ok: false, error: "offline" });
    const withIcon = [{ ...main, iconUrl: ICON }, { ...side, iconUrl: ICON }, other];
    await openChat(main.id, withIcon);
    fireEvent.click(screen.getByTestId("chat-header-avatar"));
    fireEvent.click(screen.getByTestId("agent-icon-remove"));
    expect(screen.getByTestId("agent-icon-preview").getAttribute("data-icon")).toBe("");
    fireEvent.click(screen.getByTestId("agent-icon-save"));
    expect(updateProjectLook).toHaveBeenCalledWith(expect.anything(), "p-alpha", { iconUrl: "" });
    await waitFor(() => expect(screen.queryByTestId("agent-icon-sheet")).toBeNull());
    expect(rowById(main.id).iconUrl).toBeNull();
    expect(rowById(side.id).iconUrl).toBeNull();
  });

  it("a role below Member gets a plain avatar and no sheet", async () => {
    who.identity = { username: "g", owner: false, role: "guest" };
    await openChat(main.id);
    expect(screen.queryByRole("button", { name: /Change icon/ })).toBeNull();
    fireEvent.click(screen.getByTestId("chat-header-avatar"));
    expect(screen.queryByTestId("agent-icon-sheet")).toBeNull();
  });
});

describe("Zen header LLM icon", () => {
  it("shows the chat's LLM left of the avatar, none when unknown", async () => {
    await openChat(main.id);
    expect(screen.queryByTestId("chat-header-llm")).toBeNull();
    act(() => {
      useZenStore.setState({
        activity: {
          byPath: {},
          bySession: {
            t1: { display: "idle", counts: { subagents: 0, tools: 0, commands: 0 }, path: "/w/alpha", harness: "codex" },
          },
        },
      });
    });
    expect(screen.getByTestId("chat-header-llm").getAttribute("data-llm")).toBe("codex");
  });
});
