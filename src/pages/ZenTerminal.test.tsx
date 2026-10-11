// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type MutableRefObject } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// TerminalView opens sockets — stand in with a prop recorder whose
// reload seam is a spy.
const reloadSpy = vi.fn();
const termProps: Array<{ terminalId: string; projectPath: string; drive?: boolean }> = [];
vi.mock("../components/TerminalView", () => ({
  TerminalView: (p: {
    terminalId: string;
    projectPath: string;
    drive?: boolean;
    onReloadRef?: MutableRefObject<(() => void) | null>;
  }) => {
    termProps.push({ terminalId: p.terminalId, projectPath: p.projectPath, drive: p.drive });
    useEffect(() => {
      if (p.onReloadRef) p.onReloadRef.current = reloadSpy;
    });
    return <div data-testid="terminal-view" data-drive={String(Boolean(p.drive))} />;
  },
}));

vi.mock("../api/sendMessage", () => ({
  sendMessageToSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => ""),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(),
  setSessionLabel: vi.fn(),
  ensurePinnedChat: vi.fn(),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import { ensurePinnedChat, getAllSessions } from "../api/client";
import { sendMessageToSession } from "../api/sendMessage";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { STUB_AGENTS } from "../zen/stubData";
import { rememberZenThread, zenTerminalPath, type ZenTerminalAgent } from "../zen/terminalJump";
import { useZenStore } from "../zen/zenStore";
import { ChatSession } from "./ChatSession";
import { Zen } from "./Zen";
import { ZenTerminal } from "./ZenTerminal";

const AGENT: ZenTerminalAgent = {
  agentId: STUB_AGENTS[0].id,
  name: "Appa",
  initial: "A",
  color: "#123456",
  iconUrl: "https://example.k2.dev/icon.png",
  chatTitle: null,
  projectPath: "/ws/appa",
};

function Loc() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderAt(entry: { pathname: string; state?: unknown } | string, withZen = false) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/zen/terminal/:terminalId" element={<ZenTerminal />} />
        <Route path="/chat/:terminalId" element={<ChatSession />} />
        <Route path="/zen" element={withZen ? <Zen /> : <Loc />} />
        <Route path="*" element={<Loc />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  termProps.length = 0;
  reloadSpy.mockReset();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "test", url: "https://example.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useWorkspacesStore.setState({ allSessions: [], projects: [] });
  useZenStore.setState({ agents: [], agentId: "", screen: "list" });
  rememberZenThread(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ZenTerminal", () => {
  it("renders the glass header: avatar, name, Terminal subtitle, back pill, Viewer/Claimer, reload", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const header = screen.getByTestId("zen-terminal-header");
    const blur = screen.getByTestId("zen-terminal-header-blur");
    expect(header.contains(blur)).toBe(true);
    expect(blur.querySelectorAll("[class^='zen-header-blur-']").length).toBe(4);
    expect(blur.querySelector(".zen-header-tint")).not.toBeNull();

    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Appa");
    expect(screen.getByTestId("zen-terminal-subtitle").textContent).toBe("Terminal");
    expect(
      screen.getByTestId("zen-terminal-avatar").querySelector("img")?.getAttribute("src")
    ).toBe(AGENT.iconUrl);

    const back = screen.getByTestId("zen-terminal-back");
    expect(back.className).toMatch(/zen-glass/);
    expect(back.className).toMatch(/zen-glass-pill/);
    expect(back.style.width).toBe("34px");
    expect(back.style.height).toBe("34px");

    const group = screen.getByRole("group", { name: "Viewer or claimer" });
    expect(group.className).toMatch(/zen-glass/);
    expect(screen.getByRole("button", { name: "Reload session" }).className).toMatch(/zen-glass/);
    // No thread door in this header — back is the only way out.
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();

    expect(termProps[termProps.length - 1]).toEqual({ terminalId: "t1", projectPath: "/ws/appa", drive: false });
  });

  it("Viewer/Claimer switches drive on the same TerminalView", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const watch = screen.getByRole("button", { name: "Viewer — watch only" });
    const claim = screen.getByRole("button", { name: "Claimer — type and resize" });
    expect(watch.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(claim);
    expect(claim.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("terminal-view").getAttribute("data-drive")).toBe("true");
    fireEvent.click(watch);
    expect(screen.getByTestId("terminal-view").getAttribute("data-drive")).toBe("false");
  });

  it("back pill restores the agent's Zen thread, not /sessions", async () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } }, true);
    fireEvent.click(screen.getByTestId("zen-terminal-back"));
    await waitFor(() => expect(useZenStore.getState().screen).toBe("thread"));
    expect(useZenStore.getState().agentId).toBe(AGENT.agentId);
    expect(screen.getByTestId("thread-column")).not.toBeNull();
    expect(screen.queryByTestId("zen-terminal")).toBeNull();
  });

  it("without router state, back uses the remembered thread", () => {
    rememberZenThread("/ws/remembered");
    renderAt(zenTerminalPath("t1"));
    fireEvent.click(screen.getByTestId("zen-terminal-back"));
    expect(screen.getByTestId("loc").textContent).toBe("/zen?thread=%2Fws%2Fremembered");
  });

  it("without router state, looks the agent up in the Zen store by terminal id", () => {
    useZenStore.setState({
      agents: [{ id: "/ws/b::b-2", name: "Bee", initial: "B", path: "/ws/b", addr: "b-2", terminalId: "t9" }],
    });
    renderAt(zenTerminalPath("t9"));
    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Bee");
    fireEvent.click(screen.getByTestId("zen-terminal-back"));
    expect(screen.getByTestId("loc").textContent).toBe("/zen?thread=%2Fws%2Fb%3A%3Ab-2");
  });

  it("with nothing to go on, shows a generic header and back goes to /zen", () => {
    renderAt(zenTerminalPath("t1"));
    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Terminal");
    fireEvent.click(screen.getByTestId("zen-terminal-back"));
    expect(screen.getByTestId("loc").textContent).toBe("/zen");
  });

  it("reload calls the TerminalView reload seam", async () => {
    vi.useFakeTimers();
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
  });

  it("a respawned main chat stays on the Zen terminal page with its agent", async () => {
    const main = {
      terminalId: "t-old",
      cwd: "/ws/appa",
      isMainChat: true,
      workspaceName: "appa",
      workspaceId: "w",
      workspaceColor: "#000",
      agentName: "appa",
      label: "main",
    };
    useWorkspacesStore.setState({ allSessions: [main] });
    vi.mocked(getAllSessions).mockResolvedValueOnce({
      ok: true,
      data: [{ ...main, terminalId: "t-new" }],
    } as never);
    vi.mocked(ensurePinnedChat).mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "t-new" },
    } as never);
    renderAt({ pathname: zenTerminalPath("t-old"), state: { agent: AGENT } });
    fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    await waitFor(() => expect(termProps[termProps.length - 1]?.terminalId).toBe("t-new"));
    expect(ensurePinnedChat).toHaveBeenCalledWith("/ws/appa", { forceRespawn: true });
    expect(screen.getByTestId("zen-terminal-title").textContent).toBe("Appa");
  });

  it("composer keeps the terminal composer's wording and sends to the PTY", async () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    const field = screen.getByPlaceholderText(/Message the agent…/);
    expect(field.closest("[data-k2-variant='zen']")).not.toBeNull();
    fireEvent.change(field, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendMessageToSession).toHaveBeenCalledWith("t1", "ls"));
    expect(screen.queryByTestId("composer-field")).toBeNull();
  });

  it("direct mode shows the accessory keys as tile chips", () => {
    renderAt({ pathname: zenTerminalPath("t1"), state: { agent: AGENT } });
    fireEvent.click(screen.getByRole("button", { name: "Switch to direct typing" }));
    const bar = screen.getByRole("toolbar", { name: "Terminal keys" });
    expect(bar.querySelector("button")?.className).toMatch(/k2-tile/);
    fireEvent.click(screen.getByRole("button", { name: "Switch to safe send" }));
  });
});

describe("old /chat/:id page is unchanged", () => {
  it("keeps its classic chrome and back to /sessions", () => {
    renderAt("/chat/t1");
    expect(screen.queryByTestId("zen-terminal")).toBeNull();
    const field = screen.getByPlaceholderText(/Message the agent…/);
    expect(field.closest("[data-k2-variant='zen']")).toBeNull();
    expect(field.className).toMatch(/border-\[var\(--accent-dim\)\]/);
    expect(screen.getByRole("button", { name: "Chat" })).not.toBeNull();
    const back = document.querySelector("button.-ml-2") as HTMLButtonElement;
    fireEvent.click(back);
    expect(screen.getByTestId("loc").textContent).toBe("/sessions");
  });
});
