// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../api/client", () => ({
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
  spawnTabSession: vi.fn(),
  spawnResumeTab: vi.fn(),
  getActivePresets: vi.fn(async () => ({ ok: true, data: [] })),
  uploadFsBinary: vi.fn(),
  setTabTitle: vi.fn(async () => ({ ok: true, data: { success: true } })),
  setSessionLabel: vi.fn(async () => ({ ok: true, data: { success: true } })),
  getWorkspaceLiveSessions: vi.fn(async () => ({ ok: true, data: [] })),
  getChatList: vi.fn(async () => ({ ok: true, data: [] })),
  getChatCustomNames: vi.fn(async () => ({ ok: true, data: {} })),
  getThreadLatest: vi.fn(async () => ({ ok: true, data: { items: [] } })),
}));

vi.mock("../api/projectGroups", () => ({
  fetchProjectGroups: vi.fn(async () => ({ ok: true, data: [] })),
  fetchProjectGroupMessages: vi.fn(async () => ({
    ok: true,
    data: { messages: [], truncated: false },
  })),
  postProjectGroupMessage: vi.fn(),
}));

import {
  getActivePresets,
  getAllSessions,
  getChatCustomNames,
  getChatList,
  getThreadLatest,
  getWorkspaceLiveSessions,
  spawnResumeTab,
  spawnSidecarSession,
  spawnTabSession,
} from "../api/client";
import { handleAndroidBack } from "../lib/androidBack";
import { SIDECAR_STORAGE_KEY } from "../zen/sidecarRows";
import { mountainTime } from "../zen/threadModel";
import { useServersStore } from "../stores/servers";
import { useWorkspacesStore } from "../stores/workspaces";
import { DRAWER_ORIGIN_KEY } from "../zen/sessionDrawer";
import { useZenStore } from "../zen/zenStore";
import { Zen } from "./Zen";

/** MA21: the session token lives in the servers store (Zen reads it from
 *  its scope), not a mocked `getToken`. "" = signed out (stub list). */
function setSessionToken(token: string) {
  useServersStore.setState((s) => ({
    tokens: token ? { ...s.tokens, s1: token } : {},
  }));
}


const base = { workspaceName: "K2", workspaceId: "k2", workspaceColor: "#000" };
const SESSIONS = [
  { ...base, cwd: "/ws", agentName: "k2", terminalId: "t-main", label: "main", isMainChat: true, command: "claude" },
  { ...base, cwd: "/ws", agentName: "reviewer", terminalId: "t-rev", label: "Code review", command: "grok" },
  { ...base, cwd: "/ws", agentName: "1", terminalId: "t-1", label: "", command: "/usr/local/bin/codex" },
  { ...base, cwd: "/other", agentName: "x", terminalId: "t-x", label: "elsewhere", command: "claude" },
  { ...base, cwd: "/ws", agentName: "tab-6b1c", terminalId: "t-zsh", label: "zsh", command: null },
];

/** GET /cli/companion/presets: enabled presets only (the daemon filters). */
const PRESETS = [
  { id: "p-claude", name: "Claude", command: "claude --dangerously-skip-permissions", icon: "" },
  { id: "p-codex", name: "Codex", command: "codex --yolo", icon: "" },
  { id: "p-aider", name: "Aider", command: "aider", icon: "" },
];

/** GET /cli/sessions/list-for-workspace?path=/ws: kind, handle, conversationId per PTY. */
const LIVE = [
  { sessionId: "t-main", agentName: "k2", kind: "canonical", handle: "k2", conversationId: "c-main", command: "claude" },
  { sessionId: "t-rev", agentName: "reviewer", kind: "other", handle: "", conversationId: "c-rev", command: "grok" },
  { sessionId: "t-1", agentName: "1", kind: "other", handle: "", conversationId: "c-1", command: "codex" },
  { sessionId: "t-zsh", agentName: "tab-6b1c", kind: "other", handle: "", command: null },
  { sessionId: "t-77", agentName: "tab-77", kind: "sidecar", handle: "k2/3", conversationId: "c-77", command: "claude" },
];
/** A desktop `+` tab running Claude: a plain tab with its own Thread (`k2/3`). */
const SCRATCH = { ...base, cwd: "/ws", agentName: "tab-77", terminalId: "t-77", label: "Scratch", command: "claude" };

