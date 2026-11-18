// @vitest-environment jsdom
// A Home row whose server needs a sign-in (Riley 2026-11-17; desktop
// 1ab4f14a9c "a row that says Sign in opens the sign-in for that row's
// server"). Homes sync brings people, channels and agents from other
// devices; on this phone their server may not be saved, or be saved with
// no login. Such a row says "Sign in to <server>" with the agent rows' own
// Sign in button, and a tap opens the sign-in for THAT server:
//   - not saved: Add server, filled with the address (the row's host, or
//     the host the sync pull's `servers{hostKey: serverId}` names for its
//     box id); only a box id known: an empty form that says so;
//   - saved, signed out: that server's own sign-in (no switch);
//   - after the sign-in the row is a normal live row, no restart;
//   - the hold menu keeps Move to group… and Remove from <group>.
// Transport mocked at the HTTP plugin; Home chat's network calls mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const net = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; host: string; path: string; body: string | null }>,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url);
    net.calls.push({ method: init?.method || "GET", host: u.host, path: u.pathname, body: init?.body ?? null });
    const body = (v: unknown, status = 200) => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      json: async () => v,
      text: async () => JSON.stringify(v),
    });
    switch (u.pathname) {
      case "/boot-status":
        return body({ version: "0.46.13", protocol: 1, phase: "ready", instanceId: `i-${u.host}`, features: [] });
      case "/cli/auth/login":
        return body({ token: "tok-c", mustChangePassword: false });
      case "/cli/auth/whoami":
        return body({ username: "u", role: "member", mustChangePassword: false });
      case "/cli/agent/list":
        return body({ ok: true, agents: [] });
      case "/cli/projects/list":
        return body([]);
      case "/cli/project-group/list":
        return body({ ok: true, groups: [] });
      case "/cli/companion/sessions":
        return body([]);
      default:
        return body({});
    }
  }),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));
vi.mock("../lib/revive", async (orig) => ({
  ...(await orig<typeof import("../lib/revive")>()),
  connectServer: vi.fn(async () => "still-valid"),
  revive: vi.fn(async () => "still-valid"),
}));
vi.mock("../lib/useSessionIdentity", () => ({
  useSessionIdentity: () => ({ username: "u", owner: true, role: "owner" }),
}));
const chatApi = vi.hoisted(() => ({
  refreshHomeChatGate: vi.fn(),
  openHomeChatDm: vi.fn(),
  fetchHomeChatPeople: vi.fn(),
  fetchHomeChatChannels: vi.fn(),
  fetchHomeChatSummary: vi.fn(),
}));
vi.mock("../api/homeChat", async (orig) => ({ ...(await orig<typeof import("../api/homeChat")>()), ...chatApi }));
vi.mock("../api/homeChatEvents", () => ({ subscribeHomeChat: vi.fn(() => () => {}) }));

import type { HomeChatGate } from "../api/homeChat";
import { NO_HOME_CHAT_FLAGS } from "../api/homeChatPure";
import { __resetScopesForTests } from "../api/scope";
import { __resetDialQueueForTests } from "../api/dialQueue";
import { __resetHttpCapForTests } from "../api/httpCap";
import { useServersStore } from "../stores/servers";
import { holdOpen, menuLabels, tap } from "../test/rearrangeDrag";
import { ChatsList } from "./ChatsList";
import { HOMES_STORAGE_KEY, homeAddress, parseHomesDoc, useHomesStore, type HomeRow } from "./homes";
import { useHomeServerIds } from "./homeServerIds";
import { __resetHomeChatRowsStoreForTests } from "./homeChat/homeChatRowsStore";
import { __resetHomeChatSeamsForTests, setOpenHomeChatHandler } from "./homeChat/openHomeChat";
import { pool } from "./multi/pool";
import { useMultiServerPrefs } from "./multi/prefs";
import { __resetRemoteIconsForTests } from "./multi/remoteIcons";
import { __resetRemoteRowsForTests } from "./multi/remoteRows";
import { resetRowPreviewMemo } from "./rowPreviewCache";
import { FOCUS_OFF } from "./serverPins";
import { resetThreadPreviewQueue, useZenStore } from "./zenStore";

class MockWS {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  send() {}
  close() {}
}

const sv = (id: string, nickname: string, host: string) => ({
  id,
  nickname,
  url: `https://${host}`,
  username: "u",
  rememberPassword: false,
});
const A = sv("a", "Alpha", "alpha.k2.dev");
const B = sv("b", "Bravo", "bravo.k2.dev");
const C = sv("c", "Charlie", "charlie.k2.dev");
/** Charlie's box id (K2 0.46.1 `serverId`): Homes sync writes rows with it. */
const BOX_C = "3f9a0c1d2e4b5a67";
/** A box this phone has never heard named. */
const BOX_X = "0123456789abcdef";

