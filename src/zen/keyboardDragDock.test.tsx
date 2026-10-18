// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef, useEffect } from "react";
import {
  __resetViewportForTests,
  useViewport,
  useViewportPadRef,
  useViewportTrackRef,
  type KeyboardWill,
} from "../lib/useViewportHeight";
import {
  CORRECTION_EASE,
  CORRECTION_MAX_MS,
  CORRECTION_MIN_MS,
  MAX_CORRECTION_PX,
  RELEASE_GRACE_MS,
  correctionMs,
  sampleDiff,
  RETURN_SLOP_PX,
  TOP_ROOM_MARGIN,
  buildStandIn,
  crossLine,
  installKeyboardDragDock,
  shouldAttach,
  shouldReturn,
  standInBox,
  topRoomFor,
} from "./keyboardDragDock";

describe("keyboardDragDock math", () => {
  it("crossLine: the keyboard's top, minus the dismiss padding", () => {
    expect(crossLine(500, 0)).toBe(500);
    expect(crossLine(500, 64)).toBe(436);
    expect(crossLine(500, -5)).toBe(500);
    expect(crossLine(500, Number.NaN)).toBe(500);
  });

  it("standInBox: the dock's viewport rect, in the drag layer's coordinates", () => {
    // Layer scrolled up 900px past the viewport top; dock at 436..500.
    const dock = { left: 0, top: 436, width: 390, height: 64 };
    const layer = { left: 0, top: -900, width: 390, height: 0 };
    expect(standInBox(dock, layer)).toEqual({ left: 0, top: 1336, width: 390, height: 64 });
    // Fallback trigger: the keyboard had already gone 12px.
    expect(standInBox(dock, layer, 12).top).toBe(1348);
  });

  it("topRoomFor: keyboard height + margin of scroll range above", () => {
    expect(topRoomFor(0, 0)).toBe(0);
    expect(topRoomFor(336, 0)).toBe(336 + TOP_ROOM_MARGIN);
    expect(topRoomFor(336, 100)).toBe(336 + TOP_ROOM_MARGIN - 100);
    // Long chat at the bottom: already plenty.
    expect(topRoomFor(336, 5000)).toBe(0);
  });

  it("switch: crossing the line downward attaches; back above (slop) returns", () => {
    expect(shouldAttach(440, 430, 436)).toBe(true);
    expect(shouldAttach(436, 430, 436)).toBe(true);
    expect(shouldAttach(430, 420, 436)).toBe(false); // above
    expect(shouldAttach(440, 445, 436)).toBe(false); // moving up
    expect(shouldAttach(440, null, 436)).toBe(false);
    expect(shouldAttach(440, 430, null)).toBe(false); // no keyboard
    expect(shouldReturn(436 - RETURN_SLOP_PX - 1, 436)).toBe(true);
    expect(shouldReturn(436 - RETURN_SLOP_PX + 1, 436)).toBe(false);
    expect(shouldReturn(0, null)).toBe(false);
  });

  it("sampleDiff: where the keyboard is minus where the stand-in was, in the sample's frame", () => {
    // Stand-in's bottom at content y 1400 (viewport y at scrollTop 0).
    // Native frame: scrolled 890 → stand-in bottom at 510; keyboard top
    // 516 → it must go 6px down.
    expect(sampleDiff(1400, { top: 516, scrollY: 890, t: 0 })).toBe(6);
    // Ahead of the keyboard: negative, it eases back up.
    expect(sampleDiff(1400, { top: 505, scrollY: 890, t: 0 })).toBe(-5);
    // Independent of what the page thinks the scroll is: only the
    // sample's own scrollY enters.
    expect(sampleDiff(1400, { top: 526, scrollY: 880, t: 0 })).toBe(6);
    expect(sampleDiff(1400, { top: 516, scrollY: null, t: 0 })).toBeNull();
    expect(sampleDiff(1400, { top: 510 + MAX_CORRECTION_PX + 1, scrollY: 890, t: 0 })).toBeNull();
  });

  it("correctionMs: scales with the move, clamped 80–220ms", () => {
    expect(correctionMs(0)).toBe(CORRECTION_MIN_MS);
    expect(correctionMs(6)).toBe(122);
    expect(correctionMs(-6)).toBe(122);
    expect(correctionMs(18)).toBe(206);
    expect(correctionMs(400)).toBe(CORRECTION_MAX_MS);
    expect(correctionMs(Number.NaN)).toBe(CORRECTION_MIN_MS);
  });

  it("buildStandIn: same look, inert, no ids / test ids, field values copied", () => {
    const dock = document.createElement("div");
    dock.setAttribute("data-testid", "thread-composer-dock");
    dock.style.opacity = "0";
    dock.innerHTML =
      '<div data-testid="composer-bar" id="x"><textarea data-testid="composer-input"></textarea></div>';
    dock.querySelector("textarea")!.value = "half a thought";
    const c = buildStandIn(dock);
    expect(c.getAttribute("data-testid")).toBe("thread-composer-standin");
    expect(c.querySelector("[data-testid]")).toBeNull();
    expect(c.querySelector("[id]")).toBeNull();
    expect(c.hasAttribute("inert")).toBe(true);
    expect(c.getAttribute("aria-hidden")).toBe("true");
    expect(c.style.position).toBe("absolute");
    expect(c.style.opacity).toBe("");
    expect(c.style.pointerEvents).toBe("none");
    expect(c.querySelector("textarea")!.value).toBe("half a thought");
  });
});

