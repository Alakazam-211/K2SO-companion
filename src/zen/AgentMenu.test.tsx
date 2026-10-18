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
import { AgentMenu, agentMenuPlacement, type AgentMenuEntry } from "./AgentMenu";
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
    { key: "mute", mute: { serverId: "s1", rowRef: { kind: "thread", addr: "appa" } } },
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
    servers: [{ id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false }],
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
  useUnreadStore.getState().noteAddr("s1", "appa", "c1");
});
afterEach(cleanup);

describe("AgentMenu", () => {
  it("lists the entries in order, Mute in its place, as a glass menu", () => {
    render(<AgentMenu label="Options for appa" menu={{ id: "a", rect: RECT, armed: true }} entries={entries(vi.fn())} onClose={vi.fn()} />);
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
      { kind: "thread", conversationId: "c1", addr: "appa" },
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
    expect(above.top).toBeUndefined();
    expect(above.bottom).toBe(800 - 640 + 6);
    const centred = agentMenuPlacement(RECT, 2, "center", 800);
    expect(centred.left).toContain("200px - 110px");
  });
});
