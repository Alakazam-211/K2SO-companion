// @vitest-environment jsdom
// Who is typing in an agent Thread (K2 `thread-typing-v1`): our own
// `typing` frames ride the Thread's live socket at most once per 3 s; other
// readers' frames show Home chat's line on the composer's top edge, held
// 10 s, cleared by their message. Without the feature: nothing either way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(async () => ({ ok: true, data: { items: [] } })),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});
const live = vi.hoisted(() => ({
  opts: null as null | { onItem: (raw: unknown) => void },
  sendTyping: null as null | ((thread: string) => boolean),
}));
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn((opts: { onItem: (raw: unknown) => void }) => {
    live.opts = opts;
    return { stop: vi.fn(), setViewing: vi.fn(), sendTyping: live.sendTyping };
  }),
}));
vi.mock("../stores/notifyPrefs", () => ({
  useNotifyPrefsStore: Object.assign(
    (sel: (s: { threadPush: Record<string, boolean> }) => unknown) => sel({ threadPush: {} }),
    { getState: () => ({ probe: async () => {} }) }
  ),
}));

import { postThread } from "../api/client";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { composerDraftKey, useComposerDrafts } from "./composerDrafts";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import type { DaemonFeature } from "../api/scope";

const TYPING: DaemonFeature[] = ["thread-typing-v1"];

function openRoom() {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "aspen",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "aspen",
    agents: [{ id: "aspen", name: "aspen", initial: "A", path: "/Users/Bob/Aspen", addr: "aspen" }],
    thread: [],
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
  });
}

let now = 1_700_000_000_000;
const sendTyping = vi.fn((_thread: string) => true);
const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const deliver = (raw: unknown) => act(() => live.opts!.onItem(raw));
const typingFrame = (member: string, name: string, over: Record<string, unknown> = {}) => ({
  collection: "typing",
  seq: 0,
  id: "aspen",
  member,
  name,
  kind: "person",
  at: now,
  ...over,
});
const words = () => screen.queryByTestId("home-chat-typing-words")?.textContent ?? null;

function setup(features: DaemonFeature[] | null = TYPING) {
  setZenScope(fakeScope({ id: "s1", username: "bob", features }));
  openRoom();
  return render(<ThreadPane />);
}

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  sendTyping.mockReset().mockReturnValue(true);
  live.opts = null;
  live.sendTyping = sendTyping;
  useComposerDrafts.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(postThread).mockReset();
  vi.restoreAllMocks();
});

describe("sending our typing", () => {
  it("at most one frame per 3 s while typing, for this Thread's addr", () => {
    setup();
    type("h");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenLastCalledWith("aspen");
    now += 1000;
    type("he");
    now += 1999;
    type("hel");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    now += 1;
    type("hell");
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("an empty field sends nothing; a send stops it (the clear is not typing)", async () => {
    vi.mocked(postThread).mockResolvedValue({ ok: true, data: { id: "n1", seq: 1 } } as never);
    setup();
    type("   ");
    expect(sendTyping).not.toHaveBeenCalled();
    type("hello");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    now += 500;
    type("");
    expect(sendTyping).toHaveBeenCalledTimes(1);
    now += 5000;
    type("go");
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.submit(screen.getByTestId("composer-form"));
    });
    expect(input().value).toBe("");
    now += 10_000;
    await act(async () => {});
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("a draft put back on open is not typing", () => {
    useComposerDrafts.getState().setDraft(composerDraftKey("s1", null, "aspen"), "unsent words");
    setup();
    expect(input().value).toBe("unsent words");
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("without thread-typing-v1: never sent", () => {
    setup(null);
    type("hello");
    now += 5000;
    type("hello again");
    expect(sendTyping).not.toHaveBeenCalled();
  });
});

describe("showing who is typing", () => {
  it("shows the name in a polite live region on the composer's edge; the pill clears it", () => {
    setup();
    const pillRow = screen.getByTestId("thread-jump-row");
    const pillBottom = parseFloat(pillRow.style.bottom);
    expect(words()).toBe("");
    deliver(typingFrame("mira", "Mira"));
    expect(words()).toBe("Mira is typing");
    expect(screen.getByTestId("home-chat-typing").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByTestId("thread-typing-row").contains(screen.getByTestId("home-chat-typing"))).toBe(true);
    // The pill keeps its 8 px gap over the line (2 px foot + 20 px line).
    expect(parseFloat(screen.getByTestId("thread-jump-row").style.bottom)).toBe(pillBottom + 22);
  });

  it("holds a name 10 s from its last frame", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setup();
    deliver(typingFrame("mira", "Mira"));
    now += 6000;
    act(() => void vi.advanceTimersByTime(6000));
    deliver(typingFrame("mira", "Mira"));
    now += 9000;
    act(() => void vi.advanceTimersByTime(9000));
    expect(words()).toBe("Mira is typing");
    now += 1001;
    act(() => void vi.advanceTimersByTime(1001));
    expect(words()).toBe("");
  });

  it("drops a member as soon as their message lands", () => {
    setup();
    deliver(typingFrame("mira", "Mira"));
    deliver(typingFrame("ben", "Ben"));
    expect(words()).toBe("Mira and Ben are typing");
    deliver({
      id: "m7",
      seq: 7,
      doc: { id: "m7", from: "Mira Diaz", body: "on it", created_at: 1, author: { kind: "user", login: "mira" } },
    });
    expect(words()).toBe("Ben is typing");
    expect(useZenStore.getState().thread.map((m) => m.text)).toEqual(["on it"]);
  });

  it("three or more: Mira and 2 others; my own login is never shown", () => {
    setup();
    deliver(typingFrame("mira", "Mira"));
    now += 1;
    deliver(typingFrame("ben", "Ben"));
    now += 1;
    deliver(typingFrame("bob", "Bob"));
    expect(words()).toBe("Mira and Ben are typing");
    deliver(typingFrame("ada", "Ada", { kind: "app_guest" }));
    expect(words()).toBe("Mira and 2 others are typing");
  });

  it("a typing frame (seq 0) never touches the message stream", () => {
    setup();
    deliver({ id: "m5", seq: 5, doc: { id: "m5", from: "aspen", body: "five", created_at: 1 } });
    const before = useZenStore.getState().thread;
    expect(before.map((m) => m.seq)).toEqual([5]);
    deliver(typingFrame("mira", "Mira"));
    expect(useZenStore.getState().thread).toBe(before);
    deliver({ id: "m6", seq: 6, doc: { id: "m6", from: "aspen", body: "six", created_at: 2 } });
    expect(useZenStore.getState().thread.map((m) => m.seq)).toEqual([5, 6]);
    // An agent's message doesn't clear a person.
    expect(words()).toBe("Mira is typing");
  });

  it("another Thread's frame is not shown", () => {
    setup();
    deliver(typingFrame("mira", "Mira", { id: "momo" }));
    expect(words()).toBe("");
  });

  it("without thread-typing-v1: no line, frames ignored", () => {
    setup(null);
    deliver(typingFrame("mira", "Mira"));
    expect(screen.queryByTestId("thread-typing-row")).toBeNull();
    expect(screen.queryByTestId("home-chat-typing")).toBeNull();
  });
});
