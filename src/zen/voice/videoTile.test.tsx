// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, addPluginListener: tauri.listen }));
const ios = vi.hoisted(() => ({ on: true }));
vi.mock("../../lib/nativePicker", () => ({ isIosWebView: () => ios.on }));

import {
  __resetPipForTests,
  __setTileSenderForTests,
  followPip,
  HIDDEN,
  onPipEvent,
  placeTile,
  sameFrame,
  tileFrame,
  togglePip,
  usePipStatus,
  useVideoTile,
  type TileFrame,
} from "./videoTile";

const VIEW = { width: 390, height: 844, offsetLeft: 0, offsetTop: 0, scale: 1 };

describe("the tile's frame", () => {
  it("is the rect inside the border, with the radius inside it too", () => {
    expect(tileFrame({ left: 24, top: 500, width: 342, height: 192.375 }, VIEW, 12, 1)).toEqual({
      visible: true,
      x: 25,
      y: 501,
      w: 340,
      h: 190.5,
      radius: 11,
    });
  });

  it("follows the visual viewport (keyboard pan, pinch)", () => {
    const f = tileFrame({ left: 20, top: 400, width: 160, height: 90 }, { ...VIEW, offsetTop: 100, scale: 2 }, 12);
    expect(f).toEqual({ visible: true, x: 40, y: 600, w: 320, h: 180, radius: 24 });
  });

  it("rounds the top corners only when asked (the floating card's picture), and Swift is told when that changes", () => {
    const r = { left: 212, top: 110, width: 152, height: 86 };
    expect(tileFrame(r, VIEW, 16, 1, "top")).toEqual({ visible: true, x: 213, y: 111, w: 150, h: 84, radius: 15, corners: "top" });
    expect(tileFrame(r, VIEW, 16, 1)).not.toHaveProperty("corners");
    expect(sameFrame(tileFrame(r, VIEW, 16, 1, "top"), tileFrame(r, VIEW, 16, 1))).toBe(false);
    expect(sameFrame(tileFrame(r, VIEW, 16, 1, "top"), tileFrame(r, VIEW, 16, 1, "top"))).toBe(true);
  });

  it("is hidden with no size or off screen", () => {
    expect(tileFrame({ left: 0, top: 0, width: 0, height: 90 }, VIEW, 12)).toEqual(HIDDEN);
    expect(tileFrame({ left: 0, top: 900, width: 160, height: 90 }, VIEW, 12)).toEqual(HIDDEN);
    expect(tileFrame({ left: 0, top: -90, width: 160, height: 90 }, VIEW, 12)).toEqual(HIDDEN);
    expect(tileFrame({ left: 400, top: 10, width: 160, height: 90 }, VIEW, 12)).toEqual(HIDDEN);
    // Partly on screen stays: the window clips it.
    expect(tileFrame({ left: 0, top: 800, width: 160, height: 90 }, VIEW, 12).visible).toBe(true);
  });
});

describe("sending it", () => {
  let sent: TileFrame[];
  beforeEach(() => {
    sent = [];
    __setTileSenderForTests((f) => void sent.push(f));
  });
  afterEach(() => __setTileSenderForTests(null));

  it("sends a frame only when it changed", () => {
    const f: TileFrame = { visible: true, x: 1, y: 2, w: 3, h: 4, radius: 5 };
    placeTile(f);
    placeTile({ ...f });
    placeTile(HIDDEN);
    placeTile(HIDDEN);
    placeTile({ ...f, y: 3 });
    expect(sent).toEqual([f, HIDDEN, { ...f, y: 3 }]);
  });

  it("goes to Swift as callOp pipFrame on iOS only", () => {
    __setTileSenderForTests(null);
    tauri.invoke.mockReset().mockResolvedValue({ ok: true });
    placeTile({ visible: true, x: 1, y: 2, w: 3, h: 4, radius: 5 });
    expect(tauri.invoke).toHaveBeenCalledWith("plugin:k2-push|call_op", {
      op: "pipFrame",
      visible: true,
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      radius: 5,
    });
    ios.on = false;
    try {
      placeTile(HIDDEN);
      expect(tauri.invoke).toHaveBeenCalledTimes(1);
    } finally {
      ios.on = true;
    }
  });
});

