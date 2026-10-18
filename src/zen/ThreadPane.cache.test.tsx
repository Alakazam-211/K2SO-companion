// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
    serverHasFeature: vi.fn(async () => false),
  };
});
vi.mock("./overlayEvents", () => ({ connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })) }));
const marks: { viewing: boolean; newestSeq: number | null }[] = [];
vi.mock("./unreadRead", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./unreadRead")>();
  return {
    ...actual,
    useMarkReadWhileViewing: (o: { viewing: boolean; newestSeq: number | null }) => {
      marks.push({ viewing: o.viewing, newestSeq: o.newestSeq });
    },
  };
});

import { useServersStore } from "../stores/servers";
import { PROGRESSIVE_FIRST, ThreadPane } from "./ThreadPane";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";

function msg(seq: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return { id: `m${seq}`, seq, text: `message ${seq}`, from: "k2", at: 1, mine: false, kind: "text", choice: null, ...over };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));

beforeEach(() => {
  marks.length = 0;
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "t", url: "https://h.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t" },
  });
  useZenStore.setState({
    agentSource: "live",
    agentId: "k2",
    agents: [],
    threadSource: "live",
    threadAddr: "k2",
    threadGroupId: null,
    threadConversationId: "conv-1",
    threadError: null,
    threadFocusSeq: null,
    threadCached: false,
    thread: [],
    outbox: [],
  });
});
afterEach(() => cleanup());

describe("ThreadPane over a cached copy", () => {
  it("a cached paint is never 'viewing' for read marking; the confirmed copy is", async () => {
    useZenStore.setState({ thread: [msg(1), msg(2)], threadCached: true });
    render(<ThreadPane />);
    await act(async () => {});
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => !m.viewing)).toBe(true);
    act(() => useZenStore.setState({ threadCached: false }));
    expect(marks[marks.length - 1]).toEqual({ viewing: true, newestSeq: 2 });
  });

  it("a card in the cached copy waits for the server's copy before it can be answered", async () => {
    const card = msg(1, { choice: { prompt: "Ship?", options: ["Yes", "No"], answer: null } });
    useZenStore.setState({ thread: [card], threadCached: true });
    render(<ThreadPane />);
    const yes = screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    expect(yes.style.opacity).toBe("1"); // calm: not dimmed while it refreshes
    act(() => useZenStore.setState({ threadCached: false }));
    expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("no 'Loading' line over a cached paint", () => {
    useZenStore.setState({ thread: [msg(1)], threadCached: true });
    render(<ThreadPane />);
    expect(screen.queryByTestId("thread-loading")).toBeNull();
    expect(screen.getAllByTestId("thread-bubble")).toHaveLength(1);
  });
});

describe("progressive first paint", () => {
  it("a long chat draws its newest messages first, the rest a frame later", async () => {
    useZenStore.setState({ thread: many(50) });
    render(<ThreadPane />);
    const first = document.querySelectorAll("[data-thread-msg]");
    expect(first).toHaveLength(PROGRESSIVE_FIRST);
    expect(first[first.length - 1].getAttribute("data-seq")).toBe("50");
    await waitFor(() => expect(document.querySelectorAll("[data-thread-msg]")).toHaveLength(50));
  });

  it("a short chat draws everything at once", () => {
    useZenStore.setState({ thread: many(20) });
    render(<ThreadPane />);
    expect(document.querySelectorAll("[data-thread-msg]")).toHaveLength(20);
  });

  it("a push tap to a seq draws everything at once (the target may be old)", () => {
    useZenStore.setState({ thread: many(50), threadFocusSeq: 3 });
    render(<ThreadPane />);
    expect(document.querySelectorAll("[data-thread-msg]")).toHaveLength(50);
  });
});
