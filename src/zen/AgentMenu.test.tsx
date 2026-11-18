// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../api/threadRead", () => ({
  getThreadUnread: vi.fn(),
  postThreadRead: vi.fn(),
  postProjectRead: vi.fn(),
  postThreadMute: vi.fn(),
}));
vi.mock("../lib/badgeTotals", () => ({
  setServerTotals: vi.fn(),
  clearServerTotals: vi.fn(),
  onBadgeTotals: vi.fn(async () => () => {}),
}));

import * as api from "../api/threadRead";
import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { AgentMenu, agentMenuPlacement, liftedMenuPlacement, type AgentMenuEntry } from "./AgentMenu";
import { unreadKey, type UnreadEntry } from "./unread";
import { __resetUnreadStoreForTests, useUnreadStore } from "./unreadStore";
import { menuLabels, tap } from "../test/rearrangeDrag";

// The one agent menu: entries in order, only what applies; the hold's own
// release / synthetic click never runs an item.

const RECT = { left: 100, top: 200, right: 300, bottom: 260, width: 200 };

function entries(spy: (k: string) => void): AgentMenuEntry[] {
  return [
    { key: "open", label: "Open", onSelect: () => spy("open") },
    { key: "pin", label: "Pin", onSelect: () => spy("pin") },
    { key: "mute", mute: { serverId: "s1", rowRef: { kind: "thread", addr: "aspen" } } },
    { key: "group", label: "Move to group…", onSelect: () => spy("group") },
    { key: "rearrange", label: "Rearrange", onSelect: () => spy("rearrange") },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetScopesForTests();
  __resetUnreadStoreForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [{ id: "s1", nickname: "", url: "https://dune.k2.dev", username: "bob", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok" },
  });
  noteBootStatus("s1", { features: ["thread-read-v1"] });
  const e: UnreadEntry = {
    id: "c1",
    kind: "thread",
    projectId: null,
    lastReadSeq: 0,
    lastSeq: 0,
    unread: 1,
    waiting: 0,
    muted: false,
    mutedUntil: null,
  };
  useUnreadStore.setState((s) => ({
    servers: { ...s.servers, s1: { byKey: { [unreadKey("thread", "c1")]: e }, total: 1, waitingTotal: 0, loaded: true } },
  }));
  useUnreadStore.getState().noteAddr("s1", "aspen", "c1");
});
afterEach(cleanup);

