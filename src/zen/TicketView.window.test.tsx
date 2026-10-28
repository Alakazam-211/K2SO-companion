// @vitest-environment jsdom
// The open ticket's render window (useRenderWindow, the Thread's rules in
// threadWindow.ts): every comment stays in memory, ~WINDOW_ROWS are drawn.
// A ticket is top-aligned — it opens on the brief and its oldest comments —
// so the window starts there. Rows come back before the reader reaches an
// edge and far ones leave once quiet; nothing on screen moves. Following
// the newest (Send, "New comment ↓") the window is the newest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Long scroll sequences: on a loaded machine they pass 5 s (Agent NSI Mobile's fix).
vi.setConfig({ testTimeout: 30_000 });
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: vi.fn(() => "t"),
  getBaseUrl: vi.fn(() => ""),
  getProjects: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock("../api/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/feedback")>();
  return {
    ...actual,
    resolveFeedback: vi.fn(async () => undefined),
    commentFeedback: vi.fn(() => new Promise(() => {})),
    fetchFeedbackShow: vi.fn(),
    fetchAllFeedback: vi.fn(async () => []),
    fetchTicketUsers: vi.fn(async () => ["owner", "u"]),
  };
});
vi.mock("./ticketEvents", () => ({
  connectTicketEvents: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("../lib/useSessionIdentity", () => {
  const me = { username: "u", owner: false };
  return { useSessionIdentity: () => me };
});

import type { FeedbackComment, FeedbackShow } from "../api/feedback";
import { useFeedbackStore } from "../stores/feedback";
import { useComposerDrafts } from "./composerDrafts";
import { TicketView } from "./TicketView";
import { WINDOW_EST_ROW_PX, WINDOW_IDLE_MS, WINDOW_ROWS } from "./threadWindow";
import { RENDER_WINDOW_MAX_ROWS, RENDER_WINDOW_OPEN_ROWS, RENDER_WINDOW_STEP } from "./useRenderWindow";

// ── A tiny layout: the scroller is 600 tall at the top of the screen; its
// content is the comment list's children stacked (a row is 50px, a spacer
// its style height); scrollTop clamps.
const CLIENT = 600;
const ROW = 50;
const tops = new WeakMap<Element, number>();
const is = (el: Element, id: string) => el.getAttribute?.("data-testid") === id;
const list = () => document.querySelector<HTMLElement>('[data-testid="ticket-comments"]');
function ownHeight(el: Element): number {
  if (el.hasAttribute("data-ticket-msg")) return ROW;
  const h = parseFloat((el as HTMLElement).style?.height ?? "");
  return Number.isFinite(h) ? h : 0;
}
function layout(): Map<Element, number> {
  const at = new Map<Element, number>();
  let y = 0;
  for (const c of Array.from(list()?.children ?? [])) {
    at.set(c, y);
    y += ownHeight(c);
  }
  at.set(list() as Element, y);
  return at;
}
const contentHeight = () => layout().get(list() as Element) ?? 0;

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

const NOW = 1_760_000_000;
const comment = (n: number): FeedbackComment => ({
  author: "sales",
  body: `comment ${n}`,
  at: NOW - 100_000 + n,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => comment(i + 1));

function ticket(comments: FeedbackComment[]): FeedbackShow {
  return {
    id: "t1",
    projectId: "p1",
    sessionId: null,
    sessionKind: null,
    agentName: "sales",
    kind: "question",
    title: "Which pricing tier for Acme?",
    body: "One-line summary",
    options: ["Pro", "Business"],
    priority: 2,
    status: "needs_discussion",
    answer: null,
    createdAt: NOW - 200_000,
    updatedAt: NOW,
    answeredAt: null,
    commentCount: comments.length,
    assignees: ["u"],
    hasBrief: false,
    workspace: "Skin",
    projectPath: "/tmp/skin",
    comments,
  };
}

const scroller = () => screen.getByTestId("ticket-scroller");
const drawn = () => Array.from(document.querySelectorAll<HTMLElement>("[data-win-row]"));
const nums = () => drawn().map((r) => Number(/comment (\d+)/.exec(r.textContent ?? "")?.[1]));
const rowOf = (n: number) => drawn().find((r) => r.textContent?.includes(`comment ${n}`))!;
const rectTop = (n: number) => rowOf(n).getBoundingClientRect().top;
const atBottom = () => scroller().scrollTop === Math.max(0, contentHeight() - CLIENT);

function userScrollTo(top: number) {
  const el = scroller();
  act(() => {
    el.scrollTop = top;
    fireEvent.scroll(el);
  });
  flushRaf();
}
function idle() {
  act(() => {
    vi.advanceTimersByTime(WINDOW_IDLE_MS * 3);
  });
}
function firstVisible(): number {
  const top = scroller().scrollTop;
  const at = layout();
  for (const r of drawn()) {
    if ((at.get(r) ?? 0) + ROW > top + 1) return Number(/comment (\d+)/.exec(r.textContent ?? "")?.[1]);
  }
  return -1;
}
function arrive(c: FeedbackComment) {
  const cur = useFeedbackStore.getState().openItem as FeedbackShow;
  act(() => useFeedbackStore.setState({ openItem: { ...cur, comments: [...cur.comments, c] } }));
}

function mount(n: number) {
  useFeedbackStore.setState({ openId: "t1", openItem: ticket(many(n)), commentOutbox: [] });
  render(
    <div style={{ position: "relative", height: 800 }}>
      <TicketView id="t1" linked onBack={() => {}} />
    </div>
  );
  flushRaf();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useComposerDrafts.getState().reload();
  rafQueue = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, "ticket-scroller") ? contentHeight() : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, "ticket-scroller") ? CLIENT : 0;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      const max = is(this, "ticket-scroller") ? Math.max(0, contentHeight() - CLIENT) : 0;
      tops.set(this, Math.min(Math.max(0, v), max));
    },
  });
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement === list() ? layout().get(this) ?? 0 : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement === list() ? ownHeight(this) : 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    let top = 0;
    let h = 0;
    if (is(this, "ticket-scroller")) {
      h = CLIENT;
    } else if (this.parentElement === list()) {
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
});

