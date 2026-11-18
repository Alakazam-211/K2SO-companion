// @vitest-environment jsdom
// People and channels on Home (K2 0.46.13, brief §2.4–2.5, §5 items 6–9):
// the rows (initials on the person colour, # / lock, badges, greyed on a
// server without chat, never dropped), a tap (the DM opened first, then
// the chat view's seam), the hold menu (Call through its seam; Remove asks
// first), and Add to Home's People and Channels (Same person?, New channel).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  refreshHomeChatGate: vi.fn(),
  openHomeChatDm: vi.fn(),
  createHomeChatChannel: vi.fn(),
  waitForHomeChatChannel: vi.fn(),
  fetchHomeChatPeople: vi.fn(),
  fetchHomeChatChannels: vi.fn(),
  fetchHomeChatSummary: vi.fn(),
}));
vi.mock("../../api/homeChat", async (orig) => ({ ...(await orig<typeof import("../../api/homeChat")>()), ...api }));
vi.mock("../../api/homeChatEvents", () => ({ subscribeHomeChat: vi.fn(() => () => {}) }));

import type { HomeChatGate } from "../../api/homeChat";
import { HOME_CHAT_COPY_ROW_NO_CHAT, HOME_CHAT_CREATE_TIMEOUT_COPY, NO_HOME_CHAT_FLAGS, homeChatMacLine, type HomeChatPerson } from "../../api/homeChatPure";
import { useServersStore, type ServerEntry } from "../../stores/servers";
import { HomeList } from "../HomeList";
import { AddAgentSheet } from "../AddAgentSheet";
import { homeAddress, useHomesStore, type Home } from "../homes";
import { resolveHomeRows } from "../homeView";
import { HOLD_MENU_MS } from "../useHoldMenu";
import { PeoplePanel, NewChannelForm, type ChatPickServer } from "./AddToHomePanels";
import {
  CHANNEL_DELETED_LINE,
  __resetHomeChatRowsStoreForTests,
  seedHomeChatServer,
  useHomeChatGoneRows,
  useHomeChatRowsStore,
} from "./homeChatRowsStore";
import { closeHomeChat, noteHomeChatGone, resetHomeChatStore, useHomeChatStore } from "./homeChatStore";
import { HomeConfirmHost } from "./HomeConfirmSheet";
import { __resetHomeChatSeamsForTests, setCallPersonHandler, setOpenHomeChatHandler } from "./openHomeChat";

const A: ServerEntry = { id: "sa", nickname: "Studio", url: "https://studio.example", username: "sam", rememberPassword: false };
const B: ServerEntry = { id: "sb", nickname: "Parity", url: "https://parity.example", username: "sam", rememberPassword: false };
const HA = "studio.example";
const HB = "parity.example";

const gate = (offered: boolean, reason: string | null = null): HomeChatGate => ({
  offered,
  feature: true,
  on: offered,
  reason,
  flags: { ...NO_HOME_CHAT_FLAGS },
  chat: offered ? "live" : null,
  checkedAt: Date.now(),
  refusal: null,
  pickerLine: offered ? null : reason === "mac" ? homeChatMacLine() : "No chat on this server.",
});

const person = (ext: string, username: string, displayName: string, ready = true): HomeChatPerson => ({
  ext,
  username,
  displayName,
  picture: null,
  role: "member",
  ready,
  memberId: "1",
});

function seed() {
  useServersStore.setState({
    servers: [A, B],
    activeServerId: A.id,
    hydrated: true,
    tokens: { [A.id]: "ta", [B.id]: "tb" },
  });
  seedHomeChatServer(A.id, {
    gate: gate(true),
    people: { me: { ext: "k2:connect:me", memberId: "2" }, people: [person("k2:connect:ana", "ana", "Ana Ruiz")] },
    peopleAt: Date.now(),
    summary: {
      chat: "live",
      convs: [
        { conv: "601", kind: "dm", unread: true, badge: { kind: "count", n: 3 }, lastAt: null, lastAtMs: null, lastMessageId: null, with: "k2:connect:ana", inviteOnly: null },
        { conv: "502", kind: "channel", unread: true, badge: { kind: "dot" }, lastAt: null, lastAtMs: null, lastMessageId: null, with: null, inviteOnly: true },
      ],
    },
  });
  seedHomeChatServer(B.id, { gate: gate(false, "mac") });
}

