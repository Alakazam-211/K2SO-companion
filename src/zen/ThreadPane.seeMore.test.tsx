// @vitest-environment jsdom
// "See more" in the Thread (MessageFold in Bubble): a long message folds;
// the hold menu's Copy and Reply take the full text; the See more button
// keeps its own press (no menu); opening while following does not stick the
// list to the new bottom; a push-tap landing opens it; an agent message
// streaming past the threshold folds.
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
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import { HOLD_MENU_MS } from "./useHoldMenu";
import { __resetFoldForTests, foldClipPx } from "./MessageFold";
import type { ThreadMessage } from "./threadModel";

const LINE = 21;

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

/** 30 short lines: long by height, short enough (< 600 chars) that a
 *  Reply quotes every line. */
const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n\n");

// ── Scroll metrics (the follow tests'): content `height`, box 600.
const CLIENT = 600;
let height = 1800;
const isScroller = (el: Element) => el.getAttribute?.("data-testid") === "thread-scroller";
const tops = new WeakMap<Element, number>();
const scroller = () => screen.getByTestId("thread-scroller");

// ── ResizeObserver: each instance with what it observes.
type Obs = { cb: (entries?: ResizeObserverEntry[]) => void; targets: Element[] };
let observers: Obs[] = [];
function report(target: Element, h: number) {
  const o = observers.find((x) => x.targets.includes(target));
  if (!o) throw new Error("not observed");
  act(() => o.cb([{ target, contentRect: { height: h } } as unknown as ResizeObserverEntry]));
}
/** The pane's own observer (content + scroller): late layout. */
function paneResize() {
  const o = observers.find((x) => x.targets.includes(scroller()));
  act(() => o!.cb());
}
const realGcs = window.getComputedStyle.bind(window);

