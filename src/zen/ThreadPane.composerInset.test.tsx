// @vitest-environment jsdom
// The composer block grows (typing lines, attachment chips, the label
// line) as a flex sibling below the scroller: the scroller's box shrinks
// by the same amount. Following, the newest stays right above the field;
// reading history, the reader's scrollTop holds.
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

import { connectOverlayEvents } from "./overlayEvents";
import { ThreadPane, threadBottomInset } from "./ThreadPane";
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

// ── Flex column: the pane is PANE tall; the composer bar is `barPx`, the
// scroller gets the rest. Content is `height`; scrollTop clamps.
const PANE = 800;
const LINE = 22;
const ONE_LINE_BAR = 60;
let barPx = ONE_LINE_BAR;
let height = 1800;
const tid = (el: Element) => el.getAttribute?.("data-testid");
const isScroller = (el: Element) => tid(el) === "thread-scroller";
const client = () => PANE - barPx;
const tops = new WeakMap<Element, number>();

let resizeCallbacks: Array<() => void> = [];
function fireResize() {
  act(() => resizeCallbacks.forEach((cb) => cb()));
}

const msg = (id: string, seq: number, text: string): ThreadMessage => ({
  id,
  seq,
  text,
  from: "appa",
  at: seq,
  mine: false,
  kind: "text",
  choice: null,
});

const scroller = () => screen.getByTestId("thread-scroller");
const bottom = () => height - client();
const inset = () => Number(scroller().getAttribute("data-bottom-inset"));

/** The composer bar's layout changed to `px` tall (the browser's resize). */
function composerTo(px: number) {
  barPx = px;
  fireResize();
}

function type(lines: number) {
  fireEvent.change(screen.getByTestId("composer-input"), {
    target: { value: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") },
  });
}

function userScrollTo(top: number) {
  const el = scroller();
  el.scrollTop = top;
  fireEvent.scroll(el);
}

beforeEach(() => {
  localStorage.clear();
  barPx = ONE_LINE_BAR;
  height = 1800;
  resizeCallbacks = [];
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return isScroller(this) ? height : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return isScroller(this) ? client() : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return tid(this) === "composer-bar" ? barPx : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return tops.get(this) ?? 0;
    },
    set(v: number) {
      const max = isScroller(this) ? Math.max(0, height - client()) : 0;
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
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-inset",
    threadHasMore: false,
    threadLoadingEarlier: false,
    threadFocusSeq: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: Array.from({ length: 10 }, (_, i) => msg(`m${i + 1}`, i + 1, `message ${i + 1}`)),
    outbox: [],
    sending: false,
    sendError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(connectOverlayEvents).mockClear();
  for (const k of ["scrollHeight", "clientHeight", "offsetHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

async function open() {
  render(<ThreadPane />);
  await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
  expect(scroller().scrollTop).toBe(bottom());
}

describe("threadBottomInset", () => {
  it("is the composer block plus what the drawer covers", () => {
    expect(threadBottomInset(60, 0)).toBe(60);
    expect(threadBottomInset(60.4, 10.2)).toBe(61 + 11);
    expect(threadBottomInset(Number.NaN, -3)).toBe(0);
  });
});

describe("Thread scroller vs a growing composer", () => {
  it("growing the field from 1 to 5 lines raises the scroller's bottom inset by the same amount", async () => {
    await open();
    expect(scroller().getAttribute("data-composer-height")).toBe(String(ONE_LINE_BAR));
    const before = inset();

    type(5);
    composerTo(ONE_LINE_BAR + 4 * LINE);

    expect(inset() - before).toBe(4 * LINE);
  });

  it("following: the newest stays right above the field as it grows and shrinks", async () => {
    await open();
    for (let lines = 2; lines <= 5; lines++) {
      type(lines);
      composerTo(ONE_LINE_BAR + (lines - 1) * LINE);
      expect(scroller().scrollTop).toBe(bottom());
    }
    type(1);
    composerTo(ONE_LINE_BAR);
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("reading history: scrollTop keeps the reader's anchor as the field grows", async () => {
    await open();
    userScrollTo(300);

    type(5);
    composerTo(ONE_LINE_BAR + 4 * LINE);
    expect(scroller().scrollTop).toBe(300);

    // A transient layout clamped scrollTop with no scroll event yet: the
    // next composer resize puts the reader back.
    tops.set(scroller(), 250);
    type(3);
    composerTo(ONE_LINE_BAR + 2 * LINE);
    expect(scroller().scrollTop).toBe(300);
  });

  it("attachment chips appearing count toward the inset; the newest stays visible", async () => {
    await open();
    const before = inset();
    const CHIPS = 34;
    fireEvent.paste(screen.getByTestId("composer-form"), {
      clipboardData: { files: [new File(["x"], "shot.png", { type: "image/png" })], items: [] },
    });
    expect(screen.getByTestId("attach-chip")).not.toBeNull();

    composerTo(ONE_LINE_BAR + CHIPS);
    expect(inset() - before).toBe(CHIPS);
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("the label line (a send error) appearing keeps the newest visible", async () => {
    await open();
    act(() => useZenStore.setState({ sendError: "Not sent" }));
    expect(screen.getByTestId("composer-label").textContent).toBe("Not sent");

    composerTo(ONE_LINE_BAR + 16);
    expect(scroller().scrollTop).toBe(bottom());
  });
});
