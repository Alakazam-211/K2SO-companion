// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), addPluginListener: vi.fn(async () => ({ unregister() {} })) }));

import { useCallScreen } from "./callScreen";
import { MINI_CORNER_KEY, MiniVideoTile, nearestCorner, readCorner, useLayerPlacement } from "./videoLayer";
import { __setTileSenderForTests, HIDDEN, type TileFrame } from "./videoTile";
import { __resetVoiceCallForTests, useVoiceCall } from "./voiceCall";

const ROOM = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
const sent: TileFrame[] = [];
let frames: FrameRequestCallback[] = [];
/** The frames asked for so far, run (the layer is placed once a frame). */
function flush() {
  act(() => {
    while (frames.length) frames.shift()!(0);
  });
}
const last = () => {
  flush();
  return sent[sent.length - 1];
};
let box = { left: 243, top: 110, width: 120, height: 68 };
let rect: () => DOMRect;

beforeEach(() => {
  __resetVoiceCallForTests();
  sent.length = 0;
  __setTileSenderForTests((f) => void sent.push(f));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  box = { left: 243, top: 110, width: 120, height: 68 };
  rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const r = this.dataset.testid === "voice-mini-tile" ? box : { left: 20, top: 500, width: 320, height: 180 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} } as DOMRect;
  };
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 812, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __setTileSenderForTests(null);
  HTMLElement.prototype.getBoundingClientRect = rect;
});

const tile = () => screen.queryByTestId("voice-mini-tile");

describe("the mini video tile", () => {
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

  it("a tap opens the call; a drag snaps to the nearest corner and is remembered", () => {
    useVoiceCall.setState({ phase: "connected", room: ROOM, video: true });
    const onOpen = vi.fn();
    render(<MiniVideoTile callViewOpen={false} onOpen={onOpen} />);
    expect(tile()?.getAttribute("data-corner")).toBe("top-right");
    const el = tile()!;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 300, clientY: 140 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 303, clientY: 142 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 303, clientY: 142 });
    expect(onOpen).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(el, { pointerId: 2, clientX: 300, clientY: 140 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 80, clientY: 640 });
    // The layer follows the drag.
    expect(el.style.transform).toBe("translate(-220px, 500px)");
    box = { left: 23, top: 610, width: 120, height: 68 };
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 80, clientY: 641 });
    expect(last()).toMatchObject({ visible: true, x: 23, y: 610 });
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 80, clientY: 641 });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(tile()?.getAttribute("data-corner")).toBe("bottom-left");
    expect(el.style.transform).toBe("");
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe("bottom-left");
    cleanup();
    render(<MiniVideoTile callViewOpen={false} onOpen={onOpen} />);
    expect(tile()?.getAttribute("data-corner")).toBe("bottom-left");
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
    useVoiceCall.setState({ phase: "connected", room: ROOM, video: true });
    render(<MiniVideoTile callViewOpen={false} onOpen={() => {}} />);
    const el = tile()!;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 300, clientY: 140 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 60, clientY: 700 });
    box = { left: 3, top: 670, width: 120, height: 68 };
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 60, clientY: 700 });
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