const offeredGate = (): HomeChatGate => ({
  offered: true,
  feature: true,
  on: true,
  reason: null,
  flags: { ...NO_HOME_CHAT_FLAGS },
  chat: "live",
  checkedAt: Date.now(),
  refusal: null,
  pickerLine: null,
});

const MIA: HomeRow = { kind: "person", address: homeAddress("k2:connect:mia", BOX_C), workspaceId: null, label: "Mia Chen" };

function seed(servers = [A, B], tokens: Record<string, string> = { a: "tok-a", b: "tok-b" }) {
  useServersStore.setState({ hydrated: true, servers, activeServerId: "a", tokens, recovery: { a: "connected" } });
  useZenStore.setState({
    agentSource: "live",
    agents: [{ id: "/a", name: "alpha", initial: "A", path: "/a", addr: "alpha", kind: "agent" }],
    agentError: null,
    serverProjects: [{ id: "pa", name: "alpha", path: "/a", handle: "alpha", pinned: false, tabOrder: 0, focusGroupId: null }],
    pinnedIds: [],
    hiddenSidecarAddrs: [],
    focus: FOCUS_OFF,
    focusGroupsEnabled: false,
    screen: "list",
    agentId: "",
  });
}

function addRow(row: HomeRow) {
  const h = useHomesStore.getState();
  h.addRow(h.selectedId, row);
}

/** Nine rows first, so the rows under test sit past the grid (with a button). */
function fillGrid() {
  for (let n = 0; n < 9; n++) addRow({ address: homeAddress(`g${n}`, "alpha.k2.dev"), workspaceId: null, label: `g${n}` });
}

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  render(
    <MemoryRouter>
      <ChatsList />
    </MemoryRouter>
  );
  act(() => useMultiServerPrefs.getState().setMultiServer(true));
  fireEvent.click(screen.getByTestId("list-tab-home"));
}

const homeRow = (address: string) => document.querySelector(`[data-home-row="${address}"]`) as HTMLElement;
const failureOf = (address: string) => within(homeRow(address)).queryByTestId("row-failure");
const actionOf = (address: string) => within(homeRow(address)).queryByTestId("row-failure-action");

async function signIn(sheet: HTMLElement, username: string | null, password: string) {
  if (username !== null) fireEvent.change(within(sheet).getByPlaceholderText("Username"), { target: { value: username } });
  fireEvent.change(within(sheet).getByPlaceholderText("Password"), { target: { value: password } });
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Connect & save" }));
  });
  await waitFor(() => expect(screen.queryByTestId("row-sign-in")).toBeNull());
}

