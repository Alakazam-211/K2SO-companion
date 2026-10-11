// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  __resetViewportForTests,
  useViewport,
} from "./useViewportHeight";

/** A WKWebView-ish visualViewport: settable height / offsetTop, fires
 *  resize and scroll like the real one. */
class FakeVisualViewport extends EventTarget {
  height = 0;
  offsetTop = 0;
}

const FULL = 844;
const KEYBOARD = 336;
let vv: FakeVisualViewport;
let scrollY = 0;

function setInner(h: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
}

function Probe() {
  const { height, offsetTop } = useViewport();
  return <div data-testid="probe" data-h={height} data-top={offsetTop} />;
}

function read() {
  const el = document.querySelector('[data-testid="probe"]') as HTMLElement;
  return { h: Number(el.dataset.h), top: Number(el.dataset.top) };
}

/** Run every pending frame / timer (the coalesced re-measures). */
function flush() {
  act(() => {
    vi.runAllTimers();
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  setInner(FULL);
  vv = new FakeVisualViewport();
  vv.height = FULL;
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  scrollY = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  // WKWebView: scrolling the document to 0 also returns the visual
  // viewport to the top of the layout viewport.
  window.scrollTo = vi.fn(() => {
    scrollY = 0;
    vv.offsetTop = 0;
  }) as unknown as typeof window.scrollTo;
  __resetViewportForTests();
});

afterEach(() => {
  cleanup();
  __resetViewportForTests();
  vi.useRealTimers();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
}

describe("useViewport", () => {
  it("full height with the keyboard closed, visible height with it open", () => {
    render(<Probe />);
    expect(read()).toEqual({ h: FULL, top: 0 });
    vv.height = FULL - KEYBOARD;
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(read().h).toBe(FULL - KEYBOARD);
  });

  it("re-measures on resume (visibilitychange) and resets the iOS pan", () => {
    render(<Probe />);
    // Backgrounded with the composer focused; iOS re-shows the keyboard
    // and pans the page up by its height. No resize, no focusin.
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    vv.height = FULL - KEYBOARD;
    vv.offsetTop = KEYBOARD;
    scrollY = KEYBOARD;
    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    flush();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(scrollY).toBe(0);
    expect(read()).toEqual({ h: FULL - KEYBOARD, top: 0 });
  });

  it("re-measures on pageshow", () => {
    render(<Probe />);
    vv.height = FULL - KEYBOARD;
    scrollY = 120;
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    flush();
    expect(scrollY).toBe(0);
    expect(read().h).toBe(FULL - KEYBOARD);
  });

  it("a visualViewport scroll (offsetTop change without resize) re-pins the page", () => {
    render(<Probe />);
    vv.offsetTop = KEYBOARD;
    act(() => {
      vv.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(read().top).toBe(0);
  });

  it("an offsetTop iOS will not give back is reported for compensation", () => {
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo; // pan sticks
    render(<Probe />);
    vv.height = FULL - KEYBOARD;
    vv.offsetTop = KEYBOARD;
    act(() => {
      vv.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(read()).toEqual({ h: FULL - KEYBOARD, top: KEYBOARD });
    // Pan released: back to 0.
    vv.offsetTop = 0;
    act(() => {
      vv.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(read().top).toBe(0);
  });

  it("resets the scrolling element too", () => {
    const setter = vi.fn();
    const se = { scrollTop: 0 } as { scrollTop: number };
    Object.defineProperty(se, "scrollTop", { get: () => 50, set: setter });
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      get: () => se,
    });
    render(<Probe />);
    setter.mockClear();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    flush();
    expect(setter).toHaveBeenCalledWith(0);
    delete (document as unknown as Record<string, unknown>).scrollingElement;
  });

  it("does not trust a full height captured while the keyboard was up", () => {
    // Mounted with the keyboard up on a WebView whose window shrank too.
    setInner(FULL - KEYBOARD);
    vv.height = FULL - KEYBOARD;
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      get: () => window.innerHeight,
    });
    render(<Probe />);
    expect(read().h).toBe(FULL - KEYBOARD);
    // Keyboard closes: the window is full again.
    setInner(FULL);
    vv.height = FULL;
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(read().h).toBe(FULL);
    // And the next open is still detected against the fresh full height.
    vv.height = FULL - KEYBOARD;
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(read().h).toBe(FULL - KEYBOARD);
    delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
  });

  it("the native k2-viewport-resync ping re-measures after the keyboard settles", () => {
    render(<Probe />);
    act(() => {
      window.dispatchEvent(new Event("k2-viewport-resync"));
    });
    // Keyboard and pan land 300ms later.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    vv.height = FULL - KEYBOARD;
    vv.offsetTop = KEYBOARD;
    flush();
    expect(read()).toEqual({ h: FULL - KEYBOARD, top: 0 });
    expect(vv.offsetTop).toBe(0);
  });

  it("shares one measurement across screens and cleans up on unmount", () => {
    const add = vi.spyOn(vv, "addEventListener");
    const remove = vi.spyOn(vv, "removeEventListener");
    const a = render(<Probe />);
    const b = render(<Probe />);
    expect(add).toHaveBeenCalledTimes(2); // resize + scroll, once
    a.unmount();
    expect(remove).not.toHaveBeenCalled();
    b.unmount();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