describe("PiP's status", () => {
  beforeEach(() => __resetPipForTests());

  it("a first frame shows until the image is cleared; PiP up and down", () => {
    onPipEvent({ event: "pip_first_frame" });
    expect(usePipStatus.getState()).toEqual({ frame: true, active: false });
    onPipEvent({ event: "pip_started" });
    expect(usePipStatus.getState().active).toBe(true);
    onPipEvent({ event: "pip_stopped" });
    onPipEvent({ event: "pip_cleared" });
    onPipEvent({ event: "pip_keyframe" });
    expect(usePipStatus.getState()).toEqual({ frame: false, active: false });
  });

  it("starts from K2PiP's state and follows its events once", async () => {
    tauri.invoke.mockReset().mockResolvedValue({ ok: true, frame: true, active: false });
    tauri.listen.mockReset().mockResolvedValue({ unregister: vi.fn() });
    followPip();
    followPip();
    expect(tauri.listen).toHaveBeenCalledTimes(1);
    expect(tauri.listen).toHaveBeenCalledWith("k2-push", "pip", onPipEvent);
    expect(tauri.invoke).toHaveBeenCalledWith("plugin:k2-push|call_op", { op: "pip" });
    await vi.waitFor(() => expect(usePipStatus.getState().frame).toBe(true));
  });

  it("the tap starts PiP, and stops it when it's up", () => {
    tauri.invoke.mockReset().mockResolvedValue({});
    togglePip();
    onPipEvent({ event: "pip_started" });
    togglePip();
    expect(tauri.invoke.mock.calls).toEqual([
      ["plugin:k2-push|call_op", { op: "pip", on: true }],
      ["plugin:k2-push|call_op", { op: "pip", on: false }],
    ]);
  });
});

describe("the tile hook", () => {
  let sent: TileFrame[];
  let frames: FrameRequestCallback[];
  let observers: { cb: () => void; els: Element[]; off: boolean }[];
  let rect = { left: 24, top: 500, width: 342, height: 192 };

  beforeEach(() => {
    sent = [];
    frames = [];
    observers = [];
    rect = { left: 24, top: 500, width: 342, height: 192 };
    __setTileSenderForTests((f) => void sent.push(f));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        o = { cb: () => {}, els: [] as Element[], off: false };
        constructor(cb: () => void) {
          this.o.cb = cb;
          observers.push(this.o);
        }
        observe(el: Element) {
          this.o.els.push(el);
        }
        disconnect() {
          this.o.off = true;
        }
      }
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    __setTileSenderForTests(null);
  });

  function runFrames() {
    const now = frames;
    frames = [];
    act(() => now.forEach((cb) => cb(0)));
  }

  function Tile({ show }: { show: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useVideoTile(ref, show, 12, 1);
    return (
      <div>
        <div
          ref={(el) => {
            ref.current = el;
            if (el) el.getBoundingClientRect = () => ({ ...rect }) as DOMRect;
          }}
        />
      </div>
    );
  }

  const at = (top: number): TileFrame => ({ visible: true, x: 25, y: top + 1, w: 340, h: 190, radius: 11 });

  it("places the layer on the tile, once a frame at most, and only on change", () => {
    render(<Tile show />);
    expect(sent).toEqual([]);
    runFrames();
    expect(sent).toEqual([at(500)]);
    // A burst of changes is one measure.
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    runFrames();
    expect(sent).toEqual([at(500)]);
    // Its element or its parent resized (the call bar grew): measured again.
    expect(observers[0].els).toHaveLength(2);
    rect = { ...rect, top: 300 };
    observers[0].cb();
    runFrames();
    expect(sent).toEqual([at(500), at(300)]);
  });

  it("hides when show goes false and on unmount", () => {
    const { rerender, unmount } = render(<Tile show />);
    runFrames();
    rerender(<Tile show={false} />);
    expect(sent).toEqual([at(500), HIDDEN]);
    rerender(<Tile show />);
    runFrames();
    unmount();
    expect(sent).toEqual([at(500), HIDDEN, at(500), HIDDEN]);
    expect(observers.every((o) => o.off)).toBe(true);
  });

  it("in the background keeps its place; back in front, measures again", () => {
    render(<Tile show />);
    runFrames();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    rect = { ...rect, top: 200 };
    document.dispatchEvent(new Event("visibilitychange"));
    runFrames();
    expect(sent).toEqual([at(500)]);
    vis.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    runFrames();
    expect(sent).toEqual([at(500), at(200)]);
    vis.mockRestore();
  });
});
