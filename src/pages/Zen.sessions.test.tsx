// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => ""),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(async () => ({ ok: true, data: { resources: [] } })),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  postThread: vi.fn(),
  answerThread: vi.fn(async () => ({ ok: true, data: {} })),
  getActivitySnapshot: vi.fn(async () => ({ ok: true, data: { rows: [], workspaces: [] } })),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import { getAllSessions, getToken } from "../api/client";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { DRAWER_ORIGIN_KEY } from "../zen/sessionDrawer";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

const base = { workspaceName: "K2", workspaceId: "k2", workspaceColor: "#000" };
const SESSIONS = [
  { ...base, cwd: "/ws", agentName: "k2", terminalId: "t-main", label: "main", isMainChat: true },
  { ...base, cwd: "/ws", agentName: "reviewer", terminalId: "t-rev", label: "Code review" },
  { ...base, cwd: "/ws", agentName: "1", terminalId: "t-1", label: "" },
  { ...base, cwd: "/other", agentName: "x", terminalId: "t-x", label: "elsewhere" },
  { ...base, cwd: "/ws", agentName: "tab-6b1c", terminalId: "t-zsh", label: "zsh" },
];

const MAIN = {
  id: "/ws",
  name: "K2",
  initial: "K",
  path: "/ws",
  addr: "k2",
  joinMiss: null,
  kind: "agent" as const,
};
const OTHER = {
  id: "/other",
  name: "Other",
  initial: "O",
  path: "/other",
  addr: "other",
  joinMiss: null,
  kind: "agent" as const,
};

function TermLoc() {
  const loc = useLocation();
  return <div data-testid="term-loc">{loc.pathname}</div>;
}

async function openMain(sessions: unknown[] = SESSIONS) {
  vi.mocked(getToken).mockReturnValue("");
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: sessions } as never);
  render(
    <MemoryRouter initialEntries={["/zen"]}>
      <Routes>
        <Route path="/zen" element={<Zen />} />
        <Route path="/zen/terminal/:terminalId" element={<TermLoc />} />
        <Route path="*" element={<div data-testid="term-loc">elsewhere</div>} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(useZenStore.getState().agentSource).toBe("stub"));
  vi.mocked(getToken).mockReturnValue("t");
  act(() => {
    useZenStore.setState({ agentSource: "live", agents: [MAIN, OTHER], agentError: null });
    useZenStore.getState().setAgent(MAIN.id);
  });
  expect(useZenStore.getState().threadAddr).toBe("k2");
}

async function pick(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
  const drawer = await screen.findByTestId("sessions-drawer");
  const row = await within(drawer).findByText(label);
  fireEvent.click(row);
}

beforeEach(() => {
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useWorkspacesStore.setState({ allSessions: [] });
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  sessionStorage.clear();
  vi.mocked(getToken).mockReturnValue("");
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] } as never);
});

