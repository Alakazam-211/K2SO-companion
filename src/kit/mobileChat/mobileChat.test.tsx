// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { isDismissTap, useTapToDismiss } from "./useTapToDismiss";
import { useKeyboardForwardPlay } from "./useKeyboardForwardPlay";
import { keyboardColumnHeight, useKeyboardFlip } from "./useKeyboardFlip";
import type { ViewportMotion } from "../../lib/useViewportHeight";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Tap to dismiss ───────────────────────────────────────────────────

function Chat({ canDismiss, menuOpen = false }: { canDismiss?: () => boolean; menuOpen?: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useTapToDismiss({ area: () => area.current, composer: () => bar.current, canDismiss });
  return (
    <>
      <div ref={area} data-testid="area">
        <p data-testid="text">Plain bubble text</p>
        <a href="#x" data-testid="link">
          <span data-testid="link-inner">a link</span>
        </a>
        <button type="button" data-testid="chip">file.pdf</button>
        <div role="button" data-testid="role-btn">card</div>
        <div data-no-dismiss data-testid="opt-out">
          <span data-testid="opt-out-inner">x</span>
        </div>
      </div>
      <div ref={bar} data-testid="bar">
        <textarea data-testid="field" />
        <button type="button" aria-expanded={menuOpen} data-testid="plus">+</button>
      </div>
    </>
  );
}

function pointer(el: Element, type: string, x = 10, y = 10, opts: { id?: number; t?: number } = {}) {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "pointerId", { value: opts.id ?? 1 });
  Object.defineProperty(e, "clientX", { value: x });
  Object.defineProperty(e, "clientY", { value: y });
  if (opts.t != null) Object.defineProperty(e, "timeStamp", { value: opts.t });
  act(() => {
    el.dispatchEvent(e);
  });
}
function tap(el: Element, opts: { move?: number; ms?: number; cancel?: boolean } = {}) {
  pointer(el, "pointerdown", 10, 10, { t: 1000 });
  if (opts.move) pointer(el, "pointermove", 10, 10 + opts.move, { t: 1010 });
  if (opts.cancel) pointer(el, "pointercancel", 10, 10, { t: 1020 });
  pointer(el, "pointerup", 10, 10 + (opts.move ?? 0), { t: 1000 + (opts.ms ?? 80) });
}
function focusField() {
  const f = screen.getByTestId("field") as HTMLTextAreaElement;
  act(() => f.focus());
  expect(document.activeElement).toBe(f);
  return f;
}

describe("useTapToDismiss", () => {
  it("a tap on plain content (or empty space) blurs the composer", () => {
    render(<Chat />);
    focusField();
    tap(screen.getByTestId("text"));
    expect(document.activeElement).not.toBe(screen.getByTestId("field"));
    focusField();
    tap(screen.getByTestId("area"));
    expect(document.activeElement).not.toBe(screen.getByTestId("field"));
  });

  it("taps on links, buttons, role=button, [data-no-dismiss] do not", () => {
    render(<Chat />);
    const f = focusField();
    for (const id of ["link-inner", "chip", "role-btn", "opt-out-inner"]) {
      tap(screen.getByTestId(id));
      expect(document.activeElement).toBe(f);
    }
  });

  it("a drag / scroll (moved or pointer cancelled) and a long press do not", () => {
    render(<Chat />);
    const f = focusField();
    tap(screen.getByTestId("text"), { move: 30 });
    expect(document.activeElement).toBe(f);
    tap(screen.getByTestId("text"), { cancel: true });
    expect(document.activeElement).toBe(f);
    tap(screen.getByTestId("text"), { ms: 700 });
    expect(document.activeElement).toBe(f);
  });

  it("with a text selection it does not", () => {
    render(<Chat />);
    const f = focusField();
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected" } as Selection);
    tap(screen.getByTestId("text"));
    expect(document.activeElement).toBe(f);
  });

  it("with the composer's menu open the tap only closes the menu (no blur here)", () => {
    render(<Chat menuOpen />);
    const f = focusField();
    tap(screen.getByTestId("text"));
    expect(document.activeElement).toBe(f);
  });

  it("the screen can veto (a terminal in direct typing)", () => {
    render(<Chat canDismiss={() => false} />);
    const f = focusField();
    tap(screen.getByTestId("text"));
    expect(document.activeElement).toBe(f);
  });

  it("isDismissTap: the pure rules", () => {
    const p = document.createElement("p");
    const base = { moved: 0, ms: 100, cancelled: false, target: p, selection: "", menuOpen: false };
    expect(isDismissTap(base)).toBe(true);
    expect(isDismissTap({ ...base, moved: 11 })).toBe(false);
    expect(isDismissTap({ ...base, ms: 400 })).toBe(false);
    expect(isDismissTap({ ...base, target: null })).toBe(false);
    expect(isDismissTap({ ...base, selection: "  " })).toBe(true);
  });
});