const NOW = Math.floor(Date.now() / 1000);
/** GET /cli/chat/list?project_path=/ws (timestamps in ms). */
const CHATS = [
  { sessionId: "c-main", provider: "claude", title: "pinned main", timestamp: (NOW - 60) * 1000, archived: false },
  { sessionId: "c-rev", provider: "grok", title: "open reviewer", timestamp: (NOW - 120) * 1000, archived: false },
  { sessionId: "c-old1", provider: "codex", title: "Refactor login\nmore text", timestamp: (NOW - 3 * 86400) * 1000, archived: false },
  { sessionId: "0a0b0c0d-0000-4000-8000-000000000002", provider: "claude", title: "first message", timestamp: (NOW - 3600) * 1000, archived: false },
  { sessionId: "c-old3", provider: "grok", title: "grok chat", timestamp: (NOW - 10000) * 1000, archived: false },
  { sessionId: "c-gone", provider: "claude", title: "never in K2", timestamp: (NOW - 30) * 1000, archived: false },
  { sessionId: "c-arch", provider: "claude", title: "archived", timestamp: (NOW - 40) * 1000, archived: true },
];
/** GET /cli/thread/latest rows by addr; anything else is not_found. */
const LATEST: Record<string, { conversationId: string; at: number | null }> = {
  k2: { conversationId: "c-main", at: NOW - 60 },
  "k2/old": { conversationId: "c-old3", at: NOW - 7200 },
  "c-old1": { conversationId: "c-old1", at: null },
  "0a0b0c0d-0000-4000-8000-000000000002": { conversationId: "0a0b0c0d-0000-4000-8000-000000000002", at: NOW - 5000 },
  "c-old3": { conversationId: "c-old3", at: NOW - 7200 },
  "c-main": { conversationId: "c-main", at: NOW - 60 },
  "c-rev": { conversationId: "c-rev", at: NOW - 120 },
};
function latestFor(addrs: string[]) {
  return {
    ok: true,
    data: {
      items: addrs.map((addr) => {
        const hit = LATEST[addr] ?? (addr.startsWith("c-bulk") ? { conversationId: addr, at: NOW - 100 } : null);
        return hit
          ? { addr, conversationId: hit.conversationId, at: hit.at, seq: 1 }
          : { addr, error: { code: "not_found", hint: `unknown overlay addr '${addr}'` } };
      }),
    },
  };
}

function mockHistory(chats: unknown[] = CHATS) {
  vi.mocked(getWorkspaceLiveSessions).mockResolvedValue({ ok: true, data: LIVE } as never);
  vi.mocked(getChatList).mockResolvedValue({ ok: true, data: chats } as never);
  vi.mocked(getChatCustomNames).mockResolvedValue({
    ok: true,
    data: { "claude:0a0b0c0d-0000-4000-8000-000000000002": "Planning", "claude:c-gone": "Ghost" },
  } as never);
  vi.mocked(getThreadLatest).mockImplementation(
    async (_scope, addrs: string[]) => latestFor(addrs) as never
  );
}

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
  setSessionToken("");
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
  setSessionToken("t");
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
  // The old `getToken` mock defaulted to "" (signed out).
  setSessionToken("");
  useWorkspacesStore.setState({ allSessions: [] });
  localStorage.clear();
  mockHistory();
});

afterEach(() => {
  cleanup();
  act(() => useZenStore.getState().closeChat());
  sessionStorage.clear();
  setSessionToken("");
  vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(spawnSidecarSession).mockReset();
  vi.mocked(spawnTabSession).mockReset();
  vi.mocked(spawnResumeTab).mockReset();
  vi.mocked(getThreadLatest).mockReset();
  vi.mocked(getWorkspaceLiveSessions).mockReset();
  localStorage.clear();
});

async function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
  return screen.findByTestId("sessions-drawer");
}

const PLANNING = "0a0b0c0d-0000-4000-8000-000000000002";
/** The tab a wake spawns, as `companion/sessions` and `list-for-workspace` list it. */
const WOKEN = { ...base, cwd: "/ws", agentName: "tab-w", terminalId: "t-woken", label: "Planning", command: "claude" };
const WOKEN_LIVE = { sessionId: "t-woken", agentName: "tab-w", kind: "other", handle: "", conversationId: PLANNING, command: "claude" };

async function historyRow(drawer: HTMLElement, addr: string): Promise<HTMLElement> {
  return waitFor(() => {
    const hit = within(drawer)
      .getAllByTestId("session-row-history")
      .find((r) => r.getAttribute("data-thread-addr") === addr);
    expect(hit).toBeTruthy();
    return hit!;
  });
}