function homeWith(rows: Home["rows"]): Home {
  return { id: "h1", name: "Launch", rows };
}

function renderList(home: Home, onRemove = vi.fn(), pinned: readonly string[] = []) {
  const views = resolveHomeRows(home.rows, {
    activeHostKey: HA,
    agents: [],
    projects: [],
    servers: [A, B],
    remote: { byServer: {}, tokens: useServersStore.getState().tokens },
  });
  render(
    <>
      <HomeList
        views={views}
        homeName={home.name}
        searching={false}
        gridMax={0}
        onRemove={onRemove}
        onOpenRemote={() => {}}
        previewFor={() => ""}
        pins={{ isPinned: (a) => pinned.includes(a), full: false, onPin: vi.fn(), onUnpin: vi.fn() }}
      />
      <HomeConfirmHost />
    </>
  );
  return { onRemove };
}

const ANA = { kind: "person" as const, address: homeAddress("k2:connect:ana", HA), workspaceId: null, label: "Ana" };
const CRIT = { kind: "channel" as const, address: homeAddress("502", HA), workspaceId: null, label: "design-crit" };
const MIA = { kind: "person" as const, address: homeAddress("k2:connect:mia", HB), workspaceId: null, label: "Mia Chen" };

beforeEach(() => {
  __resetHomeChatRowsStoreForTests();
  __resetHomeChatSeamsForTests();
  resetHomeChatStore();
  for (const f of Object.values(api)) f.mockReset();
  api.refreshHomeChatGate.mockImplementation(async (scope: { id: string }) => useHomeChatRowsStore.getState().byServer[scope.id]?.gate);
  api.fetchHomeChatSummary.mockResolvedValue({ ok: true, chat: "live", convs: [] });
  api.fetchHomeChatChannels.mockResolvedValue({ ok: true, channels: [], next: null });
  api.fetchHomeChatPeople.mockResolvedValue({ ok: true, me: { ext: "", memberId: null }, people: [] });
  seed();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A tap on a menu item: a fresh press inside the menu arms it. */
function tap(el: HTMLElement) {
  fireEvent.pointerDown(el);
  fireEvent.click(el);
}

function hold(el: HTMLElement) {
  vi.useFakeTimers();
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  act(() => {
    vi.advanceTimersByTime(HOLD_MENU_MS + 10);
  });
  fireEvent.pointerUp(el);
  vi.useRealTimers();
}

describe("person and channel rows on Home", () => {
  it("draws a person (initials on their colour, the DM's count) and a channel (lock, a dot); a Mac server's row is greyed, not dropped", () => {
    renderList(homeWith([ANA, CRIT, MIA]));
    const ana = screen.getByTestId("home-chat-person-k2:connect:ana");
    // The name comes from the server's people list, not the stored label.
    expect(ana.textContent).toContain("Ana Ruiz");
    expect(ana.querySelector("[data-testid=person-avatar]")?.textContent).toBe("AR");
    expect(ana.querySelector("[data-testid=row-unread-count]")?.textContent).toBe("3");
    const crit = screen.getByTestId("home-chat-channel-502");
    expect(crit.querySelector("[data-channel-glyph]")?.getAttribute("data-channel-glyph")).toBe("lock");
    expect(crit.querySelector("[data-testid=row-unread-dot]")).not.toBeNull();
    expect(crit.querySelector("[data-testid=row-unread-count]")).toBeNull();
    const mia = screen.getByTestId("home-chat-person-k2:connect:mia");
    expect(mia.closest("[data-home-row]")?.getAttribute("data-greyed")).toBe("1");
    expect(mia.textContent).toContain(HOME_CHAT_COPY_ROW_NO_CHAT);
    expect(mia.textContent).not.toContain("Linux");
    expect(mia.textContent).toContain("Parity");
  });

  it("a tap on a person opens (or makes) the DM first, then the real chat view (kind dm)", async () => {
    api.openHomeChatDm.mockResolvedValue({ ok: true, conv: "601", created: false });
    renderList(homeWith([ANA]));
    fireEvent.click(screen.getByTestId("home-chat-person-k2:connect:ana"));
    await waitFor(() => expect(useHomeChatStore.getState().open).not.toBeNull());
    expect(api.openHomeChatDm.mock.calls[0][1]).toBe("k2:connect:ana");
    expect(useHomeChatStore.getState().open).toEqual({
      serverId: "sa",
      kind: "dm",
      conversationId: "601",
      title: "Ana Ruiz",
      ext: "k2:connect:ana",
    });
    // The DM is remembered: no second /dm.
    expect(useHomeChatRowsStore.getState().byServer.sa.dms["k2:connect:ana"]).toBe("601");
  });

  it("a channel opens the real view by its id, with invite-only; a row on a server without chat opens nothing", async () => {
    renderList(homeWith([CRIT, MIA]));
    fireEvent.click(screen.getByTestId("home-chat-channel-502"));
    await waitFor(() => expect(useHomeChatStore.getState().open).not.toBeNull());
    expect(useHomeChatStore.getState().open).toEqual({
      serverId: "sa",
      kind: "channel",
      conversationId: "502",
      title: "design-crit",
      inviteOnly: true,
    });
    expect(api.openHomeChatDm).not.toHaveBeenCalled();
    act(() => closeHomeChat());
    fireEvent.click(screen.getByTestId("home-chat-person-k2:connect:mia"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useHomeChatStore.getState().open).toBeNull();
  });

  it("a handler set on the seam wins (tests, a later push tap)", async () => {
    const opened = vi.fn();
    setOpenHomeChatHandler(opened);
    renderList(homeWith([CRIT]));
    fireEvent.click(screen.getByTestId("home-chat-channel-502"));
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(opened.mock.calls[0][0]).toMatchObject({ kind: "channel", conversationId: "502", address: CRIT.address });
    expect(useHomeChatStore.getState().open).toBeNull();
  });

  it("a channel deleted in the chat view greys its row; one left comes off every group", async () => {
    const ch = (conv: string, label: string) => ({ kind: "channel" as const, address: homeAddress(conv, HA), workspaceId: null, label });
    useHomesStore.setState((s) => ({
      homes: [
        { ...s.homes[0], id: "g1", rows: [ch("502", "design-crit"), ch("503", "launch")] },
        { id: "g2", name: "Other", rows: [ch("503", "launch")] },
      ],
      selectedId: "g1",
    }));
    function Live() {
      useHomeChatGoneRows(true);
      return null;
    }
    render(<Live />);
    act(() => noteHomeChatGone({ serverId: "sa", conv: "502", why: "deleted" }));
    expect(useHomeChatRowsStore.getState().deleted["sa|502"]).toBe(true);
    act(() => noteHomeChatGone({ serverId: "sa", conv: "503", why: "left" }));
    const homes = useHomesStore.getState().homes;
    expect(homes.find((h) => h.id === "g1")!.rows.map((r) => r.label)).toEqual(["design-crit"]);
    expect(homes.find((h) => h.id === "g2")!.rows).toEqual([]);
    cleanup();
    renderList(homeWith([ch("502", "design-crit")]));
    const row = screen.getByTestId("home-chat-channel-502");
    expect(row.closest("[data-home-row]")?.getAttribute("data-greyed")).toBe("1");
    expect(row.textContent).toContain(CHANNEL_DELETED_LINE);
  });

  it("the hold menu: Call (person, chat offered) goes through its seam; Remove asks, Cancel keeps the row", async () => {
    const called = vi.fn();
    setCallPersonHandler(called);
    const { onRemove } = renderList(homeWith([ANA, CRIT]));
    hold(screen.getByTestId("home-chat-person-k2:connect:ana"));
    const menu = screen.getByTestId("home-row-menu");
    const labels = Array.from(menu.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Open", "Call", "Pin", "Remove from Launch"]);
    tap(screen.getByText("Call"));
    expect(called).toHaveBeenCalledWith("sa", expect.objectContaining({ ext: "k2:connect:ana", displayName: "Ana Ruiz", username: "ana" }));

    // A channel has no Call.
    hold(screen.getByTestId("home-chat-channel-502"));
    expect(screen.queryByText("Call")).toBeNull();
    tap(screen.getByText("Remove from Launch"));
    expect(await screen.findByTestId("home-remove-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("home-remove-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("home-remove-confirm")).toBeNull());
    expect(onRemove).not.toHaveBeenCalled();

    hold(screen.getByTestId("home-chat-channel-502"));
    tap(screen.getByText("Remove from Launch"));
    fireEvent.click(await screen.findByTestId("home-remove-confirm-remove"));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(CRIT.address));
  });

  it("the hold menu lifts the held row above a dim (K2 Design 4.3.0): its words never run under the menu", async () => {
    renderList(homeWith([ANA, CRIT]));
    const ana = screen.getByTestId("home-chat-person-k2:connect:ana");
    const rowEl = ana.closest<HTMLElement>("[data-home-row]")!;
    hold(ana);
    expect(screen.getByTestId("home-row-menu-backdrop").getAttribute("data-dim")).toBe("1");
    const lifted = screen.getByTestId("home-row-menu-lifted");
    expect(lifted.textContent).toContain("Ana Ruiz");
    expect(lifted.style.background).toBe("var(--color-bg-elevated)");
    expect(rowEl.style.visibility).toBe("hidden");
    // One row in the page's tree (the copy carries no test ids).
    expect(screen.getAllByTestId("home-chat-person-k2:connect:ana")).toHaveLength(1);
    tap(screen.getByTestId("home-row-menu-backdrop"));
    await waitFor(() => expect(screen.queryByTestId("home-row-menu")).toBeNull());
    expect(rowEl.style.visibility).toBe("");
  });

  it("a pinned row (past the grid) wears a quiet pin in its trailing meta; others none", () => {
    renderList(homeWith([ANA, CRIT]), vi.fn(), [ANA.address]);
    const pin = screen.getByTestId("home-chat-person-k2:connect:ana").querySelector<SVGElement>("[data-testid=row-pin-mark]");
    expect(pin).not.toBeNull();
    expect(pin!.getAttribute("width")).toBe("12");
    expect(pin!.closest("[data-testid=row-when]")).not.toBeNull();
    expect(screen.getByTestId("home-chat-channel-502").querySelector("[data-testid=row-pin-mark]")).toBeNull();
  });
});

describe("Add to Home: People", () => {
  const servers: ChatPickServer[] = [
    { id: "sa", label: "Studio", host: HA },
    { id: "sb", label: "Parity", host: HB },
  ];

  function renderPeople(home: Home, onAddRow = vi.fn(() => true)) {
    // People read with each server's own login; here the seeded lists stand.
    api.fetchHomeChatPeople.mockImplementation(async (scope: { id: string }) => {
      const p = useHomeChatRowsStore.getState().byServer[scope.id]?.people;
      return p ? { ok: true, ...p } : { ok: false, kind: "network", code: "network", hint: "down", status: null };
    });
    api.fetchHomeChatSummary.mockResolvedValue({ ok: true, chat: "live", convs: [] });
    render(
      <>
        <PeoplePanel home={home} servers={servers} q="" onAddRow={onAddRow} />
        <HomeConfirmHost />
      </>
    );
    return onAddRow;
  }

  beforeEach(() => {
    seedHomeChatServer("sa", {
      people: {
        me: { ext: "k2:connect:me", memberId: "2" },
        people: [person("k2:connect:ana", "ana", "Ana Ruiz"), person("k2:connect:dev", "dev", "Dev Patel", false)],
      },
    });
  });

  it("lists each server's people; Setting up… can't be picked; a Mac server says why; a pick adds a person row", async () => {
    const onAddRow = renderPeople(homeWith([]));
    expect(screen.getByTestId("add-people-status-sb").textContent).toBe("Chat isn’t available on Parity. It needs a Linux server.");
    fireEvent.click(screen.getByTestId("add-person-sa-k2:connect:dev"));
    expect(screen.getByTestId("add-person-sa-k2:connect:dev").textContent).toContain("Setting up…");
    expect(onAddRow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("add-person-sa-k2:connect:ana"));
    await waitFor(() => expect(onAddRow).toHaveBeenCalled());
    expect(onAddRow.mock.calls[0]).toEqual([
      { kind: "person", address: "k2:connect:ana::studio.example", workspaceId: null, label: "Ana Ruiz" },
    ]);
  });

  it("Same person? when a match is on this group from another server: Same person and Cancel add nothing; Different adds", async () => {
    // Ana is already on Launch from Parity (its people list read).
    seedHomeChatServer("sb", { gate: gate(true), people: { me: { ext: "k2:connect:me", memberId: "2" }, people: [person("k2:connect:a2", "ana", "Ana R.")] } });
    const home = homeWith([{ kind: "person", address: homeAddress("k2:connect:a2", HB), workspaceId: null, label: "Ana R." }]);
    const onAddRow = renderPeople(home);
    const pick = () => fireEvent.click(screen.getByTestId("add-person-sa-k2:connect:ana"));

    pick();
    expect((await screen.findByTestId("same-person-title")).textContent).toBe("Is Ana Ruiz the same person as Ana R. on Parity?");
    fireEvent.click(screen.getByTestId("same-person-same"));
    await waitFor(() => expect(screen.queryByTestId("same-person")).toBeNull());
    expect(onAddRow).not.toHaveBeenCalled();

    pick();
    fireEvent.click(await screen.findByTestId("same-person-cancel"));
    await waitFor(() => expect(screen.queryByTestId("same-person")).toBeNull());
    expect(onAddRow).not.toHaveBeenCalled();

    pick();
    fireEvent.click(await screen.findByTestId("same-person-different"));
    await waitFor(() => expect(onAddRow).toHaveBeenCalledTimes(1));
  });
});

describe("Add to Home: New channel", () => {
  const servers: ChatPickServer[] = [{ id: "sa", label: "Studio", host: HA }];

  it("makes it (Invite only by default, the ticked people), waits for Sew's id, then adds the row", async () => {
    seedHomeChatServer("sa", { people: { me: { ext: "k2:connect:me", memberId: "2" }, people: [person("k2:connect:ana", "ana", "Ana Ruiz")] } });
    api.fetchHomeChatPeople.mockImplementation(async () => ({ ok: true, ...useHomeChatRowsStore.getState().byServer.sa.people }));
    api.createHomeChatChannel.mockResolvedValue({ ok: true, slug: "c-x1", conv: null, state: "pending", name: "launch", open: false });
    api.waitForHomeChatChannel.mockResolvedValue({ ok: true, conv: "777" });
    api.fetchHomeChatChannels.mockResolvedValue({ ok: true, channels: [], next: null });
    const onAddRow = vi.fn(() => true);
    render(<NewChannelForm servers={servers} onAddRow={onAddRow} />);
    fireEvent.change(screen.getByTestId("new-channel-name"), { target: { value: "  launch " } });
    fireEvent.click(screen.getByTestId("new-channel-member-k2:connect:ana"));
    fireEvent.click(screen.getByTestId("new-channel-create"));
    await waitFor(() => expect(onAddRow).toHaveBeenCalled());
    expect(api.createHomeChatChannel.mock.calls[0][1]).toEqual({ name: "launch", open: false, members: ["k2:connect:ana"] });
    expect(api.waitForHomeChatChannel.mock.calls[0][1]).toBe("c-x1");
    expect(api.waitForHomeChatChannel.mock.calls[0][2]).toMatchObject({ waitMs: 30_000, pollMs: 1_000 });
    expect(onAddRow.mock.calls[0]).toEqual([{ kind: "channel", address: "777::studio.example", workspaceId: null, label: "launch" }]);
  });

  it("Open is a choice; on timeout it says the desktop's line and adds nothing", async () => {
    api.fetchHomeChatPeople.mockResolvedValue({ ok: true, me: { ext: "", memberId: null }, people: [] });
    api.createHomeChatChannel.mockResolvedValue({ ok: true, slug: "c-x2", conv: null, state: "pending", name: "x", open: true });
    api.waitForHomeChatChannel.mockResolvedValue({ ok: true, conv: null });
    const onAddRow = vi.fn(() => true);
    render(<NewChannelForm servers={servers} onAddRow={onAddRow} />);
    fireEvent.change(screen.getByTestId("new-channel-name"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("new-channel-privacy-open"));
    expect(screen.getByTestId("new-channel-privacy-hint").textContent).toContain("Everyone on this server can find it and join.");
    fireEvent.click(screen.getByTestId("new-channel-create"));
    await waitFor(() => expect(screen.getByTestId("new-channel-state").textContent).toBe(HOME_CHAT_CREATE_TIMEOUT_COPY));
    expect(api.createHomeChatChannel.mock.calls[0][1]).toMatchObject({ open: true });
    expect(onAddRow).not.toHaveBeenCalled();
  });
});

describe("Add to Home: the sheet's tabs", () => {
  const base = {
    hostKey: HA,
    agents: [],
    projects: [],
    groups: null,
    otherServers: [],
    onAdd: vi.fn(),
    onRemove: vi.fn(),
  };

  it("no server offers chat: today's Add Agent, no tab bar", () => {
    render(<AddAgentSheet {...base} home={homeWith([])} onClose={vi.fn()} />);
    expect(screen.getByText("Add Agent")).toBeTruthy();
    expect(screen.queryByTestId("add-to-home-tab")).toBeNull();
  });

  it("offered: Add to Home, Adds to <group>, Agents · People · Channels; the tab is kept per group; a person added closes it", async () => {
    localStorage.removeItem("k2.addToHome.tab.h1");
    const onClose = vi.fn();
    const onAddRow = vi.fn(() => true);
    const chat = { groupIcon: "rocket", groupNumber: 1, servers: [{ id: "sa", label: "Studio", host: HA }], onAddRow };
    const { unmount } = render(<AddAgentSheet {...base} home={homeWith([])} onClose={onClose} chat={chat} />);
    expect(screen.getByText("Add to Home")).toBeTruthy();
    expect(screen.getByTestId("add-to-home-target").textContent).toContain("Launch");
    expect(screen.getByTestId("add-agent-this")).toBeTruthy();
    fireEvent.click(screen.getByTestId("add-to-home-tab-people"));
    expect(localStorage.getItem("k2.addToHome.tab.h1")).toBe("people");
    expect((screen.getByTestId("add-agent-search") as HTMLInputElement).placeholder).toBe("Search people…");
    fireEvent.click(screen.getByTestId("add-person-sa-k2:connect:ana"));
    await waitFor(() => expect(onAddRow).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    unmount();
    // Next open lands on People.
    render(<AddAgentSheet {...base} home={homeWith([])} onClose={vi.fn()} chat={chat} />);
    expect(screen.getByTestId("add-to-home-people")).toBeTruthy();
    fireEvent.click(screen.getByTestId("add-to-home-tab-channels"));
    fireEvent.click(screen.getByTestId("add-channels-mode-new"));
    expect(screen.getByTestId("new-channel")).toBeTruthy();
    expect(screen.queryByTestId("add-agent-search")).toBeNull();
  });
});

// Keep the Homes store quiet between files.
afterEach(() => useHomesStore.getState().reload());