beforeEach(() => {
  net.calls = [];
  vi.stubGlobal("WebSocket", MockWS);
  localStorage.clear();
  sessionStorage.clear();
  useHomesStore.getState().reload();
  useHomeServerIds.getState().reload();
  __resetScopesForTests();
  __resetDialQueueForTests();
  __resetHttpCapForTests();
  __resetRemoteRowsForTests();
  __resetRemoteIconsForTests();
  __resetHomeChatRowsStoreForTests();
  __resetHomeChatSeamsForTests();
  resetThreadPreviewQueue();
  resetRowPreviewMemo();
  for (const id of ["a", "b", "c"]) pool.forget(id);
  useMultiServerPrefs.setState({ multiServer: false });
  for (const f of Object.values(chatApi)) f.mockReset();
  chatApi.refreshHomeChatGate.mockImplementation(async () => offeredGate());
  chatApi.fetchHomeChatSummary.mockResolvedValue({ ok: true, chat: "live", convs: [] });
  chatApi.fetchHomeChatChannels.mockResolvedValue({ ok: true, channels: [], next: null });
  chatApi.fetchHomeChatPeople.mockResolvedValue({ ok: true, me: { ext: "", memberId: null }, people: [] });
  chatApi.openHomeChatDm.mockResolvedValue({ ok: true, conv: "701", created: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  act(() => useZenStore.getState().closeChat());
  vi.unstubAllGlobals();
});

describe("a person row whose server is not saved on this phone", () => {
  it("says Sign in to <host> with the Sign in button; it opens Add server filled with that host; after the sign-in it is a live DM row", async () => {
    // The sync pull named Charlie's box: `servers{"charlie.k2.dev": BOX_C}`.
    useHomeServerIds.getState().hint({ "charlie.k2.dev": BOX_C });
    fillGrid();
    addRow(MIA);
    seed();
    mount();

    const addr = MIA.address;
    const row = screen.getByTestId("home-chat-person-k2:connect:mia");
    expect(row.textContent).toContain("Mia Chen");
    expect(failureOf(addr)?.textContent).toBe("Sign in to charlie.k2.dev");
    expect(failureOf(addr)?.getAttribute("data-state")).toBe("signin-required");
    expect(homeRow(addr).getAttribute("data-greyed")).toBe("1");
    expect(actionOf(addr)?.textContent).toBe("Sign in");
    expect(actionOf(addr)?.getAttribute("data-action")).toBe("sign-in");
    // Before (4.2.x): "charlie.k2.dev is not saved on this phone", no action.
    expect(row.textContent).not.toContain("is not saved on this phone");

    // The row's tap runs the same action as its button (desktop 1ab4f14a9c).
    fireEvent.click(row);
    const sheet = screen.getByTestId("row-sign-in");
    expect(within(sheet).getByRole("heading").textContent).toBe("Add server");
    expect(within(sheet).getByDisplayValue("charlie.k2.dev")).not.toBeNull();
    expect(within(sheet).queryByTestId("add-server-notice")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByTestId("row-sign-in")).toBeNull();

    fireEvent.click(actionOf(addr)!);
    await signIn(screen.getByTestId("row-sign-in"), "u", "pw");
    expect(net.calls.some((c) => c.method === "POST" && c.path === "/cli/auth/login" && c.host.startsWith("charlie"))).toBe(true);

    // Saved and signed in, without switching: the row resolves to it.
    const saved = useServersStore.getState().servers.find((s) => s.url === "https://charlie.k2.dev");
    expect(saved).toBeTruthy();
    expect(useServersStore.getState().activeServerId).toBe("a");
    await waitFor(() => expect(failureOf(addr)).toBeNull());
    expect(actionOf(addr)).toBeNull();
    expect(homeRow(addr).getAttribute("data-server-id")).toBe(saved!.id);
    expect(homeRow(addr).getAttribute("data-greyed")).toBeNull();
    expect(screen.getByTestId("home-chat-person-k2:connect:mia").textContent).toContain("Direct message");

    // A tap now opens the DM on Charlie.
    const opened = vi.fn();
    setOpenHomeChatHandler(opened);
    fireEvent.click(screen.getByTestId("home-chat-person-k2:connect:mia"));
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(opened.mock.calls[0][0]).toMatchObject({ serverId: saved!.id, kind: "person", conversationId: "701" });
  });

  it("a channel row in the grid: Sign in under its name, and a tap opens Add server for its host", () => {
    addRow({ kind: "channel", address: homeAddress("502", "charlie.k2.dev"), workspaceId: null, label: "design-crit" });
    seed();
    mount();
    const addr = homeAddress("502", "charlie.k2.dev");
    expect(screen.getByTestId("home-grid").contains(homeRow(addr))).toBe(true);
    expect(failureOf(addr)?.textContent).toBe("Sign in to charlie.k2.dev");
    fireEvent.click(screen.getByTestId("home-chat-channel-502"));
    expect(within(screen.getByTestId("row-sign-in")).getByDisplayValue("charlie.k2.dev")).not.toBeNull();
  });

  it("only its box id known (no host): says so, and opens an empty Add server that says where to sign in", () => {
    fillGrid();
    const row: HomeRow = { kind: "person", address: homeAddress("k2:connect:zed", BOX_X), workspaceId: null, label: "Zed" };
    addRow(row);
    seed();
    mount();
    expect(failureOf(row.address)?.textContent).toBe("Sign in on the server where this chat lives");
    fireEvent.click(actionOf(row.address)!);
    const sheet = screen.getByTestId("row-sign-in");
    expect((within(sheet).getByPlaceholderText("your-name.k2.dev") as HTMLInputElement).value).toBe("");
    expect(within(sheet).getByTestId("add-server-notice").textContent).toBe("Sign in on the server where this chat lives");
  });

  it("the hold menu keeps Move to group… and Remove from <group> (no Open or Call while it needs a sign-in)", () => {
    useHomeServerIds.getState().hint({ "charlie.k2.dev": BOX_C });
    useHomesStore.getState().ensureSeeded();
    const first = useHomesStore.getState().selectedId;
    addRow(MIA);
    const second = useHomesStore.getState().createHome("Second")!;
    useHomesStore.getState().selectHome(first);
    seed();
    mount();
    vi.useFakeTimers();
    holdOpen(screen.getByTestId("home-chat-person-k2:connect:mia"));
    const labels = menuLabels(screen.getByTestId("home-row-menu"));
    expect(labels).not.toContain("Open");
    expect(labels).not.toContain("Call");
    expect(labels.slice(-2)).toEqual(["Move to group…", "Remove from Group 1"]);
    tap(screen.getByTestId("menu-move-home"));
    vi.useRealTimers();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Move Mia Chen to a group" })).getByRole("button", { name: "Second" }));
    const doc = parseHomesDoc(localStorage.getItem(HOMES_STORAGE_KEY));
    expect(doc?.homes.find((h) => h.id === first)?.rows ?? []).toEqual([]);
    expect(doc?.homes.find((h) => h.id === second)?.rows.map((r) => [r.address, r.kind])).toEqual([[MIA.address, "person"]]);
  });
});

describe("a person row on a saved server with no login", () => {
  it("the agent rows' Sign in: that server's own sign-in (no switch); after it the row is live", async () => {
    fillGrid();
    const row: HomeRow = { kind: "person", address: homeAddress("k2:connect:mia", "charlie.k2.dev"), workspaceId: null, label: "Mia Chen" };
    addRow(row);
    seed([A, B, C], { a: "tok-a", b: "tok-b" });
    mount();
    expect(failureOf(row.address)?.textContent).toBe("Sign in to Charlie");
    expect(actionOf(row.address)?.textContent).toBe("Sign in");
    expect(homeRow(row.address).getAttribute("data-server-id")).toBe("c");

    fireEvent.click(screen.getByTestId("home-chat-person-k2:connect:mia"));
    const sheet = screen.getByTestId("row-sign-in");
    // Charlie's own entry (re-sign-in), not a new server.
    expect(within(sheet).getByRole("heading").textContent).toBe("Edit server");
    expect(within(sheet).getByDisplayValue("charlie.k2.dev")).not.toBeNull();
    // While its sheet is up the row says so, with no second action.
    expect(failureOf(row.address)?.textContent).toBe("Signing in…");
    expect(actionOf(row.address)).toBeNull();

    await signIn(sheet, null, "pw");
    expect(useServersStore.getState().tokens.c).toBe("tok-c");
    expect(useServersStore.getState().servers.filter((s) => s.url === "https://charlie.k2.dev")).toHaveLength(1);
    expect(useServersStore.getState().activeServerId).toBe("a");
    await waitFor(() => expect(failureOf(row.address)).toBeNull());
    expect(screen.getByTestId("home-chat-person-k2:connect:mia").textContent).toContain("Direct message");
  });
});

describe("an agent row whose server is not saved on this phone", () => {
  it("gets the same Sign in (it had none: only 'is not saved on this phone', a tap opened Servers)", async () => {
    fillGrid();
    const address = homeAddress("docs", "charlie.k2.dev");
    addRow({ address, workspaceId: null, label: "docs" });
    seed();
    mount();
    expect(failureOf(address)?.textContent).toBe("Sign in to charlie.k2.dev");
    expect(actionOf(address)?.textContent).toBe("Sign in");
    fireEvent.click(screen.getByTestId("home-row-docs"));
    const sheet = screen.getByTestId("row-sign-in");
    expect(within(sheet).getByRole("heading").textContent).toBe("Add server");
    expect(within(sheet).getByDisplayValue("charlie.k2.dev")).not.toBeNull();
    await signIn(sheet, "u", "pw");
    const saved = useServersStore.getState().servers.find((s) => s.url === "https://charlie.k2.dev");
    await waitFor(() => expect(homeRow(address).getAttribute("data-server-id")).toBe(saved!.id));
    await waitFor(() => expect(actionOf(address)).toBeNull());
  });

  it("with only a box id: 'where this agent lives', and an empty Add server", () => {
    fillGrid();
    const address = homeAddress("docs", BOX_X);
    addRow({ address, workspaceId: null, label: "docs" });
    seed();
    mount();
    expect(failureOf(address)?.textContent).toBe("Sign in on the server where this agent lives");
    fireEvent.click(actionOf(address)!);
    const sheet = screen.getByTestId("row-sign-in");
    expect((within(sheet).getByPlaceholderText("your-name.k2.dev") as HTMLInputElement).value).toBe("");
    expect(within(sheet).getByTestId("add-server-notice").textContent).toBe("Sign in on the server where this agent lives");
  });
});