function rememberOld() {
  localStorage.setItem(
    SIDECAR_STORAGE_KEY,
    JSON.stringify([
      { addr: "k2/old", path: "/ws", name: "K2", chatTitle: "Old reviewer" },
      { addr: "other/9", path: "/other", name: "Other", chatTitle: "elsewhere" },
    ])
  );
}

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

  it("Active lists main, then sidecars as agent/sidecar, then plain terminals; no Terminals heading", async () => {
    await openMain();
    const drawer = await openDrawer();
    await within(drawer).findByText("k2/reviewer");
    const rows = within(drawer)
      .getAllByRole("button")
      .filter((b) => /^session-row-(main|sidecar|terminal)$/.test(b.getAttribute("data-testid") || ""));
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
    expect(within(drawer).getByTestId("sessions-active").textContent).toBe("Active");
    expect(within(drawer).queryByText("Terminals")).toBeNull();
    expect(within(drawer).queryByTestId("sessions-terminals")).toBeNull();
    expect(within(drawer).queryByTestId("sessions-empty")).toBeNull();
  });

  it("reads Active, + New session, History top to bottom", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: PRESETS } as never);
    await openMain();
    const drawer = await openDrawer();
    await within(drawer).findByTestId("sessions-new");
    await within(drawer).findAllByTestId("session-row-history");
    const order = Array.from(drawer.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) =>
        ["sessions-active", "session-row-main", "session-row-terminal", "sessions-new", "sessions-history", "session-row-history"].includes(id || "")
      );
    const first = (id: string) => order.indexOf(id);
    expect(first("sessions-active")).toBe(0);
    expect(first("session-row-main")).toBeGreaterThan(first("sessions-active"));
    expect(first("session-row-terminal")).toBeLessThan(first("sessions-new"));
    expect(first("sessions-new")).toBeLessThan(first("sessions-history"));
    expect(first("sessions-history")).toBeLessThan(first("session-row-history"));
    expect(order.lastIndexOf("session-row-terminal")).toBeLessThan(first("sessions-new"));
    expect(within(drawer).getByTestId("sessions-history").textContent).toBe("History");
  });

  it("History leaves out open sessions, archived and K2-less chats; newest first with the date", async () => {
    rememberOld();
    await openMain();
    const drawer = await openDrawer();
    await waitFor(() => expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(3));
    const rows = within(drawer).getAllByTestId("session-row-history");
    // 0a0b0c0d-0000-4000-8000-000000000002 (named "Planning", 1h ago) > k2/old (2h; its chat c-old3 merges in) > c-old1 (3d).
    expect(rows.map((r) => r.getAttribute("data-thread-addr"))).toEqual(["0a0b0c0d-0000-4000-8000-000000000002", "k2/old", "c-old1"]);
    expect(rows[0].textContent).toContain("Planning");
    expect(rows[1].textContent).toContain("k2/old");
    expect(rows[1].textContent).toContain("Old reviewer");
    expect(rows[2].textContent).toContain("Refactor login");
    expect(rows[2].textContent).not.toContain("more text");
    expect(within(rows[0]).getByTestId("session-when").textContent).toBe(mountainTime(NOW - 3600));
    expect(within(rows[1]).getByTestId("session-when").textContent).toBe(mountainTime(NOW - 7200));
    expect(within(rows[2]).getByTestId("session-when").textContent).toBe(mountainTime(NOW - 3 * 86400));
    // Same row shape as Active: the LLM mark leads.
    expect(rows.map((r) => within(r).getByTestId("llm-icon").getAttribute("data-llm"))).toEqual([
      "claude",
      "grok",
      "codex",
    ]);
    const text = drawer.textContent || "";
    for (const gone of ["pinned main", "open reviewer", "Ghost", "never in K2", "archived", "elsewhere"]) {
      expect(text).not.toContain(gone);
    }
    // Every lookup stays within the route's 50-addr cap.
    for (const [, addrs] of vi.mocked(getThreadLatest).mock.calls) expect(addrs.length).toBeLessThanOrEqual(50);
    expect(getChatList).toHaveBeenCalledWith(expect.anything(), "/ws");
    expect(getWorkspaceLiveSessions).toHaveBeenCalledWith(expect.anything(), "/ws");
  });

  it("History shows the empty state when there are no past sessions", async () => {
    mockHistory([]);
    await openMain();
    const drawer = await openDrawer();
    await waitFor(() =>
      expect(within(drawer).getByTestId("sessions-history-empty").textContent).toBe("No past sessions")
    );
    expect(within(drawer).queryAllByTestId("session-row-history")).toHaveLength(0);
  });

  const bulkHistory = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `c-bulk-${i}`,
      provider: "claude",
      title: `bulk ${i}`,
      timestamp: (NOW - 1000 - i) * 1000,
      archived: false,
    }));

  it("History caps at 50 and loads the next page by itself near the bottom (no Show more)", async () => {
    mockHistory(bulkHistory(60));
    await openMain();
    const drawer = await openDrawer();
    await waitFor(() => expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(50));
    // Nothing loads on the first paint, and there is no button to tap.
    await act(async () => {});
    expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(50);
    expect(within(drawer).queryByRole("button", { name: /show more/i })).toBeNull();
    const calls = vi.mocked(getThreadLatest).mock.calls.length;
    // The reader scrolls near the bottom (jsdom: the list is all "bottom").
    fireEvent.scroll(within(drawer).getByTestId("sessions-list"));
    fireEvent.scroll(within(drawer).getByTestId("sessions-list"));
    await waitFor(() => expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(60));
    // One page asked for, once (single-flight across the two scrolls).
    expect(vi.mocked(getThreadLatest).mock.calls.length).toBe(calls + 1);
    const rows = within(drawer).getAllByTestId("session-row-history");
    expect(rows[0].getAttribute("data-thread-addr")).toBe("c-bulk-0");
    expect(rows[59].getAttribute("data-thread-addr")).toBe("c-bulk-59");
    // The end: no spinner, no error, nothing more to ask for.
    fireEvent.scroll(within(drawer).getByTestId("sessions-list"));
    await act(async () => {});
    expect(vi.mocked(getThreadLatest).mock.calls.length).toBe(calls + 1);
    expect(within(drawer).queryByTestId("sessions-history-loading")).toBeNull();
    expect(within(drawer).queryByTestId("sessions-history-error")).toBeNull();
  });

  it("a History page that fails says Couldn't load more · Retry; Retry loads it", async () => {
    mockHistory(bulkHistory(60));
    await openMain();
    const drawer = await openDrawer();
    await waitFor(() => expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(50));
    vi.mocked(getThreadLatest).mockRejectedValueOnce(new Error("offline"));
    fireEvent.scroll(within(drawer).getByTestId("sessions-list"));
    const err = await within(drawer).findByTestId("sessions-history-error");
    expect(err.textContent).toContain("Couldn't load more");
    // Not marked missing, not retried on its own: still the first page.
    expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(50);
    fireEvent.click(within(drawer).getByTestId("sessions-history-retry"));
    await waitFor(() => expect(within(drawer).getAllByTestId("session-row-history")).toHaveLength(60));
    expect(within(drawer).queryByTestId("sessions-history-error")).toBeNull();
  });

  it("tapping a History row wakes it with its harness, resume id and workspace, then it moves to Active", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: PRESETS } as never);
    let finish!: (v: unknown) => void;
    vi.mocked(spawnResumeTab).mockImplementation(
      () => new Promise((res) => (finish = res)) as never
    );
    await openMain();
    const drawer = await openDrawer();
    // Presets loaded (the + shows): the wake uses the Claude preset's args.
    await within(drawer).findByTestId("sessions-new-toggle");
    const row = await historyRow(drawer, PLANNING);
    fireEvent.click(row);
    // Pending: the row says Waking…, the drawer stays, nothing opens yet.
    expect((await within(row).findByTestId("session-waking")).textContent).toBe("Waking…");
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(useZenStore.getState().threadAddr).toBe("k2");
    expect(spawnResumeTab).toHaveBeenCalledWith(
      expect.anything(),
      "/ws",
      { command: "claude", args: ["--dangerously-skip-permissions", "--resume", PLANNING] },
      "Planning"
    );
    expect(spawnSidecarSession).not.toHaveBeenCalled();
    // The daemon now lists the woken tab holding that conversation.
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [...SESSIONS, WOKEN] } as never);
    vi.mocked(getWorkspaceLiveSessions).mockResolvedValue({ ok: true, data: [...LIVE, WOKEN_LIVE] } as never);
    const calls = vi.mocked(getAllSessions).mock.calls.length;
    await act(async () => finish({ ok: true, data: { sessionId: "t-woken", agentName: "tab-w" } }));
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe(PLANNING));
    expect(vi.mocked(getAllSessions).mock.calls.length).toBeGreaterThan(calls);
    expect(useZenStore.getState().drawerOrigin).toBe(MAIN.id);
    expect(screen.queryByTestId("sessions-drawer")).toBeNull();
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(screen.queryByTestId("term-loc")).toBeNull();
    const added = useZenStore.getState().agents.find((a) => a.addr === PLANNING);
    expect(added?.hostLive).toBe(true);
    expect(added?.terminalId).toBe("t-woken");
    // Reopened: the session is under Active, gone from History.
    const again = await openDrawer();
    const active = await waitFor(() => {
      const hit = within(again)
        .getAllByTestId("session-row-terminal")
        .find((r) => r.getAttribute("data-thread-addr") === PLANNING);
      expect(hit).toBeTruthy();
      return hit!;
    });
    expect(within(active).getByTestId("session-current")).not.toBeNull();
    await waitFor(() => expect(within(again).getAllByTestId("session-row-history")).toHaveLength(2));
    expect(
      within(again)
        .getAllByTestId("session-row-history")
        .map((r) => r.getAttribute("data-thread-addr"))
    ).not.toContain(PLANNING);
    const main = within(again).getByTestId("session-row-main");
    expect(main.textContent).toContain("k2");
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.click(screen.getByTestId("chat-done"));
    expect(useZenStore.getState().threadAddr).toBe("k2");
  });

  it("a woken tab whose Thread moved to a ws/N handle opens at the new address", async () => {
    vi.mocked(spawnResumeTab).mockResolvedValue({
      ok: true,
      data: { sessionId: "t-woken", agentName: "tab-w" },
    } as never);
    await openMain();
    const drawer = await openDrawer();
    const row = await historyRow(drawer, PLANNING);
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [...SESSIONS, WOKEN] } as never);
    vi.mocked(getWorkspaceLiveSessions).mockImplementation(async () => {
      // First read (the race check) has no such tab; after the spawn it is `k2/4`.
      const spawned = vi.mocked(spawnResumeTab).mock.calls.length > 0;
      return {
        ok: true,
        data: spawned ? [...LIVE, { ...WOKEN_LIVE, kind: "sidecar", handle: "k2/4" }] : LIVE,
      } as never;
    });
    fireEvent.click(row);
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2/4"));
    // No enabled preset: desktop adds no flags either.
    expect(spawnResumeTab).toHaveBeenCalledWith(
      expect.anything(),
      "/ws",
      { command: "claude", args: ["--resume", PLANNING] },
      "Planning"
    );
  });

  it("a failed wake stays on the row with an error and Open without waking", async () => {
    vi.mocked(spawnResumeTab).mockResolvedValue({ ok: false, error: "spawn refused" } as never);
    await openMain();
    const drawer = await openDrawer();
    const row = await historyRow(drawer, PLANNING);
    fireEvent.click(row);
    const err = await within(drawer).findByTestId("session-wake-error");
    expect(err.textContent).toBe("spawn refused");
    expect(within(row).queryByTestId("session-waking")).toBeNull();
    expect(useZenStore.getState().threadAddr).toBe("k2");
    expect(screen.getByTestId("sessions-drawer")).not.toBeNull();
    fireEvent.click(within(drawer).getByTestId("session-open-without-waking"));
    expect(useZenStore.getState().threadAddr).toBe(PLANNING);
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(spawnResumeTab).toHaveBeenCalledTimes(1);
    // Read-only: a hostless History row stays out of the Chats list.
    expect(useZenStore.getState().agents.find((a) => a.addr === PLANNING)?.hostLive).toBe(false);
  });

  it("a harness K2 cannot resume opens read-only, with a note, and never spawns", async () => {
    mockHistory([
      ...CHATS,
      { sessionId: "c-bulk-aider", provider: "aider", title: "aider chat", timestamp: (NOW - 50) * 1000, archived: false },
    ]);
    await openMain();
    const drawer = await openDrawer();
    const row = await historyRow(drawer, "c-bulk-aider");
    expect(row.getAttribute("data-read-only")).toBe("true");
    expect(within(row).getByTestId("session-read-only").textContent).toBe("Open (read-only)");
    expect(within(row).getByTestId("session-read-only-note").textContent).toBe(
      "Can't resume this LLM from the phone"
    );
    // A resumable row has neither.
    const planning = await historyRow(drawer, PLANNING);
    expect(within(planning).queryByTestId("session-read-only")).toBeNull();
    fireEvent.click(row);
    expect(useZenStore.getState().threadAddr).toBe("c-bulk-aider");
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(spawnResumeTab).not.toHaveBeenCalled();
    expect(spawnSidecarSession).not.toHaveBeenCalled();
  });

  it("a conversation that went live meanwhile is just opened, not spawned again", async () => {
    await openMain();
    const drawer = await openDrawer();
    const row = await historyRow(drawer, PLANNING);
    // Desktop resumed it after the drawer loaded.
    vi.mocked(getWorkspaceLiveSessions).mockResolvedValue({ ok: true, data: [...LIVE, WOKEN_LIVE] } as never);
    vi.mocked(getAllSessions).mockResolvedValue({ ok: true, data: [...SESSIONS, WOKEN] } as never);
    fireEvent.click(row);
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe(PLANNING));
    expect(spawnResumeTab).not.toHaveBeenCalled();
    expect(useZenStore.getState().agents.find((a) => a.addr === PLANNING)?.terminalId).toBe("t-woken");
  });

  it("a remembered History sidecar wakes through its own LLM, not Claude", async () => {
    rememberOld();
    vi.mocked(spawnSidecarSession).mockImplementation(async () => {
      // From now on companion/sessions lists the respawned sidecar.
      vi.mocked(getAllSessions).mockResolvedValue({
        ok: true,
        data: [...SESSIONS, { ...base, cwd: "/ws", agentName: "old", terminalId: "t-old", label: "Old reviewer", command: "grok" }],
      } as never);
      return { ok: true, data: { sessionId: "t-old", agentName: "old" } } as never;
    });
    await openMain();
    const drawer = await openDrawer();
    const row = await historyRow(drawer, "k2/old");
    fireEvent.click(row);
    expect(within(row).getByTestId("session-waking")).not.toBeNull();
    await waitFor(() =>
      expect(spawnSidecarSession).toHaveBeenCalledWith(expect.anything(), "/ws", "old", "Old reviewer", {
        command: "grok",
        args: [],
      })
    );
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2/old"));
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(spawnSidecarSession).toHaveBeenCalledTimes(1);
    expect(spawnResumeTab).not.toHaveBeenCalled();
    expect(screen.queryByTestId("term-loc")).toBeNull();
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
    // Done mode: the centre title is <Agent>/<sidecar>, pencil beside it.
    expect(screen.getByTestId("chat-header-title").textContent).toBe("K2/reviewer");
    const row = screen.getByTestId("chat-header-title-row");
    expect(row.contains(screen.getByTestId("chat-rename-open"))).toBe(true);
    expect(screen.queryByTestId("chat-hide")).toBeNull();
    // Nothing under the right-hand buttons.
    const right = screen.getByTestId("chat-header-right");
    expect(right.children.length).toBe(1);
    expect(screen.queryByTestId("chat-session-line")).toBeNull();
    expect(screen.queryByTestId("chat-sidecar-title")).toBeNull();
    // The pencil still opens the rename sheet.
    fireEvent.click(screen.getByTestId("chat-rename-open"));
    expect(screen.getByTestId("chat-rename-input")).not.toBeNull();
  });

  it("the terminal button then opens the sidecar's own terminal", async () => {
    await openMain();
    await pick("k2/reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() =>
      expect(screen.getByTestId("term-loc").textContent).toBe("/zen/terminal/t-rev")
    );
  });

  it("a plain terminal row opens its Thread (ws/N) in Done mode, not the terminal", async () => {
    await openMain([...SESSIONS, SCRATCH]);
    await pick("Scratch");
    expect(useZenStore.getState().threadAddr).toBe("k2/3");
    expect(useZenStore.getState().drawerOrigin).toBe(MAIN.id);
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(screen.queryByTestId("term-loc")).toBeNull();
    // Its own live PTY hosts it: no second host is spawned.
    await waitFor(() => expect(getAllSessions).toHaveBeenCalled());
    expect(spawnSidecarSession).not.toHaveBeenCalled();
    // The header's Terminal button still reaches that PTY.
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() =>
      expect(screen.getByTestId("term-loc").textContent).toBe("/zen/terminal/t-77")
    );
  });

  it("a blank shell with no thread is disabled with a hint and opens nothing", async () => {
    await openMain();
    const drawer = await openDrawer();
    const zsh = (await within(drawer).findByText("zsh")).closest("button")!;
    await waitFor(() =>
      expect(within(zsh).getByTestId("session-no-thread").textContent).toBe("No thread — a plain shell")
    );
    expect((zsh as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(zsh);
    expect(screen.getByTestId("sessions-drawer")).not.toBeNull();
    expect(useZenStore.getState().threadAddr).toBe("k2");
    expect(screen.queryByTestId("term-loc")).toBeNull();
  });

  it("Done returns to the original chat after two picks in a row", async () => {
    await openMain();
    await pick("k2/reviewer");
    await pick("k2/1");
    expect(useZenStore.getState().threadAddr).toBe("k2/1");
    expect(useZenStore.getState().drawerOrigin).toBe(MAIN.id);
    expect(screen.getByTestId("chat-header-title").textContent).toBe("K2/1");
    fireEvent.click(screen.getByTestId("chat-done"));
    expect(useZenStore.getState().agentId).toBe(MAIN.id);
    expect(useZenStore.getState().threadAddr).toBe("k2");
    expect(useZenStore.getState().drawerOrigin).toBeNull();
    expect(sessionStorage.getItem(DRAWER_ORIGIN_KEY)).toBeNull();
    expect(screen.queryByTestId("chat-done")).toBeNull();
    expect(screen.getByTestId("chat-back")).not.toBeNull();
    // Back on the main chat: just <Agent>, no pencil.
    expect(screen.getByTestId("chat-header-title").textContent).toBe("K2");
    expect(screen.queryByTestId("chat-rename-open")).toBeNull();
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

  it("each row leads with its LLM's icon; a plain shell keeps >_", async () => {
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    await within(drawer).findByText("k2/reviewer");
    const icons = (id: string) =>
      within(drawer)
        .getAllByTestId(id)
        .map((row) => within(row).getByTestId("llm-icon").getAttribute("data-llm"));
    expect(icons("session-row-main")).toEqual(["claude"]);
    expect(icons("session-row-sidecar")).toEqual(["grok", "codex"]);
    expect(icons("session-row-terminal")).toEqual(["shell"]);
    expect(within(drawer).getByTestId("session-row-main").querySelector("svg")).not.toBeNull();
    // Activity dot and the current-session check stay.
    expect(within(within(drawer).getByTestId("session-row-main")).getByTestId("session-current")).not.toBeNull();
  });

  it("+ is hidden when the server has no active LLMs", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: [] } as never);
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    await within(drawer).findByText("k2/reviewer");
    await waitFor(() => expect(getActivePresets).toHaveBeenCalled());
    expect(within(drawer).queryByTestId("sessions-new")).toBeNull();
  });

  it("+ is hidden when the presets route 404s (older server)", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({
      ok: false,
      status: 404,
      error: "route not found",
    } as never);
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    await within(drawer).findByText("k2/reviewer");
    await waitFor(() => expect(getActivePresets).toHaveBeenCalled());
    expect(within(drawer).queryByTestId("sessions-new")).toBeNull();
  });

  it("+ lists only the server's active LLMs, with icons", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({
      ok: true,
      data: [...PRESETS, { id: "p-off", name: "Off", command: "gemini", icon: "", enabled: 0 }],
    } as never);
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    const toggle = await within(drawer).findByTestId("sessions-new-toggle");
    expect(toggle.textContent).toContain("New session");
    expect(within(toggle).getByTestId("plus-glyph")).not.toBeNull();
    expect(toggle.className).toMatch(/zen-glass/);
    fireEvent.click(toggle);
    const items = within(drawer).getAllByTestId("sessions-llm");
    expect(items.map((b) => b.getAttribute("data-llm-id"))).toEqual(["p-claude", "p-codex", "p-aider"]);
    expect(items.map((b) => within(b).getByTestId("llm-icon").getAttribute("data-llm"))).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
    // Aider is not a sidecar harness: the daemon runs it as a plain tab.
    expect(items[2].textContent).toContain("Opens as a terminal");
    expect(items[0].textContent).not.toContain("Opens as a terminal");
  });

  it("picking an LLM spawns the next sidecar with that harness and lands in it in Done mode", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: PRESETS } as never);
    let release: () => void = () => {};
    vi.mocked(spawnSidecarSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: { sessionId: "t-2", agentName: "2" } } as never);
        })
    );
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    fireEvent.click(await within(drawer).findByTestId("sessions-new-toggle"));
    const codex = within(drawer)
      .getAllByTestId("sessions-llm")
      .find((b) => b.getAttribute("data-llm-id") === "p-codex")!;
    fireEvent.click(codex);
    expect(codex.textContent).toContain("Starting Codex");
    expect(within(drawer).getAllByTestId("sessions-llm").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(spawnSidecarSession).toHaveBeenCalledWith(expect.anything(), "/ws", "2", "2", {
      command: "codex",
      args: ["--yolo"],
    });
    await act(async () => {
      release();
    });
    await waitFor(() => expect(useZenStore.getState().threadAddr).toBe("k2/2"));
    expect(useZenStore.getState().drawerOrigin).toBe(MAIN.id);
    expect(sessionStorage.getItem(DRAWER_ORIGIN_KEY)).toBe(MAIN.id);
    expect(screen.queryByTestId("sessions-drawer")).toBeNull();
    expect(screen.getByTestId("chat-done").textContent).toBe("Done");
    expect(screen.getByTestId("chat-header-title").textContent).toBe("K2/2");
    fireEvent.click(screen.getByTestId("chat-done"));
    expect(useZenStore.getState().threadAddr).toBe("k2");
  });

  it("a spawn error shows inline and keeps the drawer open", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: PRESETS } as never);
    vi.mocked(spawnSidecarSession).mockResolvedValue({ ok: false, error: "bare_tab_cap" } as never);
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    fireEvent.click(await within(drawer).findByTestId("sessions-new-toggle"));
    fireEvent.click(within(drawer).getAllByTestId("sessions-llm")[0]);
    expect((await within(drawer).findByTestId("sessions-new-error")).textContent).toBe("bare_tab_cap");
    expect(useZenStore.getState().threadAddr).toBe("k2");
    expect(within(drawer).getAllByTestId("sessions-llm").some((b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });

  it("a non-sidecar LLM spawns a plain tab in the workspace and opens its terminal", async () => {
    vi.mocked(getActivePresets).mockResolvedValue({ ok: true, data: PRESETS } as never);
    vi.mocked(spawnTabSession).mockResolvedValue({
      ok: true,
      data: { sessionId: "t-aider", agentName: "tab-x" },
    } as never);
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const drawer = await screen.findByTestId("sessions-drawer");
    fireEvent.click(await within(drawer).findByTestId("sessions-new-toggle"));
    fireEvent.click(
      within(drawer)
        .getAllByTestId("sessions-llm")
        .find((b) => b.getAttribute("data-llm-id") === "p-aider")!
    );
    await waitFor(() =>
      expect(screen.getByTestId("term-loc").textContent).toBe("/zen/terminal/t-aider")
    );
    expect(spawnTabSession).toHaveBeenCalledWith(expect.anything(), "/ws", { command: "aider", args: [] }, "Aider");
    expect(spawnSidecarSession).not.toHaveBeenCalled();
  });
});

