// @vitest-environment jsdom
// Agent messages arriving while following glide in (iMessage): the list
// stays where it was and glides up by what came in, each new row fades in
// and rises. Never on a chat's first (cached) paint, never on a cache →
// server swap that added nothing, never when the reader is scrolled up (the
// pill rises in instead), never under reduced motion. The working drawer
// folding away and the reply landing are one motion. A send's own glide and
// an arrival fold together.
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
import type { ThreadMessage } from "./threadModel";
import { useZenStore } from "./zenStore";
import { rememberLanded } from "./outbox";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";
import {
  INCOMING_FADE_MS,
  INCOMING_MAX_FADED,
  INCOMING_MS,
  INCOMING_RISE_PX,
  INCOMING_STAGGER_CAP_MS,
  INCOMING_STAGGER_MS,
  REPLY_FOLD_MS,
} from "./listGlide";

const CLIENT = 600;
let height = 1800;
const isScroller = (el: Element) => el.getAttribute?.("data-testid") === "thread-scroller";
const tops = new WeakMap<Element, number>();
let clock = 0;

type FakeAnim = { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };
type Call = { el: Element; frames: Keyframe[]; timing: KeyframeAnimationOptions; anim: FakeAnim };
let calls: Call[] = [];

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

const ten = () => Array.from({ length: 10 }, (_, i) => msg(`m${i + 1}`, i + 1, `message ${i + 1}`));

function openRoom(over: Record<string, unknown> = {}) {
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: "conv-arrive",
    threadHasMore: false,
    threadLoadingEarlier: false,
    threadFocusSeq: null,
    threadCached: false,
    threadHolding: false,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: ten(),
    outbox: [],
    landedKeys: {},
    sending: false,
    sendError: null,
    ...over,
  });
}

const scroller = () => screen.getByTestId("thread-scroller");
const bottom = () => height - CLIENT;
const socket = () => vi.mocked(connectOverlayEvents).mock.calls[0][0];
const isContent = (el: Element) => el.getAttribute("data-testid") === "thread-content";
const glides = () => calls.filter((c) => isContent(c.el));
const rowFades = () => calls.filter((c) => c.el.hasAttribute("data-thread-msg"));
const firstY = (c: Call) => parseFloat(/, ([-\d.]+)px, 0px\)/.exec(String(c.frames[0].transform))![1]);

function userScrollTo(top: number) {
  const el = scroller();
  el.scrollTop = top;
  fireEvent.scroll(el);
}