// ── The switch, wired to the store ─────────────────────────────────

class FakeVisualViewport extends EventTarget {
  height = 0;
  offsetTop = 0;
}
const FULL = 844;
const KEYBOARD = 336;
const TOP = FULL - KEYBOARD; // keyboard top while up
const DOCK_H = 64;
let vv: FakeVisualViewport;
/** Scroll offset of the content (drag layer top = -scroll). */
let scroll = 900;

function rect(top: number, height: number, left = 0, width = 390): DOMRect {
  return { top, height, left, width, bottom: top + height, right: left + width, x: left, y: top, toJSON() {} } as DOMRect;
}

function Thread() {
  const { height, motion } = useViewport();
  const col = useViewportTrackRef();
  const pad = useViewportPadRef();
  const scroller = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      installKeyboardDragDock({
        scroller: () => scroller.current,
        dock: () => dock.current,
        layer: () => layer.current,
        padding: () => DOCK_H,
      }),
    []
  );
  return (
    <div data-testid="col" ref={col} style={{ height }} data-from={motion?.from ?? ""}>
      <div data-testid="scroller" ref={scroller}>
        <div data-testid="layer" ref={layer} />
        <div data-testid="pad" ref={pad} />
      </div>
      <div data-testid="dock" ref={dock}>
        <textarea data-testid="input" defaultValue="" />
      </div>
    </div>
  );
}
const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const standIn = () => el("layer").querySelector<HTMLElement>('[data-testid="thread-composer-standin"]');

function will(d: KeyboardWill) {
  act(() => {
    (window as unknown as { __k2KeyboardWill: (d: KeyboardWill) => void }).__k2KeyboardWill(d);
  });
}
function touch(type: string, y: number) {
  const e = new Event(type, { bubbles: true }) as TouchEvent;
  Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] });
  Object.defineProperty(e, "changedTouches", { value: [{ clientY: y }] });
  act(() => {
    el("scroller").dispatchEvent(e);
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: FULL });
  vv = new FakeVisualViewport();
  vv.height = FULL;
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  __resetViewportForTests();
  scroll = 900;
  (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup = true;
});

