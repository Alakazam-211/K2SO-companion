// @vitest-environment jsdom
// Following the newest: after a Send the agent's reply always comes into
// view, even when the working strip grew and ended in the same update; late
// height changes keep the tail stuck; scrolling up stops following and an
// incoming message shows a "New message" pill instead of yanking; load
// earlier keeps its anchor; a push-tap seq is not overridden.
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
import { NEW_BELOW_SETTLE_MS, PILL_LEAVE_MS, ThreadPane } from "./ThreadPane";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { useJumpOnSendStore } from "./jumpOnSend";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

// ── Scroll metrics: the scroller's content height is `height`, its box 600
// tall; scrollTop clamps like a real overflow box.
const CLIENT = 600;
let height = 1800;
const isScroller = (el: Element) => el.getAttribute?.("data-testid") === "thread-scroller";
const tops = new WeakMap<Element, number>();
const ownScrollIntoView = Element.prototype.scrollIntoView;

// ── ResizeObserver + rAF the test fires by hand.
let resizeCallbacks: Array<() => void> = [];
let rafQueue: Array<FrameRequestCallback> = [];
function fireResize() {
  act(() => resizeCallbacks.forEach((cb) => cb()));
}
function flushRaf() {
  act(() => {
    const q = rafQueue;
    rafQueue = [];
    q.forEach((cb) => cb(0));
  });
}

const msg = (id: string, seq: number, text: string, mine = false): ThreadMessage => ({
  id,
  seq,
  text,
  from: mine ? "baden" : "appa",
  at: seq,
  mine,
  kind: "text",
  choice: null,
});

const threadFrame = (id: string, seq: number, body: string) => ({
  collection: "thread",
  seq,
  id,
  doc: { id, from: "appa", to: "owner", created_at: 1_760_190_000, body, via: "thread" },
});

const activityFrame = (rev: number, end: boolean) => {
  const now = Date.now();
  return {
    collection: "activity",
    seq: 0,
    id: "t-1",
    activity: {
      turnId: "t-1",
      state: end ? "idle" : "working",
      phase: end ? "working" : "tool",
      phaseSince: now - 1_000,
      line: "Running `npm test`",
      startedAt: now - 5_000,
      tally: { read: 2, search: 0, cmd: 1, edit: 0 },
      end: end ? { reason: "reply", detail: null, at: now } : null,
      serverNow: now,
      rev,
    },
  };
};

function openRoom(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-follow",
    threadHasMore: false,
    threadLoadingEarlier: false,
    threadFocusSeq: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: Array.from({ length: 10 }, (_, i) => msg(`m${i + 1}`, i + 1, `message ${i + 1}`)),
    outbox: [],
    sending: false,
    sendError: null,
    ...over,
  });
}

const scroller = () => screen.getByTestId("thread-scroller");
const bottom = () => height - CLIENT;
const socket = () => vi.mocked(connectOverlayEvents).mock.calls[0][0];

function userScrollTo(top: number) {
  const el = scroller();
  el.scrollTop = top;
  fireEvent.scroll(el);
}

beforeEach(() => {
  localStorage.clear();
  height = 1800;
  resizeCallbacks = [];
  rafQueue = [];
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return isScroller(this) ? height : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return isScroller(this) ? CLIENT : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return tops.get(this) ?? 0;
    },
    set(v: number) {
      const max = isScroller(this) ? Math.max(0, height - CLIENT) : 0;
      tops.set(this, Math.min(Math.max(0, v), max));
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
  openRoom();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.mocked(postThread).mockReset();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop", "scrollTo", "scrollIntoView"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  Element.prototype.scrollIntoView = ownScrollIntoView;
});