const ownRect = Element.prototype.getBoundingClientRect;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop", "offsetTop", "offsetHeight"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  Element.prototype.getBoundingClientRect = ownRect;
});

describe("Ticket render window", () => {
  it("a 300-comment ticket opens on the brief and its oldest WINDOW_ROWS comments", () => {
    mount(300);
    expect(screen.getByTestId("ticket-summary")).toBeTruthy();
    expect(screen.getByTestId("answer-card")).toBeTruthy();
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(nums()[0]).toBe(1);
    expect(nums()[nums().length - 1]).toBe(WINDOW_ROWS);
    expect(screen.queryByTestId("ticket-window-above")).toBeNull();
    // The rest stand in at an estimate (never drawn yet).
    expect(screen.getByTestId("ticket-window-below").style.height).toBe(
      `${(300 - WINDOW_ROWS) * WINDOW_EST_ROW_PX}px`
    );
    expect(scroller().scrollTop).toBe(0);
  });

  it("a short ticket draws every comment, no spacers", () => {
    mount(12);
    expect(drawn()).toHaveLength(12);
    expect(screen.queryByTestId("ticket-window-above")).toBeNull();
    expect(screen.queryByTestId("ticket-window-below")).toBeNull();
  });

  it("opens at 30, grows to 50 at most (constants)", () => {
    expect(RENDER_WINDOW_OPEN_ROWS).toBe(30);
    expect(RENDER_WINDOW_MAX_ROWS).toBe(50);
    expect(WINDOW_ROWS).toBe(RENDER_WINDOW_OPEN_ROWS);
  });

  it("reading down draws more from memory before the reader gets there, up to 50, nothing moving", () => {
    mount(300);
    userScrollTo(200);
    const seen = firstVisible();
    const before = rectTop(seen);
    expect(drawn()).toHaveLength(RENDER_WINDOW_OPEN_ROWS + RENDER_WINDOW_STEP);
    expect(drawn()).toHaveLength(RENDER_WINDOW_MAX_ROWS);
    expect(nums()[0]).toBe(1);
    expect(rectTop(seen)).toBe(before);
  });

  it("past 50 the far end (above) drops for a spacer of its measured height; reading back up redraws it and drops below", () => {
    mount(300);
    for (let i = 0; i < 6; i++) {
      const target = scroller().scrollTop + 1000;
      const seen = firstVisible();
      userScrollTo(target);
      // Each step: never over 50, and the window change (rows drawn below,
      // rows dropped above for a spacer) moves nothing on screen.
      expect(drawn().length).toBeLessThanOrEqual(RENDER_WINDOW_MAX_ROWS);
      expect(scroller().scrollTop).toBe(target);
      expect(seen).toBeGreaterThan(0);
    }
    expect(nums()[0]).toBeGreaterThan(1);
    const above = screen.getByTestId("ticket-window-above");
    expect(above.style.height).toBe(`${(nums()[0] - 1) * ROW}px`);
    // A window change holds the view: same content height above the view.
    const seen = firstVisible();
    const before = rectTop(seen);
    const top = scroller().scrollTop;
    userScrollTo(top + 1);
    expect(rectTop(seen)).toBe(before - 1);
    // Back up: rows come back above, the far end (below) drops; ≤ 50 throughout.
    for (let i = 0; i < 60 && nums()[0] > 1; i++) {
      userScrollTo(scroller().scrollTop - 400);
      expect(drawn().length).toBeLessThanOrEqual(RENDER_WINDOW_MAX_ROWS);
    }
    expect(nums()[0]).toBe(1);
    expect(drawn()).toHaveLength(RENDER_WINDOW_MAX_ROWS);
    expect(screen.queryByTestId("ticket-window-above")).toBeNull();
  });

  it("leaving the ticket and coming back opens at 30 again", () => {
    mount(300);
    for (let i = 0; i < 3; i++) userScrollTo(scroller().scrollTop + 1000);
    expect(drawn().length).toBeGreaterThan(RENDER_WINDOW_OPEN_ROWS);
    cleanup();
    mount(300);
    expect(drawn()).toHaveLength(RENDER_WINDOW_OPEN_ROWS);
    expect(nums()[0]).toBe(1);
  });

  it("an arrival while reading up the ticket shows the pill; tapping it jumps to the newest, the window there", () => {
    mount(300);
    userScrollTo(100);
    arrive({ author: "sales", body: "comment 301", at: NOW });
    expect(nums()).not.toContain(301);
    act(() => {
      fireEvent.click(screen.getByTestId("ticket-new-comment"));
    });
    flushRaf();
    expect(nums()[nums().length - 1]).toBe(301);
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(atBottom()).toBe(true);
  });

  it("Send from the top of a long ticket: the window moves to the newest, the send under it", () => {
    mount(300);
    fireEvent.change(screen.getByTestId("ticket-composer-input"), { target: { value: "Agreed" } });
    act(() => {
      fireEvent.submit(screen.getByTestId("ticket-composer-form"));
    });
    flushRaf();
    expect(nums()[nums().length - 1]).toBe(300);
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    const rows = screen.getAllByTestId("ticket-comment");
    expect(rows[rows.length - 1].getAttribute("data-outgoing")).toBe("sending");
    expect(atBottom()).toBe(true);
  });

  it("at the newest, arrivals draw at once; the oldest drop off once quiet, nothing moving", () => {
    mount(300);
    // Down to the newest by the pill (the window moves there).
    userScrollTo(100);
    arrive({ author: "sales", body: "comment 301", at: NOW });
    act(() => {
      fireEvent.click(screen.getByTestId("ticket-new-comment"));
    });
    flushRaf();
    idle();
    expect(nums()[nums().length - 1]).toBe(301);
    for (let n = 302; n <= 306; n++) arrive({ author: "sales", body: `comment ${n}`, at: NOW + n });
    expect(nums()[nums().length - 1]).toBe(306);
    expect(drawn()).toHaveLength(WINDOW_ROWS + 5);
    expect(atBottom()).toBe(true);
    const height = contentHeight();
    const top = scroller().scrollTop;
    idle();
    expect(drawn()).toHaveLength(WINDOW_ROWS);
    expect(nums()[0]).toBe(306 - WINDOW_ROWS + 1);
    expect(screen.getByTestId("ticket-window-above").style.height).not.toBe("");
    expect(contentHeight()).toBe(height);
    expect(scroller().scrollTop).toBe(top);
  });
});