afterEach(() => {
  delete (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup;
  cleanup();
  __resetViewportForTests();
  vi.useRealTimers();
});

function mount() {
  render(<Thread />);
  // Geometry: the dock sits at the column bottom; the layer scrolls.
  const dock = el("dock");
  dock.getBoundingClientRect = () => rect(parseFloat(el("col").style.height) - DOCK_H, DOCK_H);
  el("layer").getBoundingClientRect = () => rect(-scroll, 0);
  // Keyboard up and settled.
  will({ height: KEYBOARD, duration: 250, curve: 7, show: true });
  vv.height = TOP;
  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(el("col").style.height).toBe(`${TOP}px`);
}

describe("installKeyboardDragDock", () => {
  it("a drag crossing the composer's top switches the composer into the content", () => {
    mount();
    const line = TOP - DOCK_H;
    touch("touchstart", 300);
    touch("touchmove", line - 10);
    expect(standIn()).toBeNull();
    touch("touchmove", line + 2);
    const s = standIn()!;
    expect(s).not.toBeNull();
    // Exactly over the dock: viewport top TOP-DOCK_H, layer at -scroll.
    expect(s.style.top).toBe(`${TOP - DOCK_H + scroll}px`);
    expect(s.style.height).toBe(`${DOCK_H}px`);
    expect(el("dock").style.opacity).toBe("0");
    // The column went full (the stand-in is not clipped), the pad holds
    // the scroll range.
    expect(el("col").style.height).toBe(`${FULL}px`);
    expect(el("pad").style.height).toBe(`${KEYBOARD}px`);
    // The real field keeps its value and focusability.
    expect(el("input").hasAttribute("inert")).toBe(false);
  });

  it("the finger back above the line (keyboard fully up): handed back", () => {
    mount();
    const line = TOP - DOCK_H;
    touch("touchstart", 300);
    touch("touchmove", line - 1);
    touch("touchmove", line + 20);
    expect(standIn()).not.toBeNull();
    touch("touchmove", line - RETURN_SLOP_PX - 2);
    expect(standIn()).toBeNull();
    expect(el("dock").style.opacity).toBe("");
    expect(el("col").style.height).toBe(`${TOP}px`);
    expect(el("pad").style.height).toBe("");
    // And again on the next crossing.
    touch("touchmove", line + 5);
    expect(standIn()).not.toBeNull();
  });

  it("release (WillHide): the composer's motion starts where the stand-in was; the column is final at once", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 1);
    const s = standIn()!;
    // Native scrolling carried it 120px down with the finger.
    s.getBoundingClientRect = () => rect(TOP - DOCK_H + 120, DOCK_H);
    const col = el("col");
    touch("touchend", TOP + 120);
    will({ height: 0, duration: 200, curve: 7, show: false });
    expect(standIn()).toBeNull();
    expect(el("dock").style.opacity).toBe("");
    expect(col.dataset.from).toBe(`${TOP + 120}`);
    expect(col.style.height).toBe(`${FULL}px`);
    expect(col.style.transition).toBe("");
    // The grace timer finds nothing to do (the keyboard landed).
    vv.height = FULL;
    act(() => {
      vi.advanceTimersByTime(RELEASE_GRACE_MS + 10);
    });
    expect(col.style.height).toBe(`${FULL}px`);
  });

  it("let go with no Will*: handed back after the grace", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 3);
    touch("touchend", TOP - DOCK_H + 3);
    expect(standIn()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(RELEASE_GRACE_MS + 1);
    });
    expect(standIn()).toBeNull();
    expect(el("dock").style.opacity).toBe("");
    expect(el("col").style.height).toBe(`${TOP}px`);
  });

  it("no touch events (WebKit cancelled them): the shell's signal attaches, lower by the distance gone", () => {
    mount();
    act(() => {
      (window as unknown as { __k2KeyboardTrack: (h: number) => void }).__k2KeyboardTrack(KEYBOARD - 14);
    });
    const s = standIn()!;
    expect(s).not.toBeNull();
    expect(s.style.top).toBe(`${TOP - DOCK_H + scroll + 14}px`);
  });

  function sample(top: number, scrollY: number | null, t: number) {
    act(() => {
      (window as unknown as { __k2KeyboardSample: (s: unknown) => void }).__k2KeyboardSample({
        top,
        scrollY,
        t,
      });
    });
  }

  it("the first sample after the attach eases the stand-in onto the keyboard; a confirmation ~100ms later only if it disagrees", () => {
    mount();
    const line = TOP - DOCK_H;
    touch("touchstart", 300);
    touch("touchmove", line - 1);
    touch("touchmove", line + 2);
    const s = standIn()!;
    // Content-space bottom: layer top (-scroll) + scrollTop + top + height.
    const scroller = el("scroller");
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: scroll });
    const base = -scroll + scroll + parseFloat(s.style.top) + DOCK_H; // = TOP + scroll
    expect(base).toBe(TOP + scroll);
    // Native frame: scrolled 890 (10px less) → stand-in bottom at TOP+10;
    // keyboard top at TOP+16 → 6px behind: eases down, 122ms ease-out.
    sample(TOP + 16, scroll - 10, 1000);
    expect(s.style.transform).toBe("translate3d(0, 6px, 0)");
    expect(s.style.transition).toBe(`transform 122ms ${CORRECTION_EASE}`);
    // Early samples after it: nothing (no per-frame follow).
    sample(TOP + 30, scroll - 25, 1016);
    sample(TOP + 50, scroll - 45, 1033);
    expect(s.style.transform).toBe("translate3d(0, 6px, 0)");
    // Confirmation within tolerance (7 vs 6): nothing.
    sample(TOP + 87, scroll - 80, 1100);
    expect(s.style.transform).toBe("translate3d(0, 6px, 0)");
    // Done: later samples are ignored.
    sample(TOP + 200, scroll - 150, 1300);
    expect(s.style.transform).toBe("translate3d(0, 6px, 0)");
  });

  it("a confirmation that disagrees by more than 2px eases a second correction (either sign)", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 2);
    const s = standIn()!;
    Object.defineProperty(el("scroller"), "scrollTop", { configurable: true, value: scroll });
    sample(TOP + 10 + 4, scroll - 10, 0); // +4
    expect(s.style.transform).toBe("translate3d(0, 4px, 0)");
    sample(TOP + 80 - 3, scroll - 80, 100); // -3: 7px off → back up
    expect(s.style.transform).toBe("translate3d(0, -3px, 0)");
    expect(s.style.transition).toBe(`transform ${correctionMs(-7)}ms ${CORRECTION_EASE}`);
  });

  it("reduced motion: the correction lands without easing", () => {
    window.matchMedia = vi.fn((q: string) => ({
      matches: q.includes("reduce"),
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 2);
    Object.defineProperty(el("scroller"), "scrollTop", { configurable: true, value: scroll });
    sample(TOP + 15, scroll - 10, 0);
    expect(standIn()!.style.transform).toBe("translate3d(0, 5px, 0)");
    expect(standIn()!.style.transition).toBe("none");
  });

  it("release: starts where the stand-in is drawn (at the Will's native scroll), not iOS's begin frame", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 2);
    const s = standIn()!;
    Object.defineProperty(el("scroller"), "scrollTop", { configurable: true, value: scroll });
    sample(TOP + 16, scroll - 10, 0); // correction: +6
    // Content-space bottom = TOP + scroll; at the Will the list is at
    // scroll − 130 natively → drawn at TOP + 130 + 6. iOS reports the
    // keyboard-UP frame as the begin frame (TestFlight 1320): ignored.
    will({ height: 0, duration: 200, curve: 7, show: false, fromTop: TOP, scrollY: scroll - 130 });
    expect(el("col").dataset.from).toBe(`${TOP + 136}`);
    expect(standIn()).toBeNull();
    expect(s.isConnected).toBe(false);
  });

  it("release: the real composer is translated onto the stand-in BEFORE it is shown (no frame at its layout spot)", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 2);
    Object.defineProperty(el("scroller"), "scrollTop", { configurable: true, value: scroll });
    const dock = el("dock");
    const seenAtShow: string[] = [];
    const style = dock.style;
    const proto = Object.getPrototypeOf(style);
    const desc = Object.getOwnPropertyDescriptor(proto, "opacity")!;
    Object.defineProperty(style, "opacity", {
      configurable: true,
      get: () => desc.get!.call(style),
      set: (v: string) => {
        if (v === "") seenAtShow.push(style.transform);
        desc.set!.call(style, v);
      },
    });
    will({ height: 0, duration: 200, curve: 7, show: false, scrollY: scroll - 100 });
    // Layout bottom FULL (column final); drawn at TOP + 100.
    expect(seenAtShow).toEqual([`translate3d(0, ${TOP + 100 - FULL}px, 0)`]);
  });

  it("samples before the attach are not used; a sample with no stand-in attaches (fallback)", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    Object.defineProperty(el("scroller"), "scrollTop", { configurable: true, value: scroll });
    // The keyboard started a hair before the crossing was seen.
    sample(TOP + 3, scroll - 3, 0);
    const s = standIn()!;
    expect(s).not.toBeNull();
    expect(s.style.top).toBe(`${TOP - DOCK_H + scroll}px`);
    // Its own diff: stand-in bottom at TOP+3 in that frame, keyboard TOP+3.
    expect(s.style.transform).toBe("");
  });

  it("not the iOS shell (Android / browser): never switches", () => {
    mount();
    delete (window as unknown as { __k2KeyboardSetup?: boolean }).__k2KeyboardSetup;
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP);
    expect(standIn()).toBeNull();
    act(() => {
      (window as unknown as { __k2KeyboardTrack: (h: number) => void }).__k2KeyboardTrack(KEYBOARD - 14);
    });
    sample(TOP + 10, 890, 0);
    expect(standIn()).toBeNull();
  });

  it("no keyboard up: touches never switch", () => {
    render(<Thread />);
    touch("touchstart", 300);
    touch("touchmove", 700);
    touch("touchmove", 800);
    expect(standIn()).toBeNull();
  });
});

describe("orphaned stand-in (TestFlight 1446 hardening)", () => {
  it("a focus or a keyboard show with no drag in the store drops it; mid-drag it stays", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 2);
    expect(standIn()).not.toBeNull();
    // Mid-drag (interactive): a focus does not drop it.
    act(() => {
      el("dock").querySelector("textarea")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(standIn()).not.toBeNull();
    // The store loses the drag without a hand-off (an orphan): next focus drops it.
    act(() => {
      __resetViewportForTests();
    });
    act(() => {
      el("dock").querySelector("textarea")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(standIn()).toBeNull();
    expect(el("dock").style.opacity).toBe("");
    expect(el("dock").style.pointerEvents).toBe("");
  });
});
