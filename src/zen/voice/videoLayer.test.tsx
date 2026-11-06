// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), addPluginListener: vi.fn(async () => ({ unregister() {} })) }));

import { useCallScreen } from "./callScreen";
import { EASE_DURATION, SNAP_SPRING } from "./miniSnap";
import { MINI_CORNER_KEY, MiniVideoTile, nearestCorner, readCorner, useLayerPlacement } from "./videoLayer";
import { __resetPipForTests, __setHapticForTests, __setTileSenderForTests, HIDDEN, onPipEvent, type TileFrame } from "./videoTile";
import { __resetVoiceCallForTests, useVoiceCall } from "./voiceCall";

const ROOM = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
const sent: TileFrame[] = [];
const haptics: string[] = [];
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** The page's clock (ms): each frame run moves it on 1/60 s. */
let clock = 0;
/** Run the frames asked for so far, `max` of them at most (the layer is
 *  placed once a frame; the snap asks for one a frame until it ends). */
function flush(max = 600) {
  act(() => {
    for (let i = 0; i < max && frames.size; i++) {
      const run = [...frames.values()];
      frames.clear();
      clock += 1000 / 60;
      for (const cb of run) cb(clock);
    }
  });
}
const last = () => {
  flush();
  return sent[sent.length - 1];
};
// The mini tile's spot in each corner on a 375×812 phone (what the CSS
// anchors give); its rect follows its corner and transform like a browser's.
const HOME: Record<string, { left: number; top: number }> = {
  "top-left": { left: 12, top: 110 },
  "top-right": { left: 243, top: 110 },
  "bottom-left": { left: 12, top: 660 },
  "bottom-right": { left: 243, top: 660 },
};
function miniRect(el: HTMLElement) {
  const home = HOME[el.dataset.corner ?? "top-right"];
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)(?: scale\(([\d.]+)\))?/.exec(el.style.transform);
  const [x, y, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 1];
  const w = 120 * s;
  const h = 68 * s;
  return { left: home.left + 60 + x - w / 2, top: home.top + 34 + y - h / 2, width: w, height: h };
}
let rect: () => DOMRect;
let reduce = false;

beforeEach(() => {
  __resetVoiceCallForTests();
  __resetPipForTests();
  // The layer plays a frame (each test that needs none says so).
  onPipEvent({ event: "pip_first_frame" });
  sent.length = 0;
  haptics.length = 0;
  __setTileSenderForTests((f) => void sent.push(f));
  __setHapticForTests((prepare) => void haptics.push(prepare ? "prepare" : "tap"));
  frames = new Map();
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  reduce = false;
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes("reduce"), media: q })) as never;
  rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const r = this.dataset.testid === "voice-mini-tile" ? miniRect(this) : { left: 20, top: 500, width: 320, height: 180 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} } as DOMRect;
  };
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 812, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setTileSenderForTests(null);
  __setHapticForTests(null);
  HTMLElement.prototype.getBoundingClientRect = rect;
});

const tile = () => screen.queryByTestId("voice-mini-tile");

/** A finger: down at the first point, through the rest (`[ms, x, y]`, the
 *  clock set to each), up at the last. */
function drag(el: HTMLElement, id: number, points: [number, number, number][], { up = true } = {}) {
  const [t0, x0, y0] = points[0];
  clock = t0;
  fireEvent.pointerDown(el, { pointerId: id, clientX: x0, clientY: y0 });
  for (const [t, x, y] of points.slice(1)) {
    clock = t;
    fireEvent.pointerMove(el, { pointerId: id, clientX: x, clientY: y });
  }
  if (!up) return;
  const [t, x, y] = points[points.length - 1];
  clock = t;
  fireEvent.pointerUp(el, { pointerId: id, clientX: x, clientY: y });
}

function shown(onOpen: () => void = () => {}) {
  useVoiceCall.setState({ phase: "connected", room: ROOM, video: true });
  render(<MiniVideoTile callViewOpen={false} onOpen={onOpen} />);
  flush();
  return tile()!;
}

