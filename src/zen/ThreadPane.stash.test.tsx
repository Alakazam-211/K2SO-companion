// @vitest-environment jsdom
// The prompt stash in the Thread (spec "Prompt stash v1"; stash/): the tab
// on the composer, the sheet (activity drawer slides away while it is up),
// saving from the composer (write first, then clear), the cap, the message
// hold menu, and an agent's `stash.offer` card.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    postThread: vi.fn(),
    getThread: vi.fn(),
    getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })),
  };
});
vi.mock("./overlayEvents", () => ({
  connectOverlayEvents: vi.fn(() => ({ stop: vi.fn(), setViewing: vi.fn() })),
}));
vi.mock("../stores/notifyPrefs", () => ({
  useNotifyPrefsStore: Object.assign(
    (sel: (s: { threadPush: Record<string, boolean> }) => unknown) => sel({ threadPush: {} }),
    { getState: () => ({ probe: async () => {} }) }
  ),
}));

import { postThread } from "../api/client";
import { connectOverlayEvents } from "./overlayEvents";
import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { useComposerDrafts } from "./composerDrafts";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { memoryStashBackend } from "./stash/stashBackend";
import { STASH_MAX } from "./stash/stashModel";
import { __resetStashForTests, useStashStore } from "./stash/stashStore";
import { HOLD_MENU_MS } from "./useHoldMenu";
import type { ThreadMessage } from "./threadModel";

const agentMsg = (id: string, seq: number, text: string, over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id,
  seq,
  text,
  from: "appa",
  at: 1_760_000_000,
  mine: false,
  kind: "text",
  choice: null,
  ...over,
});

function activity(rev: number) {
  const now = Date.now();
  return {
    collection: "activity",
    seq: 0,
    id: "turn-1",
    activity: {
      turnId: "turn-1",
      state: "working",
      phase: "tool",
      phaseSince: now - 1_000,
      line: "Running `npm test`",
      startedAt: now - 20_000,
      tally: { read: 2, search: 0, cmd: 1, edit: 0 },
      end: null,
      serverNow: now,
      rev,
    },
  };
}

const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });
const live = () => useStashStore.getState().items.filter((i) => i.deleted_at == null);

beforeEach(() => {
  localStorage.clear();
  useComposerDrafts.getState().reload();
  __resetStashForTests(memoryStashBackend());
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-1",
    agentId: "appa",
    agents: [{ id: "appa", name: "Appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: [agentMsg("m1", 1, "Here is the plan.")],
    outbox: [],
    sending: false,
    sendError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.mocked(postThread).mockReset();
});

describe("the stash tab and sheet", () => {
  it("is always on the composer, beside the drawer slot, with the count", async () => {
    await useStashStore.getState().save({ text: "one" });
    await useStashStore.getState().save({ text: "two" });
    render(<ThreadPane />);
    const tab = await screen.findByTestId("stash-tab");
    expect(screen.getByTestId("composer-drawer-aside").contains(tab)).toBe(true);
    expect(screen.getByTestId("stash-tab-count").textContent).toBe("2");
    expect(tab.getAttribute("aria-label")).toBe("Stash, 2 saved");
  });

  it("a tap opens the sheet (newest first); the working drawer slides away until it closes", async () => {
    await useStashStore.getState().save({ text: "older" });
    await useStashStore.getState().save({ text: "newer" });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    act(() => vi.mocked(connectOverlayEvents).mock.calls[0][0].onItem(activity(1) as never));
    expect(screen.getByTestId("thread-working-strip").getAttribute("data-leaving")).toBeNull();

    const tab = screen.getByTestId("stash-tab");
    // Never takes focus (the keyboard is put away on purpose, not by a blur).
    expect(fireEvent.pointerDown(tab)).toBe(false);
    fireEvent.click(tab);
    const items = screen.getAllByTestId("stash-item");
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("newer"), expect.stringContaining("older")]);
    expect(screen.getByTestId("thread-working-strip").getAttribute("data-leaving")).toBe("true");

    fireEvent.click(screen.getByTestId("stash-sheet-done"));
    expect(screen.queryByTestId("stash-sheet")).toBeNull();
    expect(screen.getByTestId("thread-working-strip").getAttribute("data-leaving")).toBeNull();
  });

  it("choosing goes below any text, after a blank line, with its files; the stash keeps it", async () => {
    const png = new File(["png"], "shot.png", { type: "image/png" });
    await useStashStore.getState().save({ text: "stashed prompt", files: [png] });
    render(<ThreadPane />);
    type("hello  ");
    fireEvent.click(screen.getByTestId("stash-tab"));
    fireEvent.click(screen.getByTestId("stash-item"));
    expect(input().value).toBe("hello\n\nstashed prompt");
    expect(document.activeElement).toBe(input());
    expect(screen.queryByTestId("stash-sheet")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("attach-chip").textContent).toContain("shot.png"));
    expect(live()).toHaveLength(1);
  });

  it("'Remove from stash after use' drops it once chosen", async () => {
    useStashStore.getState().setRemoveAfterUse(true);
    await useStashStore.getState().save({ text: "one-shot" });
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("stash-tab"));
    fireEvent.click(screen.getByTestId("stash-item"));
    expect(input().value).toBe("one-shot");
    await waitFor(() => expect(live()).toHaveLength(0));
  });

  it("✕ deletes an item", async () => {
    await useStashStore.getState().save({ text: "gone soon" });
    render(<ThreadPane />);
    fireEvent.click(screen.getByTestId("stash-tab"));
    fireEvent.click(screen.getByTestId("stash-item-delete"));
    await waitFor(() => expect(screen.getByTestId("stash-empty")).not.toBeNull());
    expect(live()).toHaveLength(0);
  });
});