describe("Zen — Android Back", () => {
  const back = () => {
    let claimed = false;
    act(() => {
      claimed = handleAndroidBack();
    });
    return claimed;
  };

  it("closes the Sessions drawer, then the chat; at the list it falls through", async () => {
    await openMain();
    await openDrawer();
    expect(back()).toBe(true);
    expect(screen.queryByTestId("sessions-drawer")).toBeNull();
    expect(useZenStore.getState().screen).toBe("thread");

    expect(back()).toBe(true);
    expect(useZenStore.getState().screen).toBe("list");
    expect(screen.queryByTestId("thread-home")).toBeNull();

    // The Zen home with nothing open: Android may exit / background.
    expect(back()).toBe(false);
  });

  it("closes the Files drawer like its X", async () => {
    await openMain();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("file-pane")).not.toBeNull();
    expect(back()).toBe(true);
    expect(useZenStore.getState().filesOpen).toBe(false);
    expect(useZenStore.getState().screen).toBe("thread");
  });

  it("a drawer-picked chat goes back like Done, to the origin chat", async () => {
    await openMain();
    await pick("k2/reviewer");
    expect(screen.getByTestId("chat-done")).not.toBeNull();
    expect(back()).toBe(true);
    expect(useZenStore.getState().agentId).toBe(MAIN.id);
    expect(useZenStore.getState().drawerOrigin).toBeNull();
    expect(useZenStore.getState().screen).toBe("thread");
    expect(screen.getByTestId("chat-back")).not.toBeNull();
  });
});
