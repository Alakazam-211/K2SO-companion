// @vitest-environment jsdom
// The composer's bottom gap (home indicator at rest, 8px while typing):
// the scroller's spacer and the list's min-height take the new gap at once
// (no layout transition, index.css), and a following list re-sticks once
// and plays the move as a compositor `translate` on the keyboard's timing
// (easeGapShift) — no per-frame sticking loop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

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

import { ThreadPane } from "./ThreadPane";
import { useZenStore } from "./zenStore";
import { COMPOSER_FOCUSED_ATTR, easeGapShift } from "../kit/mobileChat/useComposerFocusGap";
import { fakeScope } from "../test/fakeScope";
import { setZenScope } from "../test/zenScopeMock";

const CLIENT = 600;
const REST_GAP = 34;
const TYPING_GAP = 8;
const tops = new WeakMap<Element, number>();
const isScroller = (el: Element) => el.getAttribute?.("data-testid") === "thread-scroller";
const pane = () => document.querySelector(".zen-thread-pane");
/** Content 1800 tall plus the gap spacer, which follows the attribute. */
const height = () => 1800 + (pane()?.hasAttribute(COMPOSER_FOCUSED_ATTR) ? TYPING_GAP : REST_GAP);

type Call = { el: Element; frames: Keyframe[]; timing: KeyframeAnimationOptions };
let calls: Call[] = [];
let rafQueue: FrameRequestCallback[] = [];
/** Run frames until none are asked for (at most `max`); how many ran. */
function drainFrames(max: number): number {
  let n = 0;
  while (rafQueue.length && n < max) {
    const q = rafQueue;
    rafQueue = [];
    act(() => q.forEach((cb) => cb(0)));
    n++;
  }
  return n;
}

beforeEach(() => {
  calls = [];
  rafQueue = [];
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? height() : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? CLIENT : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      const max = isScroller(this) ? Math.max(0, height() - CLIENT) : 0;
      tops.set(this, Math.min(Math.max(0, v), max));
    },
  });
  Element.prototype.animate = vi.fn(function (this: Element, frames: Keyframe[], timing: KeyframeAnimationOptions) {
    calls.push({ el: this, frames, timing });
    return { cancel() {}, finish() {}, onfinish: null, oncancel: null } as unknown as Animation;
  }) as unknown as typeof Element.prototype.animate;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  setZenScope(fakeScope({ id: "s1", username: "baden" }));
  useZenStore.setState({
    agentSource: "live",
    threadSource: "live",
    threadError: null,
    threadAddr: "appa",
    threadGroupId: null,
    threadConversationId: null,
    agentId: "appa",
    agents: [{ id: "appa", name: "appa", initial: "A", path: "/Users/Baden/Appa", addr: "appa" }],
    thread: [{ id: "m1", seq: 1, text: "hi", from: "appa", at: 1, mine: false, kind: "text", choice: null }],
    outbox: [],
    sending: false,
    sendError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  delete (Element.prototype as unknown as Record<string, unknown>).animate;
});

const gapShifts = () =>
  calls.filter((c) => c.el.getAttribute("data-testid") === "thread-content" && c.frames[0]?.translate != null);

describe("composer gap", () => {
  it("index.css: the spacer and the list's min-height do not transition; the bar's padding does", async () => {
    // @ts-expect-error -- node builtin, no @types/node in this project
    const { readFileSync } = await import("fs");
    const css = readFileSync("src/styles/index.css", "utf8") as string;
    expect(css).not.toMatch(/transition:\s*height var\(--k2-kb-ms\)/);
    expect(css).not.toMatch(/transition:\s*min-height/);
    expect(css).toMatch(/transition:\s*padding-bottom var\(--k2-kb-ms\) var\(--k2-kb-ease\)/);
  });

  it("focus while following: re-sticks once, eases the move with a translate, no frame loop", () => {
    render(<ThreadPane />);
    const el = screen.getByTestId("thread-scroller");
    expect(el.scrollTop).toBe(height() - CLIENT);
    drainFrames(10);
    const before = el.scrollTop;
    act(() => {
      (screen.getByTestId("composer-input") as HTMLTextAreaElement).focus();
    });
    // At the newest under the new gap, at once.
    expect(el.scrollTop).toBe(height() - CLIENT);
    const dy = el.scrollTop - before;
    expect(dy).toBe(TYPING_GAP - REST_GAP);
    const shifts = gapShifts();
    expect(shifts).toHaveLength(1);
    expect(shifts[0].frames).toEqual([{ translate: `0px ${dy}px` }, { translate: "0px 0px" }]);
    expect(shifts[0].timing.duration).toBe(250);
    // follow()'s next-frame re-stick, not a loop through the ease.
    expect(drainFrames(20)).toBeLessThan(5);
  });

  it("easeGapShift: nothing for no move, with reduced motion, or on Android", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    easeGapShift(el, 0.2);
    expect(calls).toHaveLength(0);
    document.body.classList.add("platform-android");
    easeGapShift(el, -26);
    expect(calls).toHaveLength(0);
    document.body.classList.remove("platform-android");
    easeGapShift(el, -26);
    expect(calls).toHaveLength(1);
    el.remove();
  });
});
