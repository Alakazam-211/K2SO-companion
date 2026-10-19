// @vitest-environment jsdom
// The Thread's render window (threadWindow.ts): a long chat keeps every
// message in memory but draws only a window. At the newest: the newest
// WINDOW_ROWS, the oldest dropping off as messages arrive. Scrolled up:
// rows come back (from memory first, then "Load earlier") before the
// reader reaches them, and rows far below leave. Nothing on screen moves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { WINDOW_EXTEND, WINDOW_IDLE_MS, WINDOW_ROWS } from "./threadWindow";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

// ── A tiny layout: the scroller is 600 tall at the top of the screen; its
// content is the thread-content block's children stacked (a row is 50px,
// a spacer its style height, anything else 0); scrollTop clamps.
const CLIENT = 600;
const ROW = 50;
const tops = new WeakMap<Element, number>();
const is = (el: Element, id: string) => el.getAttribute?.("data-testid") === id;
const content = () => document.querySelector<HTMLElement>('[data-testid="thread-content"]');
function ownHeight(el: Element): number {
  if (el.hasAttribute("data-thread-msg")) return ROW;
  const h = parseFloat((el as HTMLElement).style?.height ?? "");
  return Number.isFinite(h) ? h : 0;
}
function layout(): Map<Element, number> {
  const at = new Map<Element, number>();
  let y = 0;
  for (const c of Array.from(content()?.children ?? [])) {
    at.set(c, y);
    y += ownHeight(c);
  }
  at.set(content() as Element, y);
  return at;
}
const contentHeight = () => layout().get(content() as Element) ?? 0;

let rafQueue: FrameRequestCallback[] = [];
function flushRaf() {
  for (let i = 0; i < 5 && rafQueue.length; i++) {
    act(() => {
      const q = rafQueue;
      rafQueue = [];
      q.forEach((cb) => cb(0));
    });
  }
}

const T0 = 1_760_000_000;
const msg = (seq: number): ThreadMessage => ({
  id: `m${seq}`,
  seq,
  text: `message ${seq}`,
  from: "appa",
  at: T0 + seq,
  mine: false,
  kind: "text",
  choice: null,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));

function openRoom(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-win",
    threadHasMore: false,
    threadLoadingEarlier: false,
    threadFocusSeq: null,
    threadCached: false,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: many(100),
    outbox: [],
    sending: false,
    sendError: null,
    ...over,
  });
}

const scroller = () => screen.getByTestId("thread-scroller");
const drawn = () => Array.from(document.querySelectorAll<HTMLElement>("[data-win-row]"));
const seqs = () => drawn().map((r) => Number(r.getAttribute("data-seq")));
const rectTop = (seq: number) =>
  document.querySelector(`[data-seq="${seq}"]`)!.getBoundingClientRect().top;
const atBottom = () => scroller().scrollTop === Math.max(0, contentHeight() - CLIENT);

function userScrollTo(top: number) {
  const el = scroller();
  act(() => {
    el.scrollTop = top;
    fireEvent.scroll(el);
  });
  flushRaf();
}
/** Scrolling quiet long enough for rows to leave. */
function idle() {
  act(() => {
    vi.advanceTimersByTime(WINDOW_IDLE_MS * 3);
  });
}
/** First drawn row whose box is on screen. */
function firstVisible(): number {
  const top = scroller().scrollTop;
  const at = layout();
  for (const r of drawn()) if ((at.get(r) ?? 0) + ROW > top + 1) return Number(r.getAttribute("data-seq"));
  return -1;
}

async function mount() {
  render(<ThreadPane />);
  // Progressive first paint: the rest on the next idle frame.
  flushRaf();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  flushRaf();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  rafQueue = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, "thread-scroller") ? contentHeight() : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, "thread-scroller") ? CLIENT : 0;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      const max = is(this, "thread-scroller") ? Math.max(0, contentHeight() - CLIENT) : 0;
      tops.set(this, Math.min(Math.max(0, v), max));
    },
  });
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement === content() ? layout().get(this) ?? 0 : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement === content() ? ownHeight(this) : 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    let top = 0;
    let h = 0;
    if (is(this, "thread-scroller")) {
      h = CLIENT;
    } else if (this.parentElement === content()) {
      top = (layout().get(this) ?? 0) - scroller().scrollTop;
      h = ownHeight(this);
    }
    return { top, bottom: top + h, height: h, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
  openRoom();
});

const ownRect = Element.prototype.getBoundingClientRect;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.mocked(postThread).mockReset();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop", "offsetTop", "offsetHeight"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  Element.prototype.getBoundingClientRect = ownRect;
});

