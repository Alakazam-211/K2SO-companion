// @vitest-environment jsdom
// A push tap for a message the cached copy does not have yet: the focus
// waits for the server's copy (bounded), then lands on it; never there →
// back to the newest, as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("./zenScope", async () => (await import("../test/zenScopeMock")).zenScopeModule);
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, getThreadActivity: vi.fn(async () => ({ ok: true, data: { turn: null } })) };
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

import { ThreadPane } from "./ThreadPane";
import { FOCUS_WAIT_MS } from "./threadFocus";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const CLIENT = 600;
let height = 1800;
const isScroller = (el: Element) => el.getAttribute?.("data-testid") === "thread-scroller";
const tops = new WeakMap<Element, number>();
let landed: string[] = [];
const ownScrollIntoView = Element.prototype.scrollIntoView;

const msg = (seq: number): ThreadMessage => ({
  id: `m${seq}`,
  seq,
  text: `message ${seq}`,
  from: "appa",
  at: seq,
  mine: false,
  kind: "text",
  choice: null,
});
const upTo = (n: number) => Array.from({ length: n }, (_, i) => msg(i + 1));

function openRoom(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-f",
    threadHasMore: false,
    threadLoadingEarlier: false,
    threadCached: true,
    threadHolding: false,
    agentId: "appa",
    agents: [],
    thread: upTo(10),
    outbox: [],
    threadFocusSeq: 12,
    ...over,
  });
}
const scroller = () => screen.getByTestId("thread-scroller");
const focus = () => useZenStore.getState().threadFocusSeq;
const highlighted = () => document.querySelector('[data-highlight="true"]')?.getAttribute("data-seq") ?? null;

beforeEach(() => {
  height = 1800;
  landed = [];
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
  Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
    landed.push(this.getAttribute("data-seq") ?? "");
    scroller().scrollTop = 300;
  }) as never;
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  Element.prototype.scrollIntoView = ownScrollIntoView;
});

describe("push tap to a message", () => {
  it("in the cached copy at first paint: lands on it at once", () => {
    openRoom({ threadFocusSeq: 4 });
    render(<ThreadPane />);
    expect(landed).toEqual(["4"]);
    expect(highlighted()).toBe("4");
    expect(focus()).toBeNull();
  });

  it("not in the cached copy: waits for the server's copy, then lands on it (no pill)", () => {
    openRoom();
    render(<ThreadPane />);
    expect(landed).toEqual([]);
    expect(focus()).toBe(12);
    height = 2000;
    act(() => useZenStore.setState({ thread: upTo(13), threadCached: false }));
    expect(landed).toEqual(["12"]);
    expect(highlighted()).toBe("12");
    expect(focus()).toBeNull();
    expect(screen.queryByTestId("thread-new-message")).toBeNull();
  });

  it("the first paint held for the read delivers it: focused at that first paint", () => {
    openRoom({ thread: [], threadSource: "loading", threadCached: false, threadHolding: true });
    render(<ThreadPane />);
    expect(focus()).toBe(12);
    act(() => useZenStore.setState({ thread: upTo(13), threadSource: "live", threadHolding: false }));
    expect(landed).toEqual(["12"]);
    expect(focus()).toBeNull();
  });

  it("not in the server's copy either: given up, back at the newest", () => {
    openRoom();
    render(<ThreadPane />);
    height = 2000;
    act(() => useZenStore.setState({ thread: upTo(11), threadCached: false }));
    expect(landed).toEqual([]);
    expect(focus()).toBeNull();
    expect(scroller().scrollTop).toBe(height - CLIENT);
  });

  it("the server's copy never comes: given up after the wait", () => {
    vi.useFakeTimers();
    openRoom();
    render(<ThreadPane />);
    act(() => vi.advanceTimersByTime(FOCUS_WAIT_MS - 10));
    expect(focus()).toBe(12);
    act(() => vi.advanceTimersByTime(20));
    expect(focus()).toBeNull();
    expect(landed).toEqual([]);
    expect(scroller().scrollTop).toBe(height - CLIENT);
  });
});
