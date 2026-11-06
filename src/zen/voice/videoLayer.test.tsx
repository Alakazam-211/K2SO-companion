// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), addPluginListener: vi.fn(async () => ({ unregister() {} })) }));

import { useCallScreen } from "./callScreen";
import { CallTile } from "./callTile";
import { __setTileCameraLoaderForTests } from "./tileCamera";
import { __resetCornerForTests, MINI_CORNER_KEY, nearestCorner, readCorner, useLayerPlacement } from "./videoLayer";
import { __resetPipForTests, __setHapticForTests, __setTileSenderForTests, onPipEvent, type TileFrame } from "./videoTile";
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
// The floating card's spot in each corner on a 375×812 phone (what the CSS
// anchors give: 12 from the sides, 110 from the top, 84 from the bottom);
// its rect follows its corner, size and transform like a browser's, its
// picture inside its 1 pt edge at the top.
function cardRect(el: HTMLElement) {
  const w0 = parseFloat(el.style.width) || 152;
  const h0 = parseFloat(el.style.height) || 56;
  const [v, side] = (el.dataset.corner ?? "top-right").split("-");
  const home = { left: side === "left" ? 12 : 375 - 12 - w0, top: v === "top" ? 110 : 728 - h0 };
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)(?: scale\(([\d.]+)\))?/.exec(el.style.transform);
  const [x, y, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 1];
  const w = w0 * s;
  const h = h0 * s;
  return { left: home.left + w0 / 2 + x - w / 2, top: home.top + h0 / 2 + y - h / 2, width: w, height: h };
}
function pictureRect(pic: HTMLElement) {
  const c = cardRect(pic.parentElement!);
  return { left: c.left + 1, top: c.top + 1, width: c.width - 2, height: parseFloat(pic.style.height) || 0 };
}
let rect: () => DOMRect;
let reduce = false;

beforeEach(() => {
  __resetVoiceCallForTests();
  __resetPipForTests();
  __resetCornerForTests();
  __setTileCameraLoaderForTests(async () => () => {});
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
    const id = this.dataset.testid;
    const r = id === "voice-call-tile" ? cardRect(this) : id === "voice-call-tile-picture" ? pictureRect(this) : { left: 20, top: 500, width: 320, height: 180 };
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
  __setTileCameraLoaderForTests(null);
  HTMLElement.prototype.getBoundingClientRect = rect;
});

const tile = () => screen.queryByTestId("voice-call-tile");

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
  render(<CallTile callViewOpen={false} onOpen={onOpen} />);
  flush();
  return tile()!;
}

describe("the floating tile's corner", () => {
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
    // Kept for the session: the tile comes back to the same corner.
    expect(readCorner()).toBe("bottom-left");
    get.mockRestore();
    set.mockRestore();
  });

  it("the call screen's tile taking the layer first is never undone by the floating card going", () => {
    function Hosted() {
      const place = useLayerPlacement(false);
      const ref = useRef<HTMLDivElement>(null);
      return <div ref={(el) => { ref.current = el; if (el) place(el.getBoundingClientRect()); }} />;
    }
    useVoiceCall.setState({ phase: "connected", room: ROOM, video: true });
    const { rerender } = render(<CallTile callViewOpen={false} onOpen={() => {}} />);
    expect(last()).toMatchObject({ visible: true, corners: "top" });
    // Opening the call: its tile places the layer, then the card goes.
    rerender(
      <>
        <CallTile callViewOpen={false} onOpen={() => {}} />
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
