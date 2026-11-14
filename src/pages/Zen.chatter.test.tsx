// @vitest-environment jsdom
// Chatter as a page right of the Thread (Riley 2026-11-14): a right-to-left
// swipe brings it in, Back or a left-to-right swipe takes it away; no
// header switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  getActivePresets: vi.fn(async () => ({ ok: true, data: [] })),
  spawnSidecarSession: vi.fn(),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
}));

vi.mock("../api/scopedFetch", () => ({
  scopedFetch: vi.fn(async () => ({ ok: true, status: 200, text: JSON.stringify({ items: [] }) })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import { useServersStore } from "../stores/servers";
import { STUB_AGENTS } from "../zen/stubData";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

/** MA21: the session token lives in the servers store (Zen reads it from
 *  its scope), not a mocked `getToken`. "" = signed out (stub list). */
function setSessionToken(token: string) {
  useServersStore.setState((s) => ({
    tokens: token ? { ...s.tokens, s1: token } : {},
  }));
}


afterEach(() => {
  cleanup();
  useZenStore.setState({ hiddenSidecarAddrs: [] });
});

beforeEach(() => {
  useServersStore.setState({
    servers: [
      {
        id: "s1",
        nickname: "test",
        url: "https://example.k2.dev",
        username: "u",
        rememberPassword: false,
      },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  // The old `getToken` mock defaulted to "" (signed out).
  setSessionToken("");
});

describe("Zen Chatter swipe", () => {
  // jsdom: innerWidth 1024 (the column has no layout width), so a swipe
  // past ~359px settles the other way.
  const at = (x: number, y = 300) => ({
    touches: [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
  });
  const swipe = (el: HTMLElement, from: number, to: number, y = 300) => {
    fireEvent.touchStart(el, at(from));
    fireEvent.touchMove(el, at(from + Math.sign(to - from) * 20, y));
    fireEvent.touchMove(el, at(to, y));
  };
  const release = (el: HTMLElement, x: number) =>
    fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientX: x, clientY: 300 }] });

  async function openStubThread() {
    setSessionToken("");
    useZenStore.setState({
      agentSource: "stub",
      agents: STUB_AGENTS,
      screen: "list",
      agentError: null,
      filesOpen: false,
      openFileIds: [],
    });
    render(
      <MemoryRouter>
        <Zen />
      </MemoryRouter>
    );
    await waitFor(() => expect(useZenStore.getState().agentSource).toBe("stub"));
    act(() => {
      useZenStore.getState().setAgent(STUB_AGENTS[0].id);
    });
    return screen.getByTestId("thread-column");
  }

  it("has no Terminal | Thread | Chatter switch; the Terminal button is back", async () => {
    await openStubThread();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText("Chatter")).toBeNull();
    expect(screen.getByRole("button", { name: "Terminal" })).not.toBeNull();
    expect(screen.queryByTestId("chatter-page")).toBeNull();
  });

  it("a right-to-left swipe follows the finger and opens Chatter; Back closes it, not the chat", async () => {
    const col = await openStubThread();
    swipe(col, 800, 300);
    const page = screen.getByTestId("chatter-page");
    expect(page.style.transform).toBe("translateX(524px)");
    expect(page.style.transition).toBe("none");
    release(col, 300);
    await waitFor(() => expect(screen.getByTestId("chatter-page").getAttribute("data-open")).toBe("1"));
    expect(screen.getByTestId("chatter-page").style.transform).toBe("translateX(0px)");
    expect(screen.getByTestId("chatter-pane")).not.toBeNull();
    const back = screen.getByTestId("chat-back");
    expect(back.getAttribute("aria-label")).toMatch(/^Back to thread/);
    fireEvent.click(back);
    expect(screen.getByTestId("chatter-page").getAttribute("data-open")).toBeNull();
    expect(useZenStore.getState().agentId).toBe(STUB_AGENTS[0].id);
    await waitFor(() => expect(screen.queryByTestId("chatter-page")).toBeNull());
    expect(screen.getByTestId("chat-back").getAttribute("aria-label")).toMatch(/^Back to chats/);
  });

  it("while open, a left-to-right swipe closes it (even from the left edge: Back to the chats list is off)", async () => {
    const col = await openStubThread();
    swipe(col, 800, 200);
    release(col, 200);
    await waitFor(() => expect(screen.getByTestId("chatter-page").getAttribute("data-open")).toBe("1"));
    swipe(col, 5, 600);
    // Chatter follows; the thread does not slide toward the chats list.
    expect(screen.getByTestId("chatter-page").style.transform).toBe("translateX(595px)");
    expect(screen.getByTestId("thread-home").style.transform).toBe("");
    release(col, 600);
    await waitFor(() => expect(screen.getByTestId("chatter-page").getAttribute("data-open")).toBeNull());
    expect(useZenStore.getState().agentId).toBe(STUB_AGENTS[0].id);
  });

  it("a short swipe springs back closed; a vertical drag is the list's scroll", async () => {
    const col = await openStubThread();
    // Under a flick's minimum travel and the fraction (jsdom's clock makes
    // any longer drag a flick).
    swipe(col, 800, 775);
    release(col, 775);
    expect(screen.getByTestId("chatter-page").getAttribute("data-open")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("chatter-page")).toBeNull());
    swipe(col, 800, 790, 600);
    fireEvent.touchMove(col, at(500, 50));
    expect(screen.queryByTestId("chatter-page")).toBeNull();
  });
});
