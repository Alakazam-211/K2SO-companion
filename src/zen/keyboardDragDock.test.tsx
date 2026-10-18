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
  RELEASE_GRACE_MS,
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
  const { height } = useViewport();
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
    <div data-testid="col" ref={col} style={{ height }}>
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

  it("release (WillHide): the real composer lands where the stand-in was, then eases", () => {
    mount();
    touch("touchstart", 300);
    touch("touchmove", TOP - DOCK_H - 1);
    touch("touchmove", TOP - DOCK_H + 1);
    const s = standIn()!;
    // Native scrolling carried it 120px down with the finger.
    s.getBoundingClientRect = () => rect(TOP - DOCK_H + 120, DOCK_H);
    const col = el("col");
    const at: string[] = [];
    Object.defineProperty(col, "offsetHeight", {
      configurable: true,
      get() {
        at.push(`${col.style.height}|${el("dock").style.opacity}|${standIn() ? "standin" : "-"}`);
        return 0;
      },
    });
    touch("touchend", TOP + 120);
    will({ height: 0, duration: 200, curve: 7, show: false });
    expect(at).toEqual([`${TOP + 120}px||-`]);
    expect(col.style.height).toBe(`${FULL}px`);
    expect(col.style.transition).toMatch(/^height 200ms /);
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