function reduceMotion() {
  window.matchMedia = vi.fn((q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as never;
}

/** Push the agent's message `id` over the live socket, the content
 *  growing by `grow` px. */
function agentSays(id: string, seq: number, text: string, grow: number) {
  height += grow;
  act(() => socket().onItem(threadFrame(id, seq, text) as never));
}

beforeEach(() => {
  localStorage.clear();
  height = 1800;
  clock = 0;
  calls = [];
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
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  Element.prototype.animate = vi.fn(function (this: Element, kf: Keyframe[], timing: KeyframeAnimationOptions) {
    const anim: FakeAnim = { onfinish: null, oncancel: null, cancel: vi.fn() };
    calls.push({ el: this, frames: kf, timing, anim });
    return anim;
  }) as never;
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  vi.mocked(postThread).mockReturnValue(new Promise(() => {}));
  openRoom();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(connectOverlayEvents).mockClear();
  vi.mocked(postThread).mockReset();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  // @ts-expect-error test cleanup
  delete Element.prototype.animate;
  // @ts-expect-error test cleanup
  delete window.matchMedia;
});

describe("arrival glide", () => {
  it("an agent message while following: the list glides up by its height and the row fades in and rises", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    expect(calls).toHaveLength(0);
    agentSays("r1", 20, "All 42 tests pass.", 100);
    // Layout is final at once (stuck to the newest)…
    expect(scroller().scrollTop).toBe(bottom());
    // …drawn where it was (100px lower) and gliding home on the spring.
    expect(glides()).toHaveLength(1);
    const g = glides()[0];
    expect(g.frames[0].transform).toBe("translate3d(0px, 100px, 0px)");
    expect(g.frames[g.frames.length - 1].transform).toBe("translate3d(0px, 0px, 0px)");
    expect(g.timing.duration).toBe(INCOMING_MS);
    expect(INCOMING_MS).toBeGreaterThanOrEqual(280);
    expect(INCOMING_MS).toBeLessThanOrEqual(350);
    expect(g.timing.easing).toBe("linear"); // the spring, baked into keyframes
    // The new row: opacity 0 → 1, 8px below → home.
    const fades = rowFades();
    expect(fades).toHaveLength(1);
    expect(fades[0].el.textContent).toContain("All 42 tests pass.");
    expect(fades[0].frames[0]).toEqual({ opacity: 0, transform: `translate3d(0px, ${INCOMING_RISE_PX}px, 0px)` });
    expect(fades[0].frames[1]).toEqual({ opacity: 1, transform: "translate3d(0px, 0px, 0px)" });
    expect(fades[0].timing.duration).toBe(INCOMING_FADE_MS);
    expect(fades[0].timing.fill).toBe("backwards");
    // Compositor-only.
    for (const c of calls) for (const k of c.frames) {
      for (const p of Object.keys(k)) expect(["transform", "opacity", "offset", "easing"]).toContain(p);
    }
    expect(screen.queryByTestId("thread-new-message")).toBeNull();
  });

  it("no glide on the chat's first (cached) paint, nor on a cache → server swap that added nothing", () => {
    openRoom({ threadCached: true });
    render(<ThreadPane />);
    expect(scroller().scrollTop).toBe(bottom());
    // The server's copy: same messages (new objects).
    act(() => useZenStore.setState({ thread: ten(), threadCached: false }));
    expect(calls).toHaveLength(0);
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("a cache → server swap that brings missed messages glides them in (one block, staggered)", () => {
    openRoom({ threadCached: true });
    render(<ThreadPane />);
    height += 240;
    act(() =>
      useZenStore.setState({
        thread: [...ten(), msg("n1", 11, "one"), msg("n2", 12, "two"), msg("n3", 13, "three")],
        threadCached: false,
      })
    );
    expect(scroller().scrollTop).toBe(bottom());
    expect(glides()).toHaveLength(1);
    expect(firstY(glides()[0])).toBe(240);
    expect(rowFades().map((c) => c.timing.delay)).toEqual([0, INCOMING_STAGGER_MS, 2 * INCOMING_STAGGER_MS]);
  });

  it("a big batch: one glide of at most a screenful; only the newest rows fade, the stagger capped", () => {
    render(<ThreadPane />);
    const many = Array.from({ length: 12 }, (_, i) => msg(`b${i}`, 100 + i, `batch ${i}`));
    height += 2000;
    act(() => useZenStore.setState({ thread: [...ten(), ...many] }));
    expect(glides()).toHaveLength(1);
    expect(firstY(glides()[0])).toBe(CLIENT);
    const fades = rowFades();
    expect(fades).toHaveLength(INCOMING_MAX_FADED);
    expect(fades[fades.length - 1].el.textContent).toContain("batch 11");
    expect(Math.max(...fades.map((c) => Number(c.timing.delay)))).toBeLessThanOrEqual(INCOMING_STAGGER_CAP_MS);
  });

  it("a second arrival mid-glide folds what is left into one new glide (no jump)", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    agentSays("r1", 20, "first", 100);
    // Most of the way there (spring): only a few px left.
    clock = INCOMING_MS * 0.8;
    agentSays("r2", 21, "second", 100);
    expect(glides()).toHaveLength(2);
    expect(glides()[0].anim.cancel).toHaveBeenCalled();
    const left = firstY(glides()[1]) - 100;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(10);
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("scrolled up: no glide; the 'New message' pill rises in", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    userScrollTo(300);
    agentSays("r1", 20, "Done.", 100);
    expect(scroller().scrollTop).toBe(300);
    expect(glides()).toHaveLength(0);
    expect(rowFades()).toHaveLength(0);
    const pill = screen.getByTestId("thread-new-message");
    expect(pill.className).toContain("zen-pill-in");
  });

  it("reduced motion: nothing animates, the newest is in place", async () => {
    reduceMotion();
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    agentSays("r1", 20, "Done.", 100);
    expect(calls).toHaveLength(0);
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("our own send is not an arrival: its row never gets the arrival fade", () => {
    render(<ThreadPane />);
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "hello" } });
    height += 60;
    fireEvent.submit(screen.getByTestId("composer-form"));
    expect(rowFades()).toHaveLength(0);
    // The server's copy replaces it (keyed by its localId): still not one.
    const { localId, roomKey } = useZenStore.getState().outbox[0];
    act(() =>
      useZenStore.setState({
        outbox: [],
        landedKeys: rememberLanded({}, roomKey, "s1", localId),
        thread: [...ten(), msg("s1", 11, "hello", true)],
      })
    );
    expect(rowFades()).toHaveLength(0);
  });
});

describe("the working drawer and the reply: one motion", () => {
  it("the drawer folds away first: the list holds still, and the reply's glide takes both", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    // Opens: the list glides up by the 18px it covers.
    height += 18;
    act(() => socket().onItem(activityFrame(1, false) as never));
    expect(scroller().style.paddingBottom).toBe("30px");
    expect(glides()).toHaveLength(1);
    expect(firstY(glides()[0])).toBe(18);
    clock = 1000; // that glide is long done
    // Ends: the padding goes at once; the list is held where it was.
    height -= 18;
    act(() => socket().onItem(activityFrame(2, true) as never));
    expect(scroller().style.paddingBottom).toBe("12px");
    expect(scroller().scrollTop).toBe(bottom());
    expect(glides()).toHaveLength(2);
    const fold = glides()[1];
    expect(firstY(fold)).toBe(-18);
    expect(fold.timing.delay).toBe(REPLY_FOLD_MS);
    expect(fold.timing.fill).toBe("backwards");
    // The reply lands inside the hold: one glide for both, from where the
    // list is drawn (−18) plus the reply's 100px, no delay.
    clock = 1100;
    agentSays("r1", 20, "All 42 tests pass.", 100);
    expect(glides()).toHaveLength(3);
    expect(firstY(glides()[2])).toBe(82);
    expect(glides()[2].timing.delay).toBe(0);
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("the reply lands first: the drawer folding away rides the running glide (no restart, no bounce)", async () => {
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    height += 18;
    act(() => socket().onItem(activityFrame(1, false) as never));
    clock = 1000;
    agentSays("r1", 20, "All 42 tests pass.", 100);
    expect(firstY(glides()[1])).toBe(100);
    // 40ms later the turn ends.
    clock = 1040;
    height -= 18;
    act(() => socket().onItem(activityFrame(2, true) as never));
    expect(glides()).toHaveLength(3);
    const ride = glides()[2];
    // Same curve, joined part-way in (negative delay), never held, and it
    // still lands at the same moment the reply's glide would have.
    expect(Number(ride.timing.delay)).toBeCloseTo(-40, 5);
    expect(ride.timing.duration).toBe(INCOMING_MS);
    // Downward never: the list only moves up, toward its resting place.
    for (const k of ride.frames) {
      expect(parseFloat(/, ([-\d.]+)px, 0px\)/.exec(String(k.transform))![1])).toBeGreaterThanOrEqual(0);
    }
    expect(scroller().scrollTop).toBe(bottom());
  });

  it("reduced motion: the drawer's padding changes at once, nothing animates", async () => {
    reduceMotion();
    render(<ThreadPane />);
    await waitFor(() => expect(connectOverlayEvents).toHaveBeenCalled());
    height += 18;
    act(() => socket().onItem(activityFrame(1, false) as never));
    height -= 18;
    act(() => socket().onItem(activityFrame(2, true) as never));
    expect(glides()).toHaveLength(0);
    expect(scroller().scrollTop).toBe(bottom());
  });
});

describe("a send and an arrival", () => {
  it("an agent message during a send's flight folds into the send's glide; the flight goes on", () => {
    // The newest row moves up 60px once the sent row is in.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const sent = document.querySelector("[data-outgoing]");
      const id = this.getAttribute("data-testid");
      const r =
        id === "composer-input"
          ? { left: 20, top: 700, width: 300, height: 24 }
          : id === "thread-bubble" && this.closest("[data-outgoing]")
            ? { left: 200, top: 500, width: 80, height: 36 }
            : this.hasAttribute("data-thread-msg") && !this.hasAttribute("data-outgoing")
              ? { left: 10, top: sent ? 540 : 600, width: 200, height: 40 }
              : { left: 0, top: 0, width: 390, height: 844 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r };
    });
    render(<ThreadPane />);
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "run it" } });
    height += 60;
    fireEvent.submit(screen.getByTestId("composer-form"));
    const clone = screen.getByTestId("send-fly-clone");
    expect(glides()).toHaveLength(1);
    expect(firstY(glides()[0])).toBe(60);
    const flight = calls.find((c) => c.el === clone && c.frames[0].transform != null)!;
    // Early in the flight an agent message lands.
    clock = 50;
    height += 100;
    act(() => useZenStore.setState({ thread: [...useZenStore.getState().thread, msg("r1", 30, "On it.")] }));
    expect(glides()).toHaveLength(2);
    // What the send's glide had left, plus the arrival's 100px.
    expect(firstY(glides()[1])).toBeGreaterThan(100);
    expect(firstY(glides()[1])).toBeLessThan(160);
    // The flight is untouched: still flying, never cancelled.
    expect(flight.anim.cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId("send-fly-clone")).toBe(clone);
    act(() => flight.anim.onfinish?.());
    expect(screen.queryByTestId("send-fly-clone")).toBeNull();
  });
});