describe("Zen Sessions drawer", () => {
  it("header buttons run terminal, sessions, files", async () => {
    await openMain();
    const right = screen
      .getByTestId("chat-header-content")
      .querySelectorAll<HTMLButtonElement>("button[aria-label]");
    const labels = Array.from(right)
      .map((b) => b.getAttribute("aria-label"))
      .filter((l) => l === "Terminal" || l === "Sessions" || l === "Files");
    expect(labels).toEqual(["Terminal", "Sessions", "Files"]);
    const sessions = screen.getByRole("button", { name: "Sessions" });
    const files = screen.getByRole("button", { name: "Files" });
    expect(sessions.className).toMatch(/zen-glass-pill/);
    expect(sessions.style.width).toBe(files.style.width);
    expect(sessions.style.height).toBe(files.style.height);
  });

  it("lists main first, then this workspace's sidecars as agent/sidecar, then terminals", async () => {
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    await within(drawer).findByText("k2/reviewer");
    const rows = within(drawer)
      .getAllByRole("button")
      .filter((b) => (b.getAttribute("data-testid") || "").startsWith("session-row"));
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "session-row-main",
      "session-row-sidecar",
      "session-row-sidecar",
      "session-row-terminal",
    ]);
    expect(rows[0].textContent).toContain("Main");
    expect(within(rows[0]).getByTestId("session-current")).not.toBeNull();
    expect(rows[1].textContent).toContain("k2/reviewer");
    expect(rows[1].textContent).toContain("Code review");
    expect(rows[2].textContent).toContain("k2/1");
    expect(rows[3].textContent).toContain("zsh");
    expect(within(drawer).queryByText(/elsewhere|other\/x/)).toBeNull();
    expect(within(drawer).getByTestId("sessions-terminals")).not.toBeNull();
    expect(within(drawer).queryByTestId("sessions-empty")).toBeNull();
  });

  it("shows the empty state when the workspace has only its main chat", async () => {
    await openMain([SESSIONS[0], SESSIONS[3]]);
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    await waitFor(() =>
      expect(within(drawer).getByTestId("sessions-empty").textContent).toBe(
        "No other sessions in this workspace"
      )
    );
    expect(within(drawer).getByTestId("session-row-main")).not.toBeNull();
  });

  it("picking a sidecar switches the thread and shows Done plus agent/sidecar", async () => {
    await openMain();
    await pick("k2/reviewer");
    expect(useZenStore.getState().threadAddr).toBe("k2/reviewer");
    expect(useZenStore.getState().drawerOrigin).toBe(MAIN.id);
    expect(sessionStorage.getItem(DRAWER_ORIGIN_KEY)).toBe(MAIN.id);
    expect(screen.queryByTestId("sessions-drawer")).toBeNull();
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(screen.queryByTestId("chat-back")).toBeNull();
    expect(screen.getByTestId("chat-header-title").textContent).toBe("K2");
    expect(screen.getByTestId("chat-sidecar-title").textContent).toBe("k2/reviewer");
    expect(screen.getByTestId("chat-rename-open")).not.toBeNull();
    expect(screen.queryByTestId("chat-hide")).toBeNull();
  });

  it("the terminal button then opens the sidecar's own terminal", async () => {
    await openMain();
    await pick("k2/reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() =>
      expect(screen.getByTestId("term-loc").textContent).toBe("/zen/terminal/t-rev")
    );
  });

  it("a plain terminal row opens that terminal", async () => {
    await openMain();
    await pick("zsh");
    await waitFor(() =>
      expect(screen.getByTestId("term-loc").textContent).toBe("/zen/terminal/t-zsh")
    );
  });

  it("Done returns to the original chat after two picks in a row", async () => {
    await openMain();
    await pick("k2/reviewer");
    await pick("k2/1");
    expect(useZenStore.getState().threadAddr).toBe("k2/1");
    expect(useZenStore.getState().drawerOrigin).toBe(MAIN.id);
    expect(screen.getByTestId("chat-sidecar-title").textContent).toBe("k2/1");
    fireEvent.click(screen.getByTestId("chat-done"));
    expect(useZenStore.getState().agentId).toBe(MAIN.id);
    expect(useZenStore.getState().threadAddr).toBe("k2");
    expect(useZenStore.getState().drawerOrigin).toBeNull();
    expect(sessionStorage.getItem(DRAWER_ORIGIN_KEY)).toBeNull();
    expect(screen.queryByTestId("chat-done")).toBeNull();
    expect(screen.getByTestId("chat-back")).not.toBeNull();
    expect(screen.queryByTestId("chat-sidecar-title")).toBeNull();
  });

  it("picking Main from a picked sidecar also ends drawer mode", async () => {
    await openMain();
    await pick("k2/reviewer");
    await pick("Main");
    expect(useZenStore.getState().agentId).toBe(MAIN.id);
    expect(useZenStore.getState().drawerOrigin).toBeNull();
    expect(screen.getByTestId("chat-back")).not.toBeNull();
  });

  it("the files button is unchanged and swaps with the sessions drawer", async () => {
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByTestId("sessions-drawer")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(useZenStore.getState().filesOpen).toBe(true);
    expect(screen.getByTestId("file-pane")).not.toBeNull();
    expect(screen.queryByTestId("sessions-drawer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(useZenStore.getState().filesOpen).toBe(false);
  });

  it("tapping the chat closes the sessions drawer", async () => {
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByTestId("sessions-drawer")).not.toBeNull();
    fireEvent.click(screen.getByTestId("thread-column"));
    expect(screen.queryByTestId("sessions-drawer")).toBeNull();
  });
});