// ── Forward play (terminal) ──────────────────────────────────────────

const motion = (from: number, to: number): ViewportMotion => ({
  ms: 250,
  easing: "ease-out",
  elapsed: 0,
  from,
  to,
});

function Term({ m, begin, end }: { m: ViewportMotion | null; begin: () => void; end: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useKeyboardForwardPlay({ motion: m, movers: () => [bar.current], hold: { begin, end } });
  return <div ref={bar} data-testid="mover" />;
}

describe("useKeyboardForwardPlay", () => {
  it("plays the composer by transform; holds once at the start, commits once at the end", () => {
    const begin = vi.fn();
    const end = vi.fn();
    const { rerender } = render(<Term m={null} begin={begin} end={end} />);
    expect(begin).not.toHaveBeenCalled();
    const m = motion(844, 508);
    rerender(<Term m={m} begin={begin} end={end} />);
    const mover = screen.getByTestId("mover");
    expect(mover.style.transform).toBe("translate3d(0, -336px, 0)");
    expect(mover.style.transition).toBe("transform 250ms ease-out");
    expect(begin).toHaveBeenCalledTimes(1);
    // Re-renders mid-motion: no second hold, no commit.
    rerender(<Term m={m} begin={begin} end={end} />);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
    // The motion clears: one commit (the single re-fit).
    rerender(<Term m={null} begin={begin} end={end} />);
    expect(end).toHaveBeenCalledTimes(1);
    expect(mover.style.transform).toBe("");
    expect(mover.style.transition).toBe("none");
    rerender(<Term m={null} begin={begin} end={end} />);
    expect(end).toHaveBeenCalledTimes(1);
  });
});

function Home({ m, h, enabled }: { m: ViewportMotion | null; h: number; enabled: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useKeyboardFlip({
    viewportHeight: h,
    motion: m,
    scroller: () => list.current,
    docks: () => [bar.current],
    enabled,
  });
  return (
    <div>
      <div ref={list} data-testid="home-list" />
      <div ref={bar} data-testid="home-bar" />
    </div>
  );
}

describe("useKeyboardFlip enabling mid-motion", () => {
  it("a hide that began while disabled (hidden under a thread) is not replayed: no snap", () => {
    const hide = motion(508, 844);
    const { rerender } = render(<Home m={null} h={508} enabled={false} />);
    // The thread's swipe-back blurs the composer: the hide starts while
    // the list is hidden (disabled), then Back lands mid-motion.
    rerender(<Home m={hide} h={844} enabled={false} />);
    rerender(<Home m={hide} h={844} enabled />);
    const bar = screen.getByTestId("home-bar");
    // Final layout at once: not inverted up to the old keyboard top.
    expect(bar.style.transform).toBe("");
    rerender(<Home m={null} h={844} enabled />);
    expect(bar.style.transform).toBe("");
  });

  it("a hide that begins while enabled still plays (invert, then glide)", () => {
    const { rerender } = render(<Home m={null} h={508} enabled />);
    rerender(<Home m={motion(508, 844)} h={844} enabled />);
    const bar = screen.getByTestId("home-bar");
    expect(bar.style.transform).toBe("");
    expect(bar.style.transition).toBe("transform 250ms ease-out");
  });
});

describe("keyboardColumnHeight", () => {
  it("full during a drag, held at `from` while the keyboard rises, else the height", () => {
    expect(keyboardColumnHeight({ height: 508, motion: null, interactive: true }, 844)).toBe(844);
    expect(keyboardColumnHeight({ height: 508, motion: motion(844, 508), interactive: false }, 844)).toBe(844);
    expect(keyboardColumnHeight({ height: 844, motion: motion(508, 844), interactive: false }, 844)).toBe(844);
    expect(keyboardColumnHeight({ height: 508, motion: null, interactive: false }, 844)).toBe(508);
  });
});

// ── Short lists: show prediction, idle room drop ─────────────────────

import { finalScrollTop } from "./useKeyboardFlip";
import { useScrollRoom } from "./useScrollRoom";
import { __resetViewportForTests } from "../../lib/useViewportHeight";

function box(el: HTMLElement, o: { sh?: number; ch?: number; oh?: number; top?: number; bottom?: number }) {
  if (o.sh != null) Object.defineProperty(el, "scrollHeight", { configurable: true, value: o.sh });
  if (o.ch != null) Object.defineProperty(el, "clientHeight", { configurable: true, value: o.ch });
  if (o.oh != null) Object.defineProperty(el, "offsetHeight", { configurable: true, value: o.oh });
  if (o.top != null)
    el.getBoundingClientRect = () => ({ top: o.top!, bottom: o.bottom!, height: o.bottom! - o.top! }) as DOMRect;
}

describe("finalScrollTop (show: where a following list re-sticks)", () => {
  function list(natural: number, view: number, rest = 0) {
    const el = document.createElement("div");
    const content = document.createElement("div");
    const row = document.createElement("div");
    content.appendChild(row);
    el.appendChild(content);
    const fill = Math.max(natural, view);
    box(content, { oh: fill });
    box(row, { top: 0, bottom: natural });
    box(el, { sh: rest + fill, ch: view });
    return { el, content };
  }
  it("a short list that still fits does not scroll; one that no longer fits rises by its overflow only", () => {
    const a = list(300, 700);
    expect(finalScrollTop(a.el, a.content, 336)).toBe(0); // 300 fits 364
    const b = list(450, 700);
    expect(finalScrollTop(b.el, b.content, 336)).toBe(450 - 364);
  });
  it("a long list gains the whole growth", () => {
    const c = list(3000, 700);
    expect(finalScrollTop(c.el, c.content, 336)).toBe(3000 - 364);
  });
});

function Room({ vh, lastScrollAt }: { vh: number; lastScrollAt: () => number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useScrollRoom({
    viewportHeight: vh,
    scroller: () => scroller.current,
    room: () => room.current,
    content: () => content.current,
    lastScrollAt,
  });
  return (
    <div ref={scroller} data-testid="scroller">
      <div ref={room} data-testid="room" />
      <div ref={content} data-testid="content" />
    </div>
  );
}

describe("useScrollRoom idle drop", () => {
  afterEach(() => {
    delete (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup;
    __resetViewportForTests();
    vi.useRealTimers();
  });
  it("a drop that would move visible content (scrollTop clamps) plays over 250ms instead of snapping; one that does not, moves nothing", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup = true;
    const full = window.innerHeight;
    const { rerender } = render(<Room vh={full - 336} lastScrollAt={() => 0} />);
    const el = screen.getByTestId("scroller");
    const room = screen.getByTestId("room");
    const content = screen.getByTestId("content");
    const roomH = () => parseFloat(room.style.height) || 0;
    Object.defineProperty(content, "offsetTop", { configurable: true, get: roomH });
    let top = 0;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, v);
      },
    });
    // jsdom: the room was added at mount with scrollTop compensated.
    expect(roomH()).toBe(336 + 48);
    // The reader scrolled up into the room (100px of it showing).
    top = roomH() - 100;
    let flushed = "";
    el.getBoundingClientRect = () => {
      flushed = content.style.transform;
      return new DOMRect();
    };
    rerender(<Room vh={full} lastScrollAt={() => 0} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(roomH()).toBe(0);
    expect(top).toBe(0);
    // The content moved up 100px by layout; it was drawn back where it was
    // and eases to its rest.
    expect(flushed).toBe("translate3d(0, 100px, 0)");
    expect(content.style.transform).toBe("");
    expect(content.style.transition).toBe("transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1)");
  });
});