describe("AgentMenu", () => {
  it("lists the entries in order, Mute in its place, as a glass menu", () => {
    render(<AgentMenu label="Options for aspen" menu={{ id: "a", rect: RECT, armed: true }} entries={entries(vi.fn())} onClose={vi.fn()} />);
    const menu = screen.getByTestId("agent-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.className).toMatch(/zen-glass/);
    expect(menuLabels(menu)).toEqual(["Open", "Pin", "Mute", "Move to group…", "Rearrange"]);
  });

  it("Mute is left out on a server without read state", () => {
    noteBootStatus("s1", { features: [] });
    render(<AgentMenu label="x" menu={{ id: "a", rect: RECT, armed: true }} entries={entries(vi.fn())} onClose={vi.fn()} />);
    expect(menuLabels(screen.getByTestId("agent-menu"))).toEqual(["Open", "Pin", "Move to group…", "Rearrange"]);
  });

  it("opened by a hold: clicks need a fresh press; an item closes the menu, then runs", () => {
    const spy = vi.fn();
    const onClose = vi.fn();
    render(<AgentMenu label="x" menu={{ id: "a", rect: RECT, armed: false }} entries={entries(spy)} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("menu-pin"));
    fireEvent.click(screen.getByTestId("agent-menu-backdrop"));
    expect(spy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    tap(screen.getByTestId("menu-pin"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("pin");
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(spy.mock.invocationCallOrder[0]);
  });

  it("Mute opens its durations; a duration mutes and closes", async () => {
    vi.mocked(api.postThreadMute).mockResolvedValue({
      ok: true,
      data: { kind: "thread", id: "c1", unread: 1, waiting: 0, muted: true, total: 0, waitingTotal: 0 },
    });
    const onClose = vi.fn();
    render(<AgentMenu label="x" menu={{ id: "a", rect: RECT, armed: false }} entries={entries(vi.fn())} onClose={onClose} />);
    tap(screen.getByTestId("menu-mute"));
    expect(screen.getByTestId("menu-mute-3600")).toBeTruthy();
    await act(async () => {
      tap(screen.getByTestId("menu-mute-forever"));
    });
    expect(onClose).toHaveBeenCalled();
    expect(api.postThreadMute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { kind: "thread", conversationId: "c1", addr: "aspen" },
      true,
      undefined
    );
  });

  it("opened by right-click (armed): the first click works", () => {
    const spy = vi.fn();
    render(<AgentMenu label="x" menu={{ id: "a", rect: RECT, armed: true }} entries={entries(spy)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("menu-open"));
    expect(spy).toHaveBeenCalledWith("open");
  });

  it("sits under the pressed row, or above it when there is no room below", () => {
    const below = agentMenuPlacement(RECT, 4, "end", 800);
    expect(below.top).toBe(266);
    expect(below.right).toBe(16);
    expect(below.bottom).toBeUndefined();
    const low = { ...RECT, top: 640, bottom: 700 };
    const above = agentMenuPlacement(low, 4, "end", 800);
    expect(above.bottom).toBeUndefined();
    // Placed by its top, ending 6 px above the row.
    expect(above.top).toBe(640 - 6 - (4 * 44 + 12));
    // The keyboard takes the bottom: a row near it gets its menu above.
    const nearKeyboard = { ...RECT, top: 330, bottom: 370 };
    const withKeyboard = agentMenuPlacement(nearKeyboard, 3, "end", 420);
    expect(withKeyboard.top).toBeLessThan(330);
    const centred = agentMenuPlacement(RECT, 2, "center", 800);
    expect(centred.left).toContain("200px - 110px");
  });

  it("lifted: the head above the lifted rect, the menu under it; a low message moves up to make room; near the top the head goes under it", () => {
    const p = liftedMenuPlacement(RECT, 4, "center", 800, 40);
    // Head: 8 px above the rect; menu: 6 px under the rect, clear of it.
    expect(p.head?.top).toBe(200 - 8 - 40);
    expect(p.menu.top).toBe(266);
    expect(p.shift).toBe(0);
    const high = { ...RECT, top: 30, bottom: 90 };
    const q = liftedMenuPlacement(high, 4, "center", 800, 40);
    expect(q.head?.top).toBe(98);
    expect(q.menu.top).toBe(98 + 40 + 8);
    // Too low for the menu below: the message moves up (iOS), the order
    // stays emoji bar, message, menu.
    const low = { ...RECT, top: 640, bottom: 700 };
    const r = liftedMenuPlacement(low, 4, "center", 800, 40);
    expect(r.shift).toBe(700 + 6 + (4 * 44 + 12) + 16 - 800);
    expect(r.head?.top).toBe(640 - r.shift - 48);
    expect(r.menu.top).toBe(700 - r.shift + 6);
    // A message too tall to move: the menu goes above the head.
    const tall = { ...RECT, top: 70, bottom: 760 };
    const t = liftedMenuPlacement(tall, 4, "center", 800, 40);
    expect(t.shift).toBe(6);
    expect(t.head?.top).toBe(70 - 6 - 48);
    // No head: the plain placement.
    expect(liftedMenuPlacement(RECT, 4, "end", 800, 0)).toEqual({ menu: agentMenuPlacement(RECT, 4, "end", 800), head: null, shift: 0 });
  });

  it("lifted: dims and blurs the page, copies the held row above the dim (on a raised surface), hides the row until it closes", () => {
    const row = document.createElement("div");
    row.setAttribute("data-home-row", "a");
    row.setAttribute("data-testid", "the-row");
    row.style.marginTop = "6px";
    row.innerHTML = '<button data-testid="the-button">Ana Ruiz</button>';
    document.body.appendChild(row);
    const onClose = vi.fn();
    const { unmount } = render(
      <AgentMenu label="x" menu={{ id: "a", rect: RECT, armed: true }} entries={entries(vi.fn())} onClose={onClose} lift={() => row} liftSurface testId="home-row-menu" />
    );
    const backdrop = screen.getByTestId("home-row-menu-backdrop");
    expect(backdrop.style.background).toBe("var(--color-scrim)");
    expect(backdrop.style.backdropFilter).toContain("blur");
    const lifted = screen.getByTestId("home-row-menu-lifted");
    expect(lifted.style.background).toBe("var(--color-bg-elevated)");
    expect(lifted.getAttribute("aria-hidden")).toBe("true");
    expect(lifted.textContent).toBe("Ana Ruiz");
    const copy = lifted.firstElementChild as HTMLElement;
    expect(copy.hasAttribute("data-home-row")).toBe(false);
    expect(copy.style.margin).toBe("0px");
    expect(screen.getAllByTestId("the-button")).toHaveLength(1);
    expect(row.style.visibility).toBe("hidden");
    // The menu material at its full fill.
    expect(screen.getByTestId("home-row-menu").style.background).not.toBe("");
    unmount();
    expect(row.style.visibility).toBe("");
    row.remove();
  });

  it("not lifted (Agents rows, the Thread): no dim, the plain glass, in place", () => {
    render(<AgentMenu label="x" menu={{ id: "a", rect: RECT, armed: true }} entries={entries(vi.fn())} onClose={vi.fn()} />);
    expect(screen.getByTestId("agent-menu-backdrop").style.background).toBe("transparent");
    expect(screen.queryByTestId("agent-menu-lifted")).toBeNull();
    expect(screen.getByTestId("agent-menu").style.background).toBe("");
  });
});
