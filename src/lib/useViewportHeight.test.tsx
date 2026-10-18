// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  KEYBOARD_EASING,
  KEYBOARD_MS,
  __resetViewportForTests,
  keyboardEasing,
  keyboardMotionMs,
  beginKeyboardDrag,
  endKeyboardDrag,
  keyboardTopNow,
  setKeyboardDragHandler,
  useViewport,
  useViewportPadRef,
  useViewportTrackRef,
  viewportTransition,
  type KeyboardWill,
  type ViewportMotion,
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

describe("keyboard motion (native UIKeyboardWill*)", () => {
  let seen: ViewportMotion | null = null;
  function MotionProbe() {
    const { height, offsetTop, motion } = useViewport();
    seen = motion;
    return <div data-testid="probe" data-h={height} data-top={offsetTop} />;
  }
  function will(d: KeyboardWill) {
    act(() => {
      (window as unknown as { __k2KeyboardWill: (d: KeyboardWill) => void }).__k2KeyboardWill(d);
    });
  }
  function keyboardUp() {
    vv.height = FULL - KEYBOARD;
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    flush();
  }
  let mql: boolean;
  beforeEach(() => {
    seen = null;
    mql = false;
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("reduce") ? mql : false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });

  it("hide: jumps to full height at once with the keyboard's timing, holds it, then settles", () => {
    render(<MotionProbe />);
    keyboardUp();
    expect(read().h).toBe(FULL - KEYBOARD);

    will({ height: 0, duration: 250, curve: 7, show: false });
    expect(read().h).toBe(FULL);
    expect(seen).toEqual({
      ms: 250,
      easing: KEYBOARD_EASING,
      elapsed: 0,
      from: FULL - KEYBOARD,
      to: FULL,
    });

    // WebKit's visualViewport and the native ping still report the
    // keyboard mid-slide: they must not fight the glide.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      vv.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new CustomEvent("k2-viewport-resize", { detail: { height: FULL - KEYBOARD } }));
    });
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(read().h).toBe(FULL);
    expect(seen).not.toBeNull();

    // Landed: the re-measure takes over and the motion clears.
    vv.height = FULL;
    flush();
    expect(read().h).toBe(FULL);
    expect(seen).toBeNull();
  });

  it("show: heads straight for full minus the keyboard's overlap", () => {
    render(<MotionProbe />);
    will({ height: KEYBOARD, duration: 300, curve: 7, show: true });
    expect(read().h).toBe(FULL - KEYBOARD);
    expect(seen?.ms).toBe(300);
    // An intermediate visualViewport height mid-animation is ignored.
    vv.height = FULL - 120;
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(read().h).toBe(FULL - KEYBOARD);
    // Still resets the reveal pan while holding.
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    // After the animation the post-measure corrects to the real value.
    vv.height = FULL - KEYBOARD - 4;
    flush();
    expect(read().h).toBe(FULL - KEYBOARD - 4);
    expect(seen).toBeNull();
  });

  it("the post-animation re-measure fires on its own (no other event)", () => {
    render(<MotionProbe />);
    keyboardUp();
    will({ height: 0, duration: 250, curve: 7, show: false });
    vv.height = FULL;
    act(() => {
      vi.advanceTimersByTime(250 + 59);
    });
    expect(seen).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(seen).toBeNull();
    expect(read().h).toBe(FULL);
  });

  it("WillShow + WillChangeFrame for one animation do not restart it", () => {
    render(<MotionProbe />);
    will({ height: KEYBOARD, duration: 250, curve: 7, show: true });
    const first = seen;
    act(() => {
      vi.advanceTimersByTime(200);
    });
    will({ height: KEYBOARD, duration: 250, curve: 7, show: true });
    expect(seen).toBe(first);
    // Still settles on the first one's schedule.
    vv.height = FULL - KEYBOARD;
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(seen).toBeNull();
  });

  it("reversing mid-animation (show, then hide) retargets with fresh timing", () => {
    render(<MotionProbe />);
    will({ height: KEYBOARD, duration: 250, curve: 7, show: true });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    will({ height: 0, duration: 250, curve: 7, show: false });
    expect(read().h).toBe(FULL);
    expect(seen?.ms).toBe(250);
  });

  it("reduced motion: the same final height at once, no motion", () => {
    mql = true;
    render(<MotionProbe />);
    keyboardUp();
    will({ height: 0, duration: 250, curve: 7, show: false });
    expect(read().h).toBe(FULL);
    expect(seen).toBeNull();
  });

  it("a hardware-keyboard bar (under the slop) changes nothing", () => {
    render(<MotionProbe />);
    will({ height: 55, duration: 250, curve: 7, show: true });
    expect(read().h).toBe(FULL);
    expect(seen).toBeNull();
  });

  it("no duration (unanimated frame change): snaps, no motion", () => {
    render(<MotionProbe />);
    will({ height: KEYBOARD, duration: 0, curve: 7, show: true });
    expect(read().h).toBe(FULL - KEYBOARD);
    expect(seen).toBeNull();
  });

  it("the bridge hop is skipped: elapsed comes from the native timestamp", () => {
    render(<MotionProbe />);
    will({ height: KEYBOARD, duration: 250, curve: 7, show: true, at: Date.now() - 40 });
    expect(seen!.elapsed).toBeGreaterThanOrEqual(40);
    expect(seen!.elapsed).toBeLessThan(80);
    expect(viewportTransition(seen)).toMatch(
      new RegExp(`^height 250ms ${KEYBOARD_EASING.replace(/[()]/g, "\\$&")} -[\\d.]+ms$`)
    );
  });

  it("the reported duration and curve reach the CSS (--k2-kb-*) and keyboardMotionMs", () => {
    render(<MotionProbe />);
    expect(keyboardMotionMs()).toBe(KEYBOARD_MS);
    will({ height: KEYBOARD, duration: 320, curve: 0, show: true });
    expect(keyboardMotionMs()).toBe(320);
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--k2-kb-ms")).toBe("320ms");
    expect(root.getPropertyValue("--k2-kb-ease")).toBe("ease-in-out");
    root.removeProperty("--k2-kb-ms");
    root.removeProperty("--k2-kb-ease");
  });

  it("timing helpers", () => {
    expect(keyboardEasing(7)).toBe(KEYBOARD_EASING);
    expect(keyboardEasing(undefined)).toBe(KEYBOARD_EASING);
    expect(keyboardEasing(3)).toBe("linear");
    expect(keyboardEasing(2)).toBe("ease-out");
    expect(viewportTransition(null)).toBeUndefined();
    expect(viewportTransition({ ms: 250, easing: "linear", elapsed: 0, from: 500, to: 844 })).toBe("height 250ms linear");
    expect(viewportTransition({ ms: 250, easing: "linear", elapsed: 12.4, from: 500, to: 844 }, "top")).toBe(
      "top 250ms linear -12.4ms"
    );
  });
});