beforeEach(() => {
  localStorage.clear();
  __resetFoldForTests();
  height = 1800;
  observers = [];
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
      o: Obs;
      constructor(cb: Obs["cb"]) {
        this.o = { cb, targets: [] };
        observers.push(this.o);
      }
      observe(t: Element) {
        this.o.targets.push(t);
      }
      unobserve() {}
      disconnect() {
        this.o.targets = [];
      }
    }
  );
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    const cs = realGcs(el);
    if (!el.classList?.contains("chat-markdown")) return cs;
    return new Proxy(cs, {
      get(t, k: string) {
        if (k === "lineHeight") return `${LINE}px`;
        if (k === "fontSize") return "14px";
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  });
  setZenScope(fakeScope({ id: "s1", username: "baden", hostKey: "rosson.k2.dev", label: "Rosson" }));
  vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-1",
    threadHasMore: false,
    threadLoadingEarlier: false,
    threadFocusSeq: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "Appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: [agentMsg("m1", 41, "Short one."), agentMsg("m2", 42, LONG)],
    outbox: [],
    sending: false,
    sendError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.mocked(postThread).mockReset();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

const bubbles = () => screen.getAllByTestId("thread-bubble");
const longBubble = () => bubbles()[1];
const innerOf = (b: Element) => b.querySelector<HTMLElement>("[data-testid=fold-inner]")!;
const toggleOf = (b: Element) => b.querySelector<HTMLButtonElement>("[data-testid=fold-toggle]");

function measureAll(longLines = 60) {
  report(innerOf(bubbles()[0]), LINE);
  report(innerOf(longBubble()), LINE * longLines);
}

function hold(el: Element) {
  vi.useFakeTimers();
  fireEvent.pointerDown(el, { clientX: 10, clientY: 10, button: 0 });
  act(() => vi.advanceTimersByTime(HOLD_MENU_MS));
  fireEvent.pointerUp(el);
  vi.useRealTimers();
}

describe("See more in the Thread", () => {
  it("folds only the long message, clipped at 12 lines + the button's row", () => {
    render(<ThreadPane />);
    measureAll();
    expect(toggleOf(bubbles()[0])).toBeNull();
    const t = toggleOf(longBubble())!;
    expect(t.textContent).toBe("See more");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(longBubble().querySelector<HTMLElement>("[data-testid=fold-clip]")!.style.maxHeight).toBe(
      `${foldClipPx(LINE)}px`
    );
    // The words stay in the DOM (VoiceOver reads them; selection works).
    expect(longBubble().textContent).toContain("line 30");
  });

  it("Copy from the hold menu takes the full text, folded or not", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ThreadPane />);
    measureAll();
    hold(longBubble());
    fireEvent.pointerDown(screen.getByTestId("message-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(LONG);
  });

  it("Reply quotes the full text, not the folded view", async () => {
    render(<ThreadPane />);
    measureAll();
    hold(longBubble());
    fireEvent.pointerDown(screen.getByTestId("message-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "Got it." } });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => expect(postThread).toHaveBeenCalled());
    const sent = vi.mocked(postThread).mock.calls[0].find((a) => typeof a === "string" && a.startsWith("↩")) as string;
    expect(sent.startsWith("↩ #42 appa:\n> line 1\n")).toBe(true);
    expect(sent).toContain("> line 30\n\nGot it.");
  });

  it("the See more button keeps its own press: a hold on it opens no menu; a tap opens the message", () => {
    render(<ThreadPane />);
    measureAll();
    const t = toggleOf(longBubble())!;
    hold(t);
    expect(screen.queryByTestId("message-menu")).toBeNull();
    fireEvent.click(t);
    expect(toggleOf(longBubble())!.textContent).toBe("See less");
    expect(toggleOf(longBubble())!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByTestId("message-menu")).toBeNull();
    // The bubble around it still holds for the menu.
    hold(longBubble());
    expect(screen.getByTestId("message-menu")).toBeTruthy();
  });

  it("opening the newest message while following keeps the reader's place (no stick to the new bottom)", () => {
    render(<ThreadPane />);
    measureAll();
    const at = scroller().scrollTop;
    expect(at).toBe(height - CLIENT);
    fireEvent.click(toggleOf(longBubble())!);
    // The open message lays out taller: late layout must not stick.
    height = 2600;
    paneResize();
    expect(scroller().scrollTop).toBe(at);
    // Folding back at the bottom follows again.
    height = 1800;
    fireEvent.click(toggleOf(longBubble())!);
    height = 1900;
    paneResize();
    expect(scroller().scrollTop).toBe(height - CLIENT);
  });

  it("a push tap landing on a long message opens it", () => {
    const own = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      useZenStore.setState({ threadFocusSeq: 42 });
      render(<ThreadPane />);
      measureAll();
      expect(toggleOf(longBubble())!.textContent).toBe("See less");
    } finally {
      Element.prototype.scrollIntoView = own;
    }
  });

  it("an agent message streaming past the threshold folds; the clip height never changes", () => {
    render(<ThreadPane />);
    measureAll();
    const grow = (lines: number) => {
      act(() =>
        useZenStore.setState({
          thread: [
            agentMsg("m1", 41, "Short one."),
            agentMsg("m2", 42, LONG),
            agentMsg("m3", 43, Array.from({ length: lines }, (_, i) => `step ${i}`).join("\n\n")),
          ],
        })
      );
      const b = bubbles()[2];
      report(innerOf(b), LINE * lines * 1.3);
      return b;
    };
    let b = grow(4);
    expect(toggleOf(b)).toBeNull();
    const clip = () => bubbles()[2].querySelector<HTMLElement>("[data-testid=fold-clip]")!.style.maxHeight;
    expect(clip()).toBe(`${foldClipPx(LINE)}px`);
    b = grow(9);
    expect(toggleOf(b)).toBeNull();
    b = grow(16);
    expect(toggleOf(b)!.textContent).toBe("See more");
    expect(clip()).toBe(`${foldClipPx(LINE)}px`);
  });
});