describe("the mini video tile", () => {
  it("never shows empty: only once a frame plays, and not after a stall or a clear", () => {
    __resetPipForTests();
    act(() => useVoiceCall.setState({ phase: "connected", room: ROOM, video: true }));
    render(<MiniVideoTile callViewOpen={false} onOpen={() => {}} />);
    // Video, but no frame yet (your own camera alone, a stream on its way).
    expect(tile()).toBeNull();
    act(() => onPipEvent({ event: "pip_first_frame" }));
    expect(tile()).toBeTruthy();
    act(() => onPipEvent({ event: "pip_stalled" }));
    expect(tile()).toBeNull();
    act(() => onPipEvent({ event: "pip_first_frame" }));
    expect(tile()).toBeTruthy();
    act(() => onPipEvent({ event: "pip_cleared" }));
    expect(tile()).toBeNull();
    // In Picture in Picture it stays (the tap brings the call back).
    act(() => onPipEvent({ event: "pip_started" }));
    expect(tile()).toBeTruthy();
  });

  it("shows only while the call has video and its screen is closed", () => {
    const { rerender } = render(<MiniVideoTile callViewOpen={false} onOpen={() => {}} />);
    expect(tile()).toBeNull();
    act(() => useVoiceCall.setState({ phase: "connected", room: ROOM }));
    expect(tile()).toBeNull();
    act(() => useVoiceCall.setState({ video: true }));
    expect(tile()).toBeTruthy();
    // On screen, so iOS can start PiP from it.
    expect(last()).toEqual({ visible: true, x: 243, y: 110, w: 120, h: 68, radius: 10 });
    rerender(<MiniVideoTile callViewOpen onOpen={() => {}} />);
    expect(tile()).toBeNull();
    expect(last()).toEqual(HIDDEN);
    rerender(<MiniVideoTile callViewOpen={false} onOpen={() => {}} />);
    expect(tile()).toBeTruthy();
    act(() => useVoiceCall.setState({ video: false }));
    expect(tile()).toBeNull();
    act(() => useVoiceCall.setState({ video: true }));
    expect(tile()).toBeTruthy();
    act(() => useVoiceCall.setState({ phase: "idle", room: null }));
    expect(tile()).toBeNull();
    expect(last()).toEqual(HIDDEN);
  });

  it("a tap opens the call; a drag follows the finger, the layer with it, and the corner is remembered", () => {
    const onOpen = vi.fn();
    const el = shown(onOpen);
    expect(el.getAttribute("data-corner")).toBe("top-right");
    drag(el, 1, [[0, 300, 140], [16, 303, 142]]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(haptics).toEqual([]);

    // Slowly, down to the bottom left.
    drag(el, 2, [[1000, 300, 140], [1200, 80, 640]], { up: false });
    expect(el.style.transform).toBe("translate(-220px, 500px)");
    flush(1);
    // The same frame: the tile, a little bigger now it's held, and the layer on it.
    const held = miniRect(el);
    expect(el.style.transform).toMatch(/^translate\(-220px, 500px\) scale\(1\.0\d+\)$/);
    expect(sent[sent.length - 1]).toMatchObject({
      visible: true,
      x: Math.round(held.left * 2) / 2,
      w: Math.round(held.width * 2) / 2,
    });
    flush();
    clock = 1600;
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 80, clientY: 641 });
    flush(1);
    expect(el.style.transform).toBe("translate(-220px, 501px) scale(1.04)");
    expect(sent[sent.length - 1]).toMatchObject({ visible: true, x: 20.5, y: 609.5, w: 125, h: 70.5 });
    clock = 1900;
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 80, clientY: 641 });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(tile()?.getAttribute("data-corner")).toBe("bottom-left");
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe("bottom-left");
    // Swift gets the corner and the spring to get there by, once.
    const snap = sent[sent.length - 1];
    expect(snap).toEqual({
      visible: true,
      x: 12,
      y: 660,
      w: 120,
      h: 68,
      radius: 10,
      animate: { duration: expect.any(Number), ...SNAP_SPRING, velocityX: 0, velocityY: 0, startedAt: expect.any(Number) },
    });
    // Stamped with the wall clock at the release, for Swift to start in step.
    expect((snap as { animate: { startedAt: number } }).animate.startedAt).toBeCloseTo(performance.timeOrigin + 1900, 0);
    const count = sent.length;
    // Released just where it was drawn: no jump.
    expect(el.style.transform).toBe("translate(11px, -49px) scale(1.04)");
    flush();
    expect(el.style.transform).toBe("");
    // Nothing more for Swift: it ran the same spring itself.
    expect(sent.length).toBe(count);
    expect(haptics).toEqual(["prepare", "tap"]);
    cleanup();
    render(<MiniVideoTile callViewOpen={false} onOpen={onOpen} />);
    expect(tile()?.getAttribute("data-corner")).toBe("bottom-left");
  });

  it("a fling goes to the corner it's thrown at, a slow release to the nearest", () => {
    let el = shown();
    // A short, fast throw down and to the left from the top right.
    drag(el, 1, [[0, 300, 140], [16, 290, 160], [32, 270, 200], [48, 250, 240]]);
    expect(el.getAttribute("data-corner")).toBe("bottom-left");
    const thrown = sent[sent.length - 1] as { animate: { velocityX: number; velocityY: number } };
    expect(thrown.animate.velocityX).toBeCloseTo(-1041.7, 0);
    expect(thrown.animate.velocityY).toBeCloseTo(2083.3, 0);
    flush();
    cleanup();
    localStorage.clear();
    // The same move, slowly, with a pause before letting go.
    el = shown();
    drag(el, 1, [[0, 300, 140], [200, 290, 160], [400, 270, 200], [600, 250, 240], [900, 250, 240]]);
    expect(el.getAttribute("data-corner")).toBe("top-right");
    expect(sent[sent.length - 1]).toMatchObject({ x: 243, y: 110, animate: { velocityX: 0, velocityY: 0 } });
  });

  it("caught on its way, it stops under the finger, the layer too", () => {
    const el = shown();
    drag(el, 1, [[0, 300, 140], [16, 290, 160], [32, 270, 200], [48, 250, 240]]);
    flush(6);
    const mid = miniRect(el);
    const n = sent.length;
    clock += 5;
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 100, clientY: 400 });
    expect(sent.length).toBe(n + 1);
    expect(sent[n]).toEqual({ visible: true, x: Math.round(mid.left * 2) / 2, y: Math.round(mid.top * 2) / 2, w: Math.round(mid.width * 2) / 2, h: Math.round(mid.height * 2) / 2, radius: 10 });
    const t = el.style.transform;
    flush();
    expect(el.style.transform).toBe(t);
  });

  it("while Swift animates the layer, the page doesn't move it", () => {
    const el = shown();
    drag(el, 1, [[0, 300, 140], [200, 80, 640], [600, 80, 641]]);
    const n = sent.length;
    flush(3);
    fireEvent.scroll(document);
    flush(3);
    expect(sent.length).toBe(n);
    flush();
    expect(sent.length).toBe(n);
    // Afterwards it follows the page again.
    expect(el.style.transform).toBe("");
  });

  it("with Reduce Motion: no lift, and a short ease instead of the spring", () => {
    reduce = true;
    const el = shown();
    drag(el, 1, [[0, 300, 140], [200, 80, 640]], { up: false });
    flush();
    expect(el.style.transform).toBe("translate(-220px, 500px)");
    clock = 1000;
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 80, clientY: 640 });
    expect(sent[sent.length - 1]).toEqual({ visible: true, x: 12, y: 660, w: 120, h: 68, radius: 10, animate: { duration: EASE_DURATION, startedAt: expect.any(Number) } });
    flush();
    expect(el.style.transform).toBe("");
    expect(haptics).toEqual(["prepare", "tap"]);
  });

  it("snaps by where its centre was let go", () => {
    expect(nearestCorner(10, 10, 375, 812)).toBe("top-left");
    expect(nearestCorner(300, 100, 375, 812)).toBe("top-right");
    expect(nearestCorner(100, 700, 375, 812)).toBe("bottom-left");
    expect(nearestCorner(300, 700, 375, 812)).toBe("bottom-right");
  });

  it("a corner it can't read or save falls back, and never throws", () => {
    localStorage.setItem(MINI_CORNER_KEY, "middle");
    expect(readCorner()).toBe("top-right");
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readCorner()).toBe("top-right");
    const el = shown();
    drag(el, 1, [[0, 300, 140], [300, 60, 700]]);
    expect(tile()?.getAttribute("data-corner")).toBe("bottom-left");
    get.mockRestore();
    set.mockRestore();
  });

  it("the call screen's tile taking the layer first is never undone by the mini tile going", () => {
    function Hosted() {
      const place = useLayerPlacement(false);
      const ref = useRef<HTMLDivElement>(null);
      return <div ref={(el) => { ref.current = el; if (el) place(el.getBoundingClientRect()); }} />;
    }
    useVoiceCall.setState({ phase: "connected", room: ROOM, video: true });
    const { rerender } = render(<MiniVideoTile callViewOpen={false} onOpen={() => {}} />);
    expect(last()).toMatchObject({ x: 243, y: 110 });
    // Opening the call: its tile places the layer, then the mini tile goes.
    rerender(
      <>
        <MiniVideoTile callViewOpen={false} onOpen={() => {}} />
        <Hosted />
      </>
    );
    expect(last()).toMatchObject({ x: 20, y: 500 });
    rerender(<Hosted />);
    expect(last()).toMatchObject({ visible: true, x: 20, y: 500 });
  });
});

describe("asking for the call screen from anywhere", () => {
  it("is answered once", () => {
    useCallScreen.setState({ open: false, pending: false });
    useCallScreen.getState().ask();
    expect(useCallScreen.getState().consume()).toBe(true);
    expect(useCallScreen.getState().consume()).toBe(false);
  });
});