describe("interactive keyboard dismiss (drag start / release hand-off)", () => {
  let seen: { h: number; interactive: boolean; motion: ViewportMotion | null } | null = null;
  let renders = 0;
  /** Zen's thread column with the scroller's drag pad. */
  function Column() {
    const { height, motion, interactive } = useViewport();
    const ref = useViewportTrackRef();
    const pad = useViewportPadRef();
    renders++;
    seen = { h: height, interactive, motion };
    return (
      // Zen's thread column: no height transition; held at `from` while
      // the keyboard rises (ThreadPane plays it by FLIP).
      <div
        data-testid="col"
        ref={ref}
        style={{
          height: interactive ? FULL : motion && motion.to < motion.from ? motion.from : height,
        }}
      >
        <div data-testid="pad" ref={pad} />
      </div>
    );
  }
  const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  function will(d: KeyboardWill) {
    act(() => {
      (window as unknown as { __k2KeyboardWill: (d: KeyboardWill) => void }).__k2KeyboardWill(d);
    });
  }
  function signal(overlap: number) {
    act(() => {
      (window as unknown as { __k2KeyboardTrack: (h: number) => void }).__k2KeyboardTrack(overlap);
    });
  }
  function begin() {
    let ok = false;
    act(() => {
      ok = beginKeyboardDrag();
    });
    return ok;
  }
  let reduce = false;
  let standInBottom: number | null = null;
  const handler = {
    keyboardMoved: vi.fn(),
    keyboardSample: vi.fn(),
    draggedBottom: vi.fn(() => standInBottom),
    detach: vi.fn(),
  };
  beforeEach(() => {
    seen = null;
    renders = 0;
    reduce = false;
    standInBottom = null;
    handler.keyboardMoved.mockClear();
    handler.keyboardSample.mockClear();
    handler.draggedBottom.mockClear();
    handler.detach.mockClear();
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("reduce") ? reduce : false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });

  /** Keyboard up and settled (WillShow, landed). */
  function keyboardShown() {
    will({ height: KEYBOARD, duration: 250, curve: 7, show: true });
    vv.height = FULL - KEYBOARD;
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(seen?.h).toBe(FULL - KEYBOARD);
    expect(seen?.motion).toBeNull();
  }

  it("no drag without a keyboard up", () => {
    render(<Column />);
    expect(keyboardTopNow()).toBeNull();
    expect(begin()).toBe(false);
    expect(seen?.interactive).toBe(false);
  });

  it("drag start: column full and pad = keyboard height, once; one render", () => {
    render(<Column />);
    keyboardShown();
    expect(keyboardTopNow()).toBe(FULL - KEYBOARD);
    const before = renders;
    expect(begin()).toBe(true);
    expect(seen?.interactive).toBe(true);
    expect(renders).toBe(before + 1);
    expect(el("col").style.height).toBe(`${FULL}px`);
    expect(el("col").style.transition).toBe("none");
    expect(el("pad").style.height).toBe(`${KEYBOARD}px`);
    // The published height holds (the terminal does not re-fit).
    expect(seen?.h).toBe(FULL - KEYBOARD);
    expect(begin()).toBe(true); // idempotent
    expect(renders).toBe(before + 1);
    // visualViewport noise mid-drag does not move anything.
    vv.height = FULL - 200;
    act(() => {
      vv.dispatchEvent(new Event("resize"));
    });
    flush();
    expect(seen?.h).toBe(FULL - KEYBOARD);
    expect(el("col").style.height).toBe(`${FULL}px`);
  });

  it("the shell's track is only a 'started moving' signal to the handler", () => {
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    signal(KEYBOARD - 30);
    expect(handler.keyboardMoved).toHaveBeenCalledWith(30);
    // Nothing moved by itself.
    expect(seen?.interactive).toBe(false);
    expect(el("col").style.height).toBe(`${FULL - KEYBOARD}px`);
    begin();
    signal(KEYBOARD - 60);
    expect(handler.keyboardMoved).toHaveBeenCalledTimes(1);
  });

  it("the shell's dismiss samples reach the handler (and nothing else moves)", () => {
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    act(() => {
      (window as unknown as { __k2KeyboardSample: (s: unknown) => void }).__k2KeyboardSample({
        top: 520.5,
        scrollY: 1234.25,
        t: 99,
      });
    });
    expect(handler.keyboardSample).toHaveBeenCalledWith({ top: 520.5, scrollY: 1234.25, t: 99 });
    act(() => {
      (window as unknown as { __k2KeyboardSample: (s: unknown) => void }).__k2KeyboardSample({
        top: 530,
        scrollY: null,
        t: 120,
      });
      // Malformed: ignored.
      (window as unknown as { __k2KeyboardSample: (s: unknown) => void }).__k2KeyboardSample({
        top: "x",
      });
    });
    expect(handler.keyboardSample).toHaveBeenCalledTimes(2);
    expect(handler.keyboardSample).toHaveBeenLastCalledWith({ top: 530, scrollY: null, t: 120 });
    expect(seen?.interactive).toBe(false);
    expect(el("col").style.height).toBe(`${FULL - KEYBOARD}px`);
  });

  it("release to close: the column goes final at once; the motion starts at the stand-in's bottom (FLIP)", () => {
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    begin();
    standInBottom = FULL - KEYBOARD + 150;
    const col = el("col");
    will({ height: 0, duration: 180, curve: 7, show: false });
    expect(handler.detach).toHaveBeenCalledTimes(1);
    expect(seen?.interactive).toBe(false);
    expect(seen?.h).toBe(FULL);
    expect(seen?.motion).toMatchObject({ ms: 180, from: FULL - KEYBOARD + 150, to: FULL });
    // Final layout, no height transition (no per-frame layout).
    expect(col.style.height).toBe(`${FULL}px`);
    expect(col.style.transition).toBe("");
    expect(el("pad").style.height).toBe("");
    vv.height = FULL;
    flush();
    expect(seen?.motion).toBeNull();
    expect(col.style.height).toBe(`${FULL}px`);
  });

  it("spring back: the column holds the dragged height while the keyboard rises", () => {
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    begin();
    standInBottom = FULL - KEYBOARD + 100;
    will({ height: KEYBOARD, duration: 200, curve: 7, show: true });
    expect(handler.detach).toHaveBeenCalled();
    expect(seen?.interactive).toBe(false);
    expect(seen?.h).toBe(FULL - KEYBOARD);
    expect(seen?.motion).toMatchObject({ ms: 200, from: FULL - KEYBOARD + 100, to: FULL - KEYBOARD });
    expect(el("col").style.height).toBe(`${FULL - KEYBOARD + 100}px`);
    expect(el("col").style.transition).toBe("");
  });

  it("spring back under reduced motion: final at once", () => {
    reduce = true;
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    begin();
    standInBottom = FULL - KEYBOARD + 100;
    will({ height: KEYBOARD, duration: 200, curve: 7, show: true });
    expect(seen?.motion).toBeNull();
    expect(el("col").style.height).toBe(`${FULL - KEYBOARD}px`);
  });

  it("no handler: the release starts from the signalled overlap", () => {
    render(<Column />);
    keyboardShown();
    begin();
    signal(KEYBOARD - 90);
    will({ height: 0, duration: 200, curve: 7, show: false });
    expect(seen?.motion).toMatchObject({ from: FULL - KEYBOARD + 90, to: FULL });
    expect(el("col").style.height).toBe(`${FULL}px`);
  });

  it("a drag sets the content's drag pad (no ease) on the column; the release drops it at once, the ease next frame", () => {
    render(<Column />);
    keyboardShown();
    begin();
    const col = el("col");
    expect(col.style.getPropertyValue("--mchat-drag-pad")).toBe(`${KEYBOARD}px`);
    expect(col.style.getPropertyValue("--mchat-content-ms")).toBe("0ms");
    will({ height: 0, duration: 200, curve: 7, show: false });
    expect(col.style.getPropertyValue("--mchat-drag-pad")).toBe("");
    expect(col.style.getPropertyValue("--mchat-content-ms")).toBe("0ms");
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(col.style.getPropertyValue("--mchat-content-ms")).toBe("");
  });

  it("endKeyboardDrag with no drag in the store still drops an orphaned stand-in", () => {
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    act(() => endKeyboardDrag());
    expect(handler.detach).toHaveBeenCalledTimes(1);
    expect(seen?.interactive).toBe(false);
  });

  it("endKeyboardDrag / a Did* resync hand everything back, unanimated", () => {
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    begin();
    act(() => endKeyboardDrag());
    expect(handler.detach).toHaveBeenCalledTimes(1);
    expect(seen?.interactive).toBe(false);
    expect(el("col").style.height).toBe(`${FULL - KEYBOARD}px`);
    expect(el("col").style.transition).toBe("");
    expect(el("pad").style.height).toBe("");
    begin();
    act(() => {
      window.dispatchEvent(new Event("k2-viewport-resync"));
    });
    expect(handler.detach).toHaveBeenCalledTimes(2);
    expect(seen?.interactive).toBe(false);
  });

  it("reduced motion: the release lands unanimated", () => {
    reduce = true;
    render(<Column />);
    keyboardShown();
    setKeyboardDragHandler(handler);
    begin();
    standInBottom = FULL - 50;
    will({ height: 0, duration: 250, curve: 7, show: false });
    expect(seen?.motion).toBeNull();
    expect(el("col").style.height).toBe(`${FULL}px`);
    expect(el("col").style.transition).toBe("");
  });

  it("a drag caught during a Will* hold: the old settle does not re-measure over it", () => {
    render(<Column />);
    will({ height: KEYBOARD, duration: 250, curve: 7, show: true });
    begin();
    vv.height = FULL;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(seen?.interactive).toBe(true);
    expect(el("col").style.height).toBe(`${FULL}px`);
  });
});
