// @vitest-environment jsdom
// The Thread's render window (threadWindow.ts): a long chat keeps every
// message in memory but draws only a window. At the newest: the newest
// WINDOW_ROWS, the oldest dropping off as messages arrive. Scrolled up:
// rows come back (from memory first, then the server's older page,
// fetched on its own) before the reader reaches them; at most
// WINDOW_MAX_ROWS are drawn, rows at the far end leaving. Nothing on
// screen moves.
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
import {
  OLDER_COOLDOWN_MS,
  WINDOW_EXTEND,
  WINDOW_IDLE_MS,
  WINDOW_MAX_ROWS,
  WINDOW_ROWS,
} from "./threadWindow";
import type { LoadEarlierResult } from "./zenStore";
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

/** Last drawn row whose box starts on screen. */
function lastVisible(): number {
  const top = scroller().scrollTop;
  const at = layout();
  let seq = -1;
  for (const r of drawn()) if ((at.get(r) ?? 0) < top + CLIENT - 1) seq = Number(r.getAttribute("data-seq"));
  return seq;
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

  it("opening draws the newest WINDOW_ROWS; scrolling up grows from memory, the visible row held still, never past WINDOW_MAX_ROWS", async () => {
    openRoom({ thread: many(300) });
    await mount();
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    // Toward the top of what is drawn.
    userScrollTo(200);
    const seen = firstVisible();
    const before = rectTop(seen);
    // (The window grew on that scroll's frame, to the most ever drawn.)
    expect(seqs()[0]).toBe(300 - WINDOW_ROWS - WINDOW_EXTEND + 1);
    expect(drawn()).toHaveLength(WINDOW_MAX_ROWS);
    expect(rectTop(seen)).toBe(before);
    // Up again: rows come in at the top and leave at the bottom (a spacer
    // of their height keeps the geometry); never more than the cap.
    for (let i = 0; i < 4; i++) {
      userScrollTo(scroller().scrollTop - 800);
      expect(drawn().length).toBeLessThanOrEqual(WINDOW_MAX_ROWS);
    }
    expect(seqs()).not.toContain(300);
    expect(screen.getByTestId("thread-window-below")).not.toBeNull();
    const seen2 = firstVisible();
    const before2 = rectTop(seen2);
    userScrollTo(scroller().scrollTop - 300);
    expect(rectTop(seen2) - before2).toBe(300);
  });

  it("scrolling back down brings the bottom rows back and drops the top, never past WINDOW_MAX_ROWS", async () => {
    openRoom({ thread: many(300) });
    await mount();
    for (let i = 0; i < 8; i++) userScrollTo(scroller().scrollTop - 800);
    expect(seqs()).not.toContain(300);
    const height = contentHeight();
    for (let i = 0; i < 60 && !seqs().includes(300); i++) {
      // A row in the lower half of the view: still in view after.
      const seen = lastVisible();
      const before = rectTop(seen);
      userScrollTo(scroller().scrollTop + 300);
      expect(drawn().length).toBeLessThanOrEqual(WINDOW_MAX_ROWS);
      // The row in view moved exactly as far as the scroll.
      expect(before - rectTop(seen)).toBe(300);
    }
    expect(seqs()).toContain(300);
    expect(contentHeight()).toBe(height);
    // The rows that left the top stand as a spacer of their height.
    expect(screen.getByTestId("thread-window-above")).not.toBeNull();
  });

  it("leaving the chat and coming back draws the newest WINDOW_ROWS again", async () => {
    openRoom({ thread: many(300) });
    await mount();
    for (let i = 0; i < 6; i++) userScrollTo(scroller().scrollTop - 800);
    expect(seqs()).not.toContain(300);
    act(() => useZenStore.setState({ agentId: "", thread: [] }));
    act(() => useZenStore.setState({ agentId: "appa", thread: many(300) }));
    flushRaf();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    flushRaf();
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(seqs()[seqs().length - 1]).toBe(300);
    expect(atBottom()).toBe(true);
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

describe("Thread render window under a busy stream", () => {
  it("re-renders every 100ms (live frames) do not hold off the trim", async () => {
    await mount();
    for (let s = 101; s <= 110; s++) {
      act(() => useZenStore.setState({ thread: [...useZenStore.getState().thread, msg(s)] }));
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(drawn().length).toBeLessThanOrEqual(WINDOW_ROWS + 3);
    expect(seqs()[seqs().length - 1]).toBe(110);
  });
});

/** A stand-in for the store's `loadEarlier`: one page at a time, landed
 *  (or failed) by the test. */
function pager() {
  let settle: ((r: LoadEarlierResult) => void) | null = null;
  const fn = vi.fn(
    () =>
      new Promise<LoadEarlierResult>((done) => {
        useZenStore.setState({ threadLoadingEarlier: true });
        settle = done;
      })
  );
  const land = async (older: ThreadMessage[], more: boolean) => {
    await act(async () => {
      useZenStore.setState({
        thread: [...older, ...useZenStore.getState().thread],
        threadHasMore: more,
        threadLoadingEarlier: false,
      });
      settle?.("loaded");
    });
  };
  const fail = async () => {
    await act(async () => {
      useZenStore.setState({ threadLoadingEarlier: false });
      settle?.("failed");
    });
  };
  return { fn, land, fail };
}
const olderPage = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => msg(from + i));
/** Up until everything in memory is drawn. */
function scrollToTopOfMemory() {
  for (let i = 0; i < 12 && seqs()[0] !== useZenStore.getState().thread[0].seq; i++) {
    userScrollTo(scroller().scrollTop - 800);
  }
  expect(seqs()[0]).toBe(useZenStore.getState().thread[0].seq);
}
/** Past the rest after a page (the next may go out). */
function rest() {
  act(() => {
    vi.advanceTimersByTime(OLDER_COOLDOWN_MS + 1);
  });
}

describe("Thread lazy loading (older pages as the reader scrolls up)", () => {
  it("nearing the top fetches exactly one page, and only once memory is drawn", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    expect(p.fn).not.toHaveBeenCalled();
    // The next scroll near the top: the page goes out.
    userScrollTo(100);
    expect(p.fn).toHaveBeenCalledTimes(1);
    // More scrolling while it is out: still one.
    userScrollTo(scroller().scrollTop + 40);
    userScrollTo(0);
    userScrollTo(5);
    expect(p.fn).toHaveBeenCalledTimes(1);
    // A small spinner in the top slot; no "Load earlier" button anywhere.
    expect(screen.getByTestId("thread-older-loading")).not.toBeNull();
    expect(screen.queryByText(/load earlier/i)).toBeNull();
  });

  it("the page lands above the window: nothing moves; it is drawn once the scroll settles, the visible row held still", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(100);
    expect(p.fn).toHaveBeenCalledTimes(1);
    const seen = firstVisible();
    const before = rectTop(seen);
    const top = scroller().scrollTop;
    await p.land(olderPage(-49, 50), true);
    // Held out of the DOM: same rows, same place.
    expect(seqs()[0]).toBe(1);
    expect(scroller().scrollTop).toBe(top);
    expect(rectTop(seen)).toBe(before);
    expect(screen.queryByTestId("thread-older-loading")).toBeNull();
    // Mid-scroll (a fling) with the top still more than half a screen
    // away: the never-drawn rows wait…
    userScrollTo(500);
    const seen2 = firstVisible();
    const before2 = rectTop(seen2);
    expect(seqs()[0]).toBe(1);
    // …and come in once it is quiet, the row in view not moving.
    idle();
    expect(seqs()[0]).toBeLessThan(1);
    expect(drawn().length).toBeLessThanOrEqual(WINDOW_MAX_ROWS);
    expect(rectTop(seen2)).toBe(before2);
  });

  it("near the drawn top mid-scroll, a landed page comes in at once (no wall)", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(0);
    await p.land(olderPage(-49, 50), true);
    userScrollTo(40);
    const seen = firstVisible();
    const before = rectTop(seen);
    userScrollTo(scroller().scrollTop - 10);
    expect(seqs()[0]).toBeLessThan(1);
    expect(rectTop(seen) - before).toBe(10);
  });

  it("the next page goes out on a later scroll near the top, after a short rest", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(0);
    await p.land(olderPage(-49, 50), true);
    idle();
    rest();
    scrollToTopOfMemory();
    userScrollTo(100);
    userScrollTo(0);
    expect(p.fn).toHaveBeenCalledTimes(2);
  });

  it("no fetch on open, on the progressive first paint, or while following at the bottom", async () => {
    const p = pager();
    // A short chat: everything in memory is drawn from the start.
    openRoom({ thread: many(20), threadHasMore: true, loadEarlier: p.fn });
    render(<ThreadPane />);
    flushRaf();
    idle();
    expect(p.fn).not.toHaveBeenCalled();
    expect(atBottom()).toBe(true);
    // The reader's own scroll at the bottom: still following, no fetch.
    userScrollTo(scroller().scrollTop);
    userScrollTo(scroller().scrollTop - 5);
    idle();
    expect(p.fn).not.toHaveBeenCalled();
    cleanup();
    // A long chat on its first (progressive) frame.
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    render(<ThreadPane />);
    userScrollTo(0);
    expect(p.fn).not.toHaveBeenCalled();
  });

  it("a failed page shows a Retry line instead of trying again; tapping it fetches again", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(100);
    expect(p.fn).toHaveBeenCalledTimes(1);
    const slot = screen.getByTestId("thread-older").style.height;
    await p.fail();
    const retry = screen.getByTestId("thread-older-retry");
    expect(retry.textContent).toMatch(/Couldn.t load earlier · Retry/);
    expect(screen.getByTestId("thread-older").style.height).toBe(slot);
    // No loop: scrolling near the top again does not fetch.
    rest();
    userScrollTo(scroller().scrollTop + 30);
    userScrollTo(0);
    idle();
    expect(p.fn).toHaveBeenCalledTimes(1);
    act(() => {
      fireEvent.click(retry);
    });
    expect(p.fn).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("thread-older-retry")).toBeNull();
    expect(screen.getByTestId("thread-older-loading")).not.toBeNull();
  });

  it("nothing more on the server: no fetch, and no top slot", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: false, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(0);
    userScrollTo(20);
    idle();
    expect(p.fn).not.toHaveBeenCalled();
    expect(screen.queryByTestId("thread-older")).toBeNull();
  });

  it("the last page: the slot keeps its room (empty), so the rows do not jump", async () => {
    const p = pager();
    openRoom({ thread: many(100), threadHasMore: true, loadEarlier: p.fn });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(100);
    const seen = firstVisible();
    const before = rectTop(seen);
    await p.land([], false);
    expect(screen.getByTestId("thread-older").textContent).toBe("");
    expect(rectTop(seen)).toBe(before);
    rest();
    userScrollTo(0);
    expect(p.fn).toHaveBeenCalledTimes(1);
  });

  it("a project chat on a server without project-chat-paging-v1 grows from memory but never fetches", async () => {
    const p = pager();
    openRoom({
      thread: many(100),
      threadHasMore: true,
      threadAddr: null,
      threadGroupId: "g1",
      loadEarlier: p.fn,
    });
    await mount();
    scrollToTopOfMemory();
    userScrollTo(0);
    idle();
    expect(p.fn).not.toHaveBeenCalled();
    expect(screen.queryByTestId("thread-older")).toBeNull();
  });

  describe("project chat on a server with project-chat-paging-v1", () => {
    const openGroup = (loadEarlier: () => Promise<LoadEarlierResult>, more = true) => {
      setZenScope(fakeScope({ id: "s1", username: "baden", features: ["project-chat-paging-v1"] }));
      openRoom({
        thread: many(100),
        threadHasMore: more,
        threadAddr: null,
        threadGroupId: "g1",
        loadEarlier,
      });
    };

    it("nearing the top fetches one older page, with the spinner", async () => {
      const p = pager();
      openGroup(p.fn);
      await mount();
      scrollToTopOfMemory();
      expect(p.fn).not.toHaveBeenCalled();
      userScrollTo(100);
      expect(p.fn).toHaveBeenCalledTimes(1);
      userScrollTo(0);
      expect(p.fn).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("thread-older-loading")).not.toBeNull();
    });

    it("has_more false: the page lands and no further fetch goes out", async () => {
      const p = pager();
      openGroup(p.fn);
      await mount();
      scrollToTopOfMemory();
      userScrollTo(100);
      expect(p.fn).toHaveBeenCalledTimes(1);
      await p.land(olderPage(-49, 50), false);
      idle();
      rest();
      scrollToTopOfMemory();
      userScrollTo(100);
      userScrollTo(0);
      idle();
      expect(p.fn).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("thread-older-loading")).toBeNull();
    });

    it("nothing more on the server: no fetch, no top slot", async () => {
      const p = pager();
      openGroup(p.fn, false);
      await mount();
      scrollToTopOfMemory();
      userScrollTo(0);
      idle();
      expect(p.fn).not.toHaveBeenCalled();
      expect(screen.queryByTestId("thread-older")).toBeNull();
    });

    it("a failed page shows Retry (no loop); tapping it fetches again", async () => {
      const p = pager();
      openGroup(p.fn);
      await mount();
      scrollToTopOfMemory();
      userScrollTo(100);
      await p.fail();
      const retry = screen.getByTestId("thread-older-retry");
      rest();
      userScrollTo(scroller().scrollTop + 30);
      userScrollTo(0);
      idle();
      expect(p.fn).toHaveBeenCalledTimes(1);
      act(() => {
        fireEvent.click(retry);
      });
      expect(p.fn).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("thread-older-loading")).not.toBeNull();
    });
  });
});
