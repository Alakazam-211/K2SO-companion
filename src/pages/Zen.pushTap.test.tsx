// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Push tap → `/zen?addr=<addr>&seq=<seq>`: the existing `?addr=` session
// handler opens the Thread; `seq` scrolls to that message and highlights it.

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(),
  getAgentList: vi.fn(),
  getCliProjectsList: vi.fn(),
  getWorkspaceResources: vi.fn(async () => ({ ok: true, data: { resources: [] } })),
  getFsReadFile: vi.fn(),
  getThread: vi.fn(),
  postThread: vi.fn(),
  answerThread: vi.fn(async () => ({ ok: true, data: {} })),
  getActivitySnapshot: vi.fn(async () => ({ ok: true, data: { rows: [], workspaces: [] } })),
  getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  inspectProjectsSummary: vi.fn(),
  getAllSessions: vi.fn(),
  spawnSidecarSession: vi.fn(),
  spawnTabSession: vi.fn(),
  spawnResumeTab: vi.fn(),
  getActivePresets: vi.fn(async () => ({ ok: true, data: [] })),
  uploadFsBinary: vi.fn(),
  ensurePinnedChat: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
  getWorkspaceLiveSessions: vi.fn(),
  getChatList: vi.fn(async () => ({ ok: true, data: [] })),
  getChatCustomNames: vi.fn(async () => ({ ok: true, data: {} })),
  getThreadLatest: vi.fn(async () => ({ ok: true, data: { items: [] } })),
  getAppSettings: vi.fn(async () => ({ ok: true, data: { focusGroupsEnabled: false } })),
  getFocusGroupsList: vi.fn(async () => ({ ok: true, data: [] })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import { getAgentList, getAllSessions, getCliProjectsList, getThread } from "../api/client";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { FOCUS_MAX_PAGES, zenFocusSeq } from "../zen/threadFocus";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

const base = { workspaceName: "K2", workspaceId: "k2", workspaceColor: "#000" };
const SESSIONS = [
  { ...base, cwd: "/ws", agentName: "k2", terminalId: "t-main", label: "main", isMainChat: true, command: "claude" },
  { ...base, cwd: "/ws", agentName: "reviewer", terminalId: "t-rev", label: "Code review", command: "claude" },
];

/** Rows `lo..hi` of a Thread, newest page first. */
const page = (addr: string, lo: number, hi: number, more: boolean) => ({
  ok: true,
  data: {
    items: Array.from({ length: hi - lo + 1 }, (_, i) => ({
      id: `${addr}-${lo + i}`,
      seq: lo + i,
      from: addr,
      text: `msg ${lo + i}`,
      at: lo + i,
    })),
    has_more: more,
    conversation_id: `c-${addr}`,
  },
});
/** Pages of 50 down to seq 1; `endless` never runs out. */
let endless = false;

function renderAt(url: string) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/zen" element={<Zen />} />
      </Routes>
    </MemoryRouter>
  );
}

const highlighted = () =>
  Array.from(document.querySelectorAll("[data-highlight='true']")).map((el) => el.getAttribute("data-seq"));

beforeEach(() => {
  // Flag-off parity: `zen.multiServer` now defaults on; pin it off.
  useMultiServerPrefs.setState({ multiServer: false });
  endless = false;
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "t", url: "https://example.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
    recovery: { s1: "connected" },
  });
  useWorkspacesStore.setState({ allSessions: [], projects: [] });
  useZenStore.setState({ agents: [], agentId: "", screen: "list", drawerOrigin: null, threadFocusSeq: null });
  vi.mocked(getAgentList).mockResolvedValue({ ok: true, data: { ok: true, agents: [{ name: "k2", path: "/ws" }] } } as never);
  vi.mocked(getCliProjectsList).mockResolvedValue({
    ok: true,
    data: [{ id: "pk", name: "K2", handle: "k2", path: "/ws", pinned: 0, tabOrder: 0, focusGroupId: null }],
  } as never);
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: SESSIONS } as never);
  vi.mocked(getThread).mockReset();
  vi.mocked(getThread).mockImplementation(async (_scope, addr: string, _limit?: number, before?: number) => {
    const hi = before != null ? before - 1 : endless ? 1000 : 200;
    const lo = Math.max(1, hi - 49);
    return page(addr, endless ? hi - 49 : lo, hi, endless || lo > 1) as never;
  });
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  sessionStorage.clear();
  localStorage.clear();
});

describe("push tap ?addr=&seq=", () => {
  it("parses only positive integer seqs", () => {
    expect(zenFocusSeq("418")).toBe(418);
    expect(zenFocusSeq("0")).toBeNull();
    expect(zenFocusSeq("abc")).toBeNull();
    expect(zenFocusSeq(null)).toBeNull();
  });

  it("opens the sidecar's thread and highlights a loaded seq", async () => {
    renderAt("/zen?addr=k2%2Freviewer&seq=180");
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2/reviewer"));
    const s = useZenStore.getState();
    expect(s.agents.find((a) => a.id === s.agentId)?.addr).toBe("k2/reviewer");
    await waitFor(() => expect(highlighted()).toEqual(["180"]));
    expect(useZenStore.getState().threadFocusSeq).toBeNull();
    // Only the first page was needed.
    expect(vi.mocked(getThread).mock.calls.every((c) => c[3] === undefined)).toBe(true);
  });

  it("opens the main chat by its addr", async () => {
    renderAt("/zen?addr=k2&seq=200");
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2"));
    expect(useZenStore.getState().agentId).toBe("/ws");
    await waitFor(() => expect(highlighted()).toEqual(["200"]));
  });

  it("an older seq loads earlier pages until it is there", async () => {
    renderAt("/zen?addr=k2&seq=60");
    await waitFor(() => expect(highlighted()).toEqual(["60"]));
    const befores = vi.mocked(getThread).mock.calls.map((c) => c[3]).filter((b) => b != null);
    expect(befores).toEqual([151, 101]);
  });

  it("gives up after a few pages and clears the focus", async () => {
    endless = true;
    renderAt("/zen?addr=k2&seq=1");
    await waitFor(() => expect(useZenStore.getState().threadFocusSeq).toBeNull());
    const earlier = vi.mocked(getThread).mock.calls.filter((c) => c[3] != null);
    expect(earlier).toHaveLength(FOCUS_MAX_PAGES);
    expect(highlighted()).toEqual([]);
  });

  it("without seq, ?addr= opens the thread with no highlight", async () => {
    renderAt("/zen?addr=k2");
    await waitFor(() => expect(useZenStore.getState().threadSource).toBe("live"));
    expect(highlighted()).toEqual([]);
  });
});