describe("saving from the composer", () => {
  it("the save button shows while focused with text; it writes first, then clears, keeping the keyboard", async () => {
    render(<ThreadPane />);
    expect(screen.queryByTestId("composer-stash-save")).toBeNull();
    act(() => input().focus());
    expect(screen.queryByTestId("composer-stash-save")).toBeNull();
    type("draft to keep");
    const save = screen.getByTestId("composer-stash-save");
    expect(fireEvent.pointerDown(save)).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(input().value).toBe(""));
    expect(live().map((i) => i.text)).toEqual(["draft to keep"]);
    expect(live()[0].source).toMatchObject({ serverId: "s1", agent: "appa", agentName: "Appa", user: "baden" });
    expect(document.activeElement).toBe(input());
    expect(screen.getByTestId("stash-tab-saved")).not.toBeNull();
  });

  it("a failed write keeps the draft and says so", async () => {
    const b = memoryStashBackend();
    b.put = vi.fn(() => Promise.reject(new Error("disk full")));
    __resetStashForTests(b);
    render(<ThreadPane />);
    act(() => input().focus());
    type("precious");
    fireEvent.click(screen.getByTestId("composer-stash-save"));
    await waitFor(() => expect(screen.getByTestId("composer-label").textContent).toBe("Couldn't save to the stash. Try again."));
    expect(input().value).toBe("precious");
  });

  it("at the cap it asks before removing the oldest; Cancel keeps everything", async () => {
    for (let i = 0; i < STASH_MAX; i++) await useStashStore.getState().save({ text: `n${i}` });
    render(<ThreadPane />);
    act(() => input().focus());
    type("one more");
    fireEvent.click(screen.getByTestId("composer-stash-save"));
    await screen.findByTestId("stash-full");
    expect(screen.getByTestId("stash-full").textContent).toContain("Your stash is full (50). Remove the oldest?");
    fireEvent.click(screen.getByTestId("stash-full-cancel"));
    expect(input().value).toBe("one more");
    expect(live()).toHaveLength(STASH_MAX);

    fireEvent.click(screen.getByTestId("composer-stash-save"));
    fireEvent.click(await screen.findByTestId("stash-full-replace"));
    await waitFor(() => expect(input().value).toBe(""));
    expect(live()).toHaveLength(STASH_MAX);
    expect(live().map((i) => i.text)).toContain("one more");
    expect(live().map((i) => i.text)).not.toContain("n0");
  });
});

describe("holding an agent's message", () => {
  function hold(el: Element) {
    vi.useFakeTimers();
    fireEvent.pointerDown(el, { clientX: 10, clientY: 10, button: 0 });
    act(() => vi.advanceTimersByTime(HOLD_MENU_MS));
    fireEvent.pointerUp(el);
    vi.useRealTimers();
  }

  it("opens Save to stash / Copy / Select Text; its text is not selectable until Select Text", async () => {
    render(<ThreadPane />);
    const bubble = screen.getByTestId("thread-bubble");
    expect(bubble.getAttribute("data-message-hold")).toBe("m1");
    expect(bubble.style.webkitUserSelect || bubble.style.userSelect).toBe("none");
    hold(bubble);
    const menu = screen.getByTestId("message-menu");
    expect(Array.from(menu.querySelectorAll("[role=menuitem]")).map((b) => b.textContent)).toEqual([
      "Save to stash",
      "Copy",
      "Select Text",
    ]);
    // The hold's own release never runs an item: a fresh press does.
    fireEvent.pointerDown(menu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save to stash" }));
    await waitFor(() => expect(live().map((i) => i.text)).toEqual(["Here is the plan."]));
    expect(screen.queryByTestId("message-menu")).toBeNull();

    hold(screen.getByTestId("thread-bubble"));
    fireEvent.pointerDown(screen.getByTestId("message-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select Text" }));
    expect(screen.getByTestId("thread-bubble").getAttribute("data-selecting")).toBe("true");
    expect(screen.getByTestId("thread-bubble").style.userSelect).toBe("");
  });

  it("my own messages and cards have no hold menu", async () => {
    useZenStore.setState({
      thread: [
        agentMsg("me1", 1, "mine", { mine: true, from: "baden" }),
        agentMsg("c1", 2, "Pick one", { choice: { prompt: "Pick one", options: ["A"], answer: null } }),
      ],
    });
    render(<ThreadPane />);
    for (const b of screen.getAllByTestId("thread-bubble")) expect(b.getAttribute("data-message-hold")).toBeNull();
  });
});

describe("an agent's stash.offer card", () => {
  it("Save to stash saves its title and text here, from the sender", async () => {
    useZenStore.setState({
      thread: [
        agentMsg("o1", 3, "Weekly review\n\nSummarize this week's PRs.", {
          kind: "stash.offer",
          stashOffer: { title: "Weekly review", text: "Summarize this week's PRs." },
        }),
      ],
    });
    render(<ThreadPane />);
    expect(screen.getByTestId("stash-offer").textContent).toContain("Weekly review");
    fireEvent.click(screen.getByTestId("stash-offer-save"));
    await waitFor(() => expect(live()).toHaveLength(1));
    expect(live()[0]).toMatchObject({
      text: "Weekly review\n\nSummarize this week's PRs.",
      source: { agent: "appa", serverId: "s1" },
    });
    expect(postThread).not.toHaveBeenCalled();
  });
});