describe("Thread follows the newest", () => {
  it("after a send, the reply sticks even when the working strip grew and ended in the same update", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    expect(scroller().scrollTop).toBe(bottom());

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "run the tests" } });
    height = 1880;
    fireEvent.submit(screen.getByTestId("composer-form"));
    expect(scroller().scrollTop).toBe(bottom());

    // "Working…" mounts, then grows (tool line, tally) with no scroll event.
    height = 1960;
    act(() => socket().onItem(activityFrame(1, false) as never));
    expect(scroller().scrollTop).toBe(bottom());
    const before = scroller().scrollTop;
    height = 2240;
    // A late scroll event for our own stick, read after the growth.
    fireEvent.scroll(scroller());
    expect(scroller().scrollTop).toBe(before);

    // The strip ends and the reply lands in one layout change: well over
    // the old 80px "near" check from where the scroller sat.
    height = 2300;
    act(() => {
      socket().onItem(activityFrame(2, true) as never);
      socket().onItem(threadFrame("r1", 20, "All 42 tests pass.") as never);
    });
    expect(screen.getByTestId("thread-working-strip").getAttribute("data-leaving")).toBe("true");
    expect(screen.getByText("All 42 tests pass.")).not.toBeNull();
    expect(scroller().scrollTop).toBe(bottom());
    expect(screen.queryByTestId("thread-new-message")).toBeNull();
  });

  it("a late height change of the last bubble keeps the tail stuck while following", () => {
    render(<ThreadPane />);
    expect(scroller().scrollTop).toBe(1200);
    // Markdown / an image lays out after the commit: the ResizeObserver.
    height = 2100;
    fireResize();
    expect(scroller().scrollTop).toBe(1500);
    // And again a frame later (code highlighting): the rAF re-stick.
    height = 2160;
    flushRaf();
    expect(scroller().scrollTop).toBe(1560);
  });

  it("an agent message shows its name and time on one line above the bubble", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    act(() => socket().onItem(threadFrame("r9", 40, "Hello there.") as never));
    const bubble = await screen.findByText("Hello there.");
    const row = bubble.closest("[data-thread-msg]") as HTMLElement;
    const meta = row.querySelector('[data-testid="thread-msg-meta"]') as HTMLElement;
    expect(meta.textContent).toMatch(/^appa•.*\d{1,2}:\d{2} [AP]M$/);
    // Meta first, then the bubble; no time line under it.
    expect(row.firstElementChild).toBe(meta);
    expect(row.lastElementChild?.getAttribute("data-testid")).toBe("thread-bubble");
  });

  it("the pill keeps the keyboard up and finishes a glide the WebView dropped", async () => {
    // A smooth scroll that never arrives (WKWebView interrupted it).
    const scrollTo = vi.fn();
    (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());

    userScrollTo(300);
    height = 1900;
    act(() => socket().onItem(threadFrame("r2", 30, "Done.") as never));
    fireResize();
    flushRaf();
    const pill = screen.getByTestId("thread-new-message");
    // No blur: the tap must not take focus from the composer.
    expect(fireEvent.pointerDown(pill)).toBe(false);
    expect(fireEvent.mouseDown(pill)).toBe(false);

    fireEvent.click(pill);
    expect(scrollTo).toHaveBeenCalled();
    expect(scroller().scrollTop).toBe(300);
    await act(() => new Promise((r) => setTimeout(r, NEW_BELOW_SETTLE_MS + 20)));
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("scrolling up stops following; an incoming message shows the pill, the pill scrolls and resumes", async () => {
    const scrollTo = vi.fn(function (this: HTMLElement, opts: ScrollToOptions) {
      this.scrollTop = opts.top ?? 0;
    });
    (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());

    userScrollTo(300);
    height = 1900;
    act(() => socket().onItem(threadFrame("r2", 30, "Done.") as never));
    fireResize();
    flushRaf();
    expect(scroller().scrollTop).toBe(300);
    const pill = screen.getByTestId("thread-new-message");
    expect(pill.textContent).toMatch(/New message/);
    expect(pill.parentElement?.getAttribute("aria-live")).toBe("polite");

    fireEvent.click(pill);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1900, behavior: "smooth" });
    expect(scroller().scrollTop).toBe(bottom());
    fireEvent.scroll(scroller());
    expect(screen.queryByTestId("thread-new-message")).toBeNull();

    // Following again: the next growth sticks.
    height = 2000;
    fireResize();
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("Jump to newest when I send (default on): a send from up in history jumps down and follows", async () => {
    useJumpOnSendStore.setState({ on: true });
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    userScrollTo(300);
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "and this" } });
    height = 1880;
    fireEvent.submit(screen.getByTestId("composer-form"));
    expect(scroller().scrollTop).toBe(bottom());
    expect(screen.queryByTestId("thread-new-message")).toBeNull();
  });

  it("Jump to newest when I send off: a send from up in history keeps the place, with a Sent pill", async () => {
    const scrollTo = vi.fn(function (this: HTMLElement, opts: ScrollToOptions) {
      this.scrollTop = opts.top ?? 0;
    });
    (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
    useJumpOnSendStore.setState({ on: false });
    try {
      render(<ThreadPane />);
      await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
      userScrollTo(300);
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "and this" } });
      height = 1880;
      fireEvent.submit(screen.getByTestId("composer-form"));
      fireResize();
      flushRaf();
      expect(scroller().scrollTop).toBe(300);
      expect(vi.mocked(postThread)).toHaveBeenCalled();
      expect(screen.getByTestId("thread-new-message").textContent).toMatch(/Sent/);

      // The reply arrives: still in place; the pill now says New message.
      height = 1960;
      act(() => socket().onItem(threadFrame("r9", 40, "On it.") as never));
      fireResize();
      expect(scroller().scrollTop).toBe(300);
      expect(screen.getByTestId("thread-new-message").textContent).toMatch(/New message/);

      const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
      input.focus();
      const pill = screen.getByTestId("thread-new-message");
      expect(fireEvent.pointerDown(pill)).toBe(false);
      fireEvent.click(pill);
      expect(scroller().scrollTop).toBe(bottom());
      // Still in the page through its own tap (iOS reads a node removed in
      // its click as a tap on nothing and drops the keyboard); it fades, then goes.
      expect(screen.getByTestId("thread-new-message").getAttribute("data-leaving")).toBe("true");
      expect(document.activeElement).toBe(input);
      await act(() => new Promise((r) => setTimeout(r, PILL_LEAVE_MS + 20)));
      expect(screen.queryByTestId("thread-new-message")).toBeNull();
      expect(document.activeElement).toBe(input);
    } finally {
      useJumpOnSendStore.setState({ on: true });
    }
  });

  it("Jump to newest when I send off: at the newest already, a send still follows", async () => {
    useJumpOnSendStore.setState({ on: false });
    try {
      render(<ThreadPane />);
      await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
      fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "next" } });
      height = 1880;
      fireEvent.submit(screen.getByTestId("composer-form"));
      expect(scroller().scrollTop).toBe(bottom());
      expect(screen.queryByTestId("thread-new-message")).toBeNull();
    } finally {
      useJumpOnSendStore.setState({ on: true });
    }
  });

  it("a press anywhere on the composer dock but the field keeps the keyboard up", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    input.focus();
    const dock = screen.getByTestId("thread-composer-dock");
    // Blank dock (where the Working strip or a moving pill can be): no blur.
    expect(fireEvent.pointerDown(dock)).toBe(false);
    expect(fireEvent.mouseDown(dock)).toBe(false);
    // The field itself still takes presses (caret, selection).
    expect(fireEvent.pointerDown(input)).toBe(true);
    expect(fireEvent.mouseDown(input)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("scrolling back near the bottom resumes following and hides the pill", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    userScrollTo(200);
    act(() => socket().onItem(threadFrame("r3", 31, "Hi.") as never));
    expect(screen.getByTestId("thread-new-message")).not.toBeNull();
    userScrollTo(bottom() - 60);
    expect(screen.queryByTestId("thread-new-message")).toBeNull();
    height = 2000;
    fireResize();
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("an older page fetched as the reader nears the top lands without yanking the view", async () => {
    // Messages are 100px rows under the 32px top slot.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      let top = 0;
      let h = CLIENT;
      if (this.hasAttribute("data-thread-msg")) {
        const all = Array.from(document.querySelectorAll("[data-thread-msg]"));
        top = 32 + all.indexOf(this) * 100 - scroller().scrollTop;
        h = 100;
      }
      return { top, bottom: top + h, left: 0, right: 390, width: 390, height: h, x: 0, y: top, toJSON: () => ({}) };
    });
    const older = Array.from({ length: 5 }, (_, i) => msg(`o${i + 1}`, i - 10, `older ${i + 1}`));
    let finish!: () => void;
    const loadEarlier = vi.fn(
      () =>
        new Promise<"loaded">((done) => {
          useZenStore.setState({ threadLoadingEarlier: true });
          finish = () => {
            useZenStore.setState({
              thread: [...older, ...useZenStore.getState().thread],
              threadLoadingEarlier: false,
            });
            done("loaded");
          };
        })
    );
    openRoom({ threadHasMore: true, loadEarlier });
    height = 1032;
    render(<ThreadPane />);
    expect(scroller().scrollTop).toBe(432);
    flushRaf();
    expect(loadEarlier).not.toHaveBeenCalled();
    userScrollTo(0);
    flushRaf();
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    // The page waits above the drawn rows: the view has not moved.
    expect(scroller().scrollTop).toBe(0);
    expect(screen.queryByText("older 1")).toBeNull();
    fireResize();
    flushRaf();
    expect(scroller().scrollTop).toBe(0);
  });

  it("a push-tap seq is not overridden by following", () => {
    const scrollIntoView = vi.fn(function (this: HTMLElement) {
      scroller().scrollTop = 300;
    });
    Element.prototype.scrollIntoView = scrollIntoView as never;
    openRoom({ threadFocusSeq: 4 });
    render(<ThreadPane />);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scroller().scrollTop).toBe(300);
    expect(useZenStore.getState().threadFocusSeq).toBeNull();
    height = 2000;
    fireResize();
    flushRaf();
    expect(scroller().scrollTop).toBe(300);
    act(() =>
      useZenStore.setState({
        thread: [...useZenStore.getState().thread, msg("r4", 40, "later")],
      })
    );
    expect(scroller().scrollTop).toBe(300);
    expect(screen.getByTestId("thread-new-message")).not.toBeNull();
  });

  it("the drawer pads the scroller (not its content) and following stays at the bottom through open, expand and close", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    const contentBefore = screen.getByTestId("thread-content").childElementCount;
    // Its own 12px plus the floating composer block (0 tall here).
    expect(scroller().style.paddingBottom).toBe("12px");

    // Opens: a 32px tile on the field's top edge; the bar's top 14px is
    // under it, so 18px covers the scroller, on top of its own 12px.
    height = 1818;
    act(() => socket().onItem(activityFrame(1, false) as never));
    expect(screen.getByTestId("thread-content").childElementCount).toBe(contentBefore);
    expect(scroller().getAttribute("data-drawer-space")).toBe("32");
    expect(scroller().getAttribute("data-drawer-cover")).toBe("18");
    expect(scroller().style.paddingBottom).toBe("30px");
    expect(scroller().scrollTop).toBe(bottom());
    // The padding eases over ~200ms: the rAF loop keeps sticking.
    height = 1820;
    flushRaf();
    expect(scroller().scrollTop).toBe(bottom());

    // Tap: the drawer grows upward and the padding tracks its height.
    height = 1880;
    fireEvent.click(screen.getByTestId("thread-strip-toggle"));
    const space = Number(scroller().getAttribute("data-drawer-space"));
    expect(space).toBeGreaterThan(32);
    expect(scroller().style.paddingBottom).toBe(`${12 + space - 14}px`);
    expect(scroller().scrollTop).toBe(bottom());

    // Tap again: back to one line.
    fireEvent.click(screen.getByTestId("thread-strip-toggle"));
    expect(scroller().style.paddingBottom).toBe("30px");

    // Closes: the padding goes as the drawer slides down.
    height = 1800;
    act(() => socket().onItem(activityFrame(2, true) as never));
    expect(scroller().style.paddingBottom).toBe("12px");
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("tapping the drawer with the composer focused toggles it and keeps focus (the keyboard stays up)", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    act(() => socket().onItem(activityFrame(1, false) as never));
    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    const tile = screen.getByTestId("thread-strip-toggle");
    // pointerdown / mousedown are cancelled so the button never takes focus.
    expect(fireEvent.pointerDown(tile)).toBe(false);
    expect(fireEvent.mouseDown(tile)).toBe(false);
    fireEvent.click(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(fireEvent.pointerDown(tile)).toBe(false);
    fireEvent.click(tile);
    expect(tile.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(input);
  });

  it("with a row above the field the bar makes room under it and the drawer adds no scroller padding", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    act(() => useZenStore.setState({ sendError: "Send failed" }));
    act(() => socket().onItem(activityFrame(1, false) as never));
    expect(screen.getByTestId("composer-label").textContent).toBe("Send failed");
    expect(scroller().getAttribute("data-drawer-cover")).toBe("0");
    expect(scroller().style.paddingBottom).toBe("12px");
    const room = screen.getByTestId("composer-drawer-room");
    expect(room.style.height).toBe("32px");
    // Label, then the room, then the field the drawer stands on.
    expect(screen.getByTestId("composer-label").nextElementSibling).toBe(room);
    expect(room.nextElementSibling).toBe(screen.getByTestId("composer-form"));
  });

  it("a reader scrolled up is not yanked when the drawer opens", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    userScrollTo(300);
    height = 1838;
    act(() => socket().onItem(activityFrame(1, false) as never));
    flushRaf();
    expect(scroller().scrollTop).toBe(300);
  });
});
