// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

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
import { AgentRowContent } from "./AgentRowContent";
import { useHomesStore } from "./homes";
import { rowUnreadOf, unreadKey, type UnreadEntry } from "./unread";
import { __resetUnreadStoreForTests, useUnreadStore } from "./unreadStore";
import {
  BackUnreadPill,
  MuteMenuItems,
  ServerUnreadPill,
  useBackUnreadCount,
} from "./UnreadMarks";

const entry = (over: Partial<UnreadEntry> & { id: string }): UnreadEntry => ({
  kind: "thread",
  projectId: null,
  lastReadSeq: 0,
  lastSeq: 0,
  unread: 0,
  waiting: 0,
  muted: false,
  mutedUntil: null,
  ...over,
});

function seed(serverId: string, entries: UnreadEntry[], total: number, waitingTotal = 0) {
  const byKey: Record<string, UnreadEntry> = {};
  for (const e of entries) byKey[unreadKey(e.kind, e.id)] = e;
  useUnreadStore.setState((s) => ({
    servers: { ...s.servers, [serverId]: { byKey, total, waitingTotal, loaded: true } },
  }));
}

function row(unread: ReturnType<typeof rowUnreadOf>) {
  return render(
    <AgentRowContent name="Appa" initial="A" busy={null} when="" preview="hello" unread={unread} />
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  __resetScopesForTests();
  __resetUnreadStoreForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false },
      { id: "s2", nickname: "", url: "https://box.k2.dev", username: "baden", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok", s2: "tok" },
  });
  noteBootStatus("s1", { features: ["thread-read-v1"] });
  noteBootStatus("s2", { features: ["thread-read-v1"] });
});

describe("row marks", () => {
  it("unread: blue dot, bold name and line two, count pill when more than one", () => {
    row(rowUnreadOf(entry({ id: "c1", unread: 3 })));
    expect(screen.getByTestId("row-unread-dot").dataset.tone).toBe("unread");
    expect(screen.getByTestId("row-name").style.fontWeight).toBe("700");
    expect(screen.getByTestId("row-preview").style.fontWeight).toBe("600");
    expect(screen.getByTestId("row-unread-count").textContent).toBe("3");
  });

  it("one unread: the dot only", () => {
    row(rowUnreadOf(entry({ id: "c1", unread: 1 })));
    expect(screen.getByTestId("row-unread-dot")).toBeTruthy();
    expect(screen.queryByTestId("row-unread-count")).toBeNull();
  });

  it("99+ above 99", () => {
    row(rowUnreadOf(entry({ id: "c1", unread: 100 })));
    expect(screen.getByTestId("row-unread-count").textContent).toBe("99+");
  });

  it("waiting on you: amber, ahead of unread", () => {
    row(rowUnreadOf(entry({ id: "c1", unread: 4, waiting: 2 })));
    expect(screen.getByTestId("row-unread-dot").dataset.tone).toBe("waiting");
    expect(screen.getByTestId("row-unread-count").dataset.tone).toBe("waiting");
    expect(screen.getByTestId("row-unread-count").textContent).toBe("2");
  });

  it("muted: grey count, not bold, bell-slash", () => {
    row(rowUnreadOf(entry({ id: "c1", unread: 5, muted: true })));
    expect(screen.getByTestId("row-unread-dot").dataset.tone).toBe("muted");
    expect(screen.getByTestId("row-unread-count").dataset.tone).toBe("muted");
    expect(screen.getByTestId("row-name").style.fontWeight).toBe("");
    expect(screen.getByTestId("row-muted")).toBeTruthy();
  });

  it("nothing to show (or no feature): today's row", () => {
    row(null);
    expect(screen.queryByTestId("row-unread-dot")).toBeNull();
    expect(screen.queryByTestId("row-unread-count")).toBeNull();
    expect(screen.queryByTestId("row-muted")).toBeNull();
    expect(screen.getByTestId("row-name").style.fontWeight).toBe("");
  });
});