describe("Thread render window", () => {
  it("a 500-message chat draws only the newest WINDOW_ROWS, pinned to the newest", async () => {
    openRoom({ thread: many(500) });
    await mount();
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(seqs()[seqs().length - 1]).toBe(500);
    expect(seqs()[0]).toBe(500 - WINDOW_ROWS + 1);
    expect(atBottom()).toBe(true);
  });

  it("at the newest, arrivals draw at once; the oldest drop off once quiet, nothing moving", async () => {
    await mount();
    for (let s = 101; s <= 105; s++) {
      act(() => useZenStore.setState({ thread: [...useZenStore.getState().thread, msg(s)] }));
    }
    expect(seqs()[seqs().length - 1]).toBe(105);
    expect(drawn()).toHaveLength(WINDOW_ROWS + 5);
    const height = contentHeight();
    const top = scroller().scrollTop;
    idle();
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(seqs()[0]).toBe(105 - WINDOW_ROWS + 1);
    // A spacer of their measured height stands in: same height, same view.
    expect(screen.getByTestId("thread-window-above").style.height).toBe(`${5 * ROW}px`);
    expect(contentHeight()).toBe(height);
    expect(scroller().scrollTop).toBe(top);
    expect(atBottom()).toBe(true);
  });

  it("scrolling up brings rows back from memory first, the visible row held still; then Load earlier fetches", async () => {
    const loadEarlier = vi.fn(async () => {});
    openRoom({ threadHasMore: true, loadEarlier });
    await mount();
    expect(seqs()[0]).toBe(100 - WINDOW_ROWS + 1);
    // Toward the top of what is drawn.
    userScrollTo(200);
    const seen = firstVisible();
    const before = rectTop(seen);
    // (The window grew on that scroll's frame.)
    expect(seqs()[0]).toBe(100 - WINDOW_ROWS - WINDOW_EXTEND + 1);
    expect(rectTop(seen)).toBe(before);
    expect(loadEarlier).not.toHaveBeenCalled();
    // Up again until memory runs out.
    for (let i = 0; i < 5 && seqs()[0] > 1; i++) userScrollTo(scroller().scrollTop - 1200);
    expect(seqs()[0]).toBe(1);
    expect(loadEarlier).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(screen.getByTestId("load-earlier"));
    });
    expect(loadEarlier).toHaveBeenCalledTimes(1);
  });

  it("Load earlier tapped with more in memory draws it, no fetch", async () => {
    const loadEarlier = vi.fn(async () => {});
    openRoom({ threadHasMore: true, loadEarlier });
    await mount();
    act(() => {
      fireEvent.click(screen.getByTestId("load-earlier"));
    });
    expect(loadEarlier).not.toHaveBeenCalled();
    expect(seqs()[0]).toBe(100 - WINDOW_ROWS - WINDOW_EXTEND + 1);
  });

  it("rows far below the view leave once quiet and come back before the reader gets there", async () => {
    openRoom({ thread: many(300) });
    await mount();
    // Read far up: the window grows above as the reader goes.
    for (let i = 0; i < 6; i++) userScrollTo(scroller().scrollTop - 1000);
    idle();
    const seen = firstVisible();
    const before = rectTop(seen);
    const height = contentHeight();
    const top = scroller().scrollTop;
    // The newest are no longer drawn; a spacer keeps the scroll range.
    expect(seqs()).not.toContain(300);
    expect(screen.getByTestId("thread-window-below")).not.toBeNull();
    expect(contentHeight()).toBe(height);
    expect(scroller().scrollTop).toBe(top);
    expect(rectTop(seen)).toBe(before);
    // Back down: they are drawn again ahead of the view.
    for (let i = 0; i < 40 && !seqs().includes(300); i++) userScrollTo(scroller().scrollTop + 400);
    expect(seqs()).toContain(300);
    expect(screen.queryByTestId("thread-window-below")).toBeNull();
  });

  it("an arrival while far up shows the pill; tapping it jumps back to the newest, the window there", async () => {
    openRoom({ thread: many(300) });
    await mount();
    for (let i = 0; i < 6; i++) userScrollTo(scroller().scrollTop - 1000);
    idle();
    expect(seqs()).not.toContain(300);
    act(() => useZenStore.setState({ thread: [...useZenStore.getState().thread, msg(301)] }));
    expect(seqs()).not.toContain(301);
    act(() => {
      fireEvent.click(screen.getByTestId("thread-new-message"));
    });
    flushRaf();
    expect(seqs()[seqs().length - 1]).toBe(301);
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(atBottom()).toBe(true);
  });

  it("a push-tap target outside the window is drawn", async () => {
    openRoom({ thread: many(300), threadFocusSeq: 20 });
    render(<ThreadPane />);
    expect(document.querySelector('[data-seq="20"]')).not.toBeNull();
    expect(drawn().length).toBeLessThanOrEqual(WINDOW_ROWS);
  });

  it("the first drawn row keeps its run with the message above it (not drawn)", async () => {
    await mount();
    // All one sender, a second apart: one run. The first drawn is mid-run.
    expect(drawn()[0].getAttribute("data-run")).toBe("middle");
    expect(drawn()[0].className).not.toContain("mt-1.5");
  });
});