describe("back arrow", () => {
  it("from Agents: the server's total minus the open chat", () => {
    seed("s1", [entry({ id: "c1", unread: 3 }), entry({ id: "c2", unread: 4 })], 7);
    useUnreadStore.getState().noteAddr("s1", "appa", "c1");
    const { result } = renderHook(() =>
      useBackUnreadCount({ origin: "agents", serverId: "s1", open: { kind: "thread", addr: "appa" }, multiOn: true })
    );
    expect(result.current).toBe(4);
  });

  it("from Home: Home rows on every server, the open one left out", () => {
    seed("s1", [entry({ id: "c1", unread: 3 }), entry({ id: "c9", unread: 40 })], 43);
    seed("s2", [entry({ id: "d1", unread: 2 }), entry({ id: "d2", unread: 6, muted: true })], 2);
    useUnreadStore.getState().noteAddr("s1", "appa", "c1");
    useUnreadStore.getState().noteAddr("s1", "zuko", "c9");
    useUnreadStore.getState().noteAddr("s2", "momo", "d1");
    useUnreadStore.getState().noteAddr("s2", "katara", "d2");
    useHomesStore.setState({
      homes: [
        {
          id: "h1",
          name: "Home",
          rows: [
            { address: "appa::dtl.k2.dev", workspaceId: null, label: "Appa" },
            { address: "momo::box.k2.dev", workspaceId: null, label: "Momo" },
            { address: "katara::box.k2.dev", workspaceId: null, label: "Katara" },
          ],
        },
      ],
      selectedId: "h1",
    });
    const open = { kind: "thread" as const, addr: "appa" };
    const on = renderHook(() => useBackUnreadCount({ origin: "home", serverId: "s1", open, multiOn: true }));
    // momo 2; katara muted; zuko not on the Home; appa is open.
    expect(on.result.current).toBe(2);
    const off = renderHook(() => useBackUnreadCount({ origin: "home", serverId: "s1", open: null, multiOn: false }));
    // Flag off: the active server's Home rows only.
    expect(off.result.current).toBe(3);
  });

  it("the pill: hidden at 0, 99+ above 99", () => {
    const { rerender } = render(<BackUnreadPill count={0} />);
    expect(screen.queryByTestId("chat-back-unread")).toBeNull();
    rerender(<BackUnreadPill count={12} />);
    expect(screen.getByTestId("chat-back-unread").textContent).toBe("12");
    rerender(<BackUnreadPill count={250} />);
    expect(screen.getByTestId("chat-back-unread").textContent).toBe("99+");
  });

  it("without the feature: 0", () => {
    const { result } = renderHook(() =>
      useBackUnreadCount({ origin: "agents", serverId: "s1", open: null, multiOn: true })
    );
    expect(result.current).toBe(0);
  });
});

describe("server card pill", () => {
  it("shows that server's total; amber while a card waits; nothing at 0", () => {
    seed("s1", [], 5);
    seed("s2", [], 2, 1);
    render(
      <>
        <ServerUnreadPill serverId="s1" />
        <ServerUnreadPill serverId="s2" />
        <ServerUnreadPill serverId="s3" />
      </>
    );
    const pills = screen.getAllByTestId("server-unread");
    expect(pills.map((p) => p.textContent)).toEqual(["5", "2"]);
    expect(pills[1].dataset.tone).toBe("waiting");
  });
});

describe("mute menu", () => {
  it("Mute → durations → the route; Unmute when muted", async () => {
    seed("s1", [entry({ id: "c1", unread: 2 })], 2);
    useUnreadStore.getState().noteAddr("s1", "appa", "c1");
    vi.mocked(api.postThreadMute).mockResolvedValue({
      ok: true,
      data: { kind: "thread", id: "c1", unread: 2, waiting: 0, muted: true, total: 0, waitingTotal: 0 },
    });
    const onDone = vi.fn();
    render(<MuteMenuItems serverId="s1" rowRef={{ kind: "thread", addr: "appa" }} onDone={onDone} />);
    fireEvent.click(screen.getByTestId("menu-mute"));
    expect(screen.getByTestId("menu-mute-3600")).toBeTruthy();
    expect(screen.getByTestId("menu-mute-28800")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("menu-mute-forever"));
    });
    expect(onDone).toHaveBeenCalled();
    expect(api.postThreadMute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      { kind: "thread", conversationId: "c1", addr: "appa" },
      true,
      undefined
    );
    expect(screen.getByTestId("menu-unmute")).toBeTruthy();
  });

  it("not offered on a server without the feature", () => {
    noteBootStatus("s1", { features: [] });
    render(<MuteMenuItems serverId="s1" rowRef={{ kind: "thread", addr: "appa" }} onDone={() => {}} />);
    expect(screen.queryByTestId("menu-mute")).toBeNull();
  });
});
