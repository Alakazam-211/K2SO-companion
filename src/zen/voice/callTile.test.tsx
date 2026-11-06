// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), addPluginListener: vi.fn(async () => ({ unregister() {} })) }));

import { CALL_TILE_H, CALL_TILE_W, CallTile } from "./callTile";
import { __resetCornerForTests, MINI_CORNER_KEY, MiniVideoTile } from "./videoLayer";
import { __resetPipForTests, __setHapticForTests, __setTileSenderForTests, onPipEvent, type TileFrame } from "./videoTile";
import {
  __resetVoiceCallForTests,
  __setCallShimForTests,
  setPhoneVoiceEngine,
  useVoiceCall,
  type EngineEvents,
  type PhoneVoiceEngine,
} from "./voiceCall";
import { callShim } from "./callShim";

const ROOM = { serverId: "s1", serverLabel: "sewlab", roomId: "room-1", roomName: "Standup", limit: 25 };
const sent: TileFrame[] = [];
const haptics: string[] = [];
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let clock = 0;
let reduce = false;
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

// Each floating tile's spot in each corner on a 375×812 phone (what the CSS
// anchors give: 12 from the sides, 110 from the top, 84 + 0 from the bottom):
// the tiles share the outer corner, so the wider call tile sits further in.
const SIZE: Record<string, [number, number]> = {
  "voice-mini-tile": [120, 68],
  "voice-call-tile": [CALL_TILE_W, CALL_TILE_H],
};
function home(corner: string, w: number, h: number) {
  const [v, side] = corner.split("-");
  return { left: side === "left" ? 12 : 375 - 12 - w, top: v === "top" ? 110 : 728 - h };
}
function floatRect(el: HTMLElement) {
  const [w0, h0] = SIZE[el.dataset.testid!];
  const at = home(el.dataset.corner ?? "top-right", w0, h0);
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)(?: scale\(([\d.]+)\))?/.exec(el.style.transform);
  const [x, y, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 1];
  const w = w0 * s;
  const h = h0 * s;
  return { left: at.left + w0 / 2 + x - w / 2, top: at.top + h0 / 2 + y - h / 2, width: w, height: h };
}
let rect: () => DOMRect;
const last = <T,>(a: T[]): T => a[a.length - 1];

/** A native engine that records what the tile asked of it. */
function fakeEngine() {
  let events: EngineEvents | null = null;
  const asked: string[] = [];
  const engine: PhoneVoiceEngine = {
    available: true,
    drivesSystemCall: true,
    join: vi.fn(async (_s, _r, e: EngineEvents) => {
      events = e;
    }),
    leave: vi.fn(async () => void asked.push("leave")),
    setMuted: (m) => void asked.push(`mute:${m}`),
    setDeafened: (d, m) => void asked.push(m === undefined ? `deafen:${d}` : `deafen:${d}:mute:${m}`),
    system: () => {},
  };
  return { engine, asked, events: () => events };
}

beforeEach(() => {
  __resetVoiceCallForTests();
  __resetPipForTests();
  __resetCornerForTests();
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
    const r = this.dataset.testid && SIZE[this.dataset.testid] ? floatRect(this) : { left: 20, top: 500, width: 320, height: 180 };
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
  __setCallShimForTests(callShim());
  HTMLElement.prototype.getBoundingClientRect = rect;
});

const callTile = () => screen.queryByTestId("voice-call-tile");
const videoTile = () => screen.queryByTestId("voice-mini-tile");
const btn = (name: "mute" | "deafen" | "leave") => screen.getByTestId(`voice-call-tile-${name}`);

/** Both floating tiles, as App mounts them. */
function Floats({ open = false, onOpen = () => {} }: { open?: boolean; onOpen?: () => void }) {
  return (
    <>
      <MiniVideoTile callViewOpen={open} onOpen={onOpen} />
      <CallTile callViewOpen={open} onOpen={onOpen} />
    </>
  );
}

/** A call joined through a fake native engine, connected. */
async function inCall() {
  const e = fakeEngine();
  setPhoneVoiceEngine(e.engine);
  __setCallShimForTests({ ...callShim(), microphone: async () => "granted" as const, label: () => {} });
  await act(() => useVoiceCall.getState().join(ROOM));
  act(() => e.events()?.onState("connected"));
  return e;
}

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

/** A tap on `el` as WebKit sends it: the pointer, then the click. */
function tap(el: HTMLElement, x = 250, y = 130) {
  fireEvent.pointerDown(el, { pointerId: 9, clientX: x, clientY: y });
  fireEvent.pointerUp(el, { pointerId: 9, clientX: x, clientY: y });
  fireEvent.click(el);
}

describe("the call tile", () => {
  it("shows while a call is up with no live picture and the call area closed", async () => {
    const { rerender } = render(<Floats />);
    expect(callTile()).toBeNull();
    await inCall();
    expect(callTile()).toBeTruthy();
    expect(videoTile()).toBeNull();
    expect(callTile()?.getAttribute("aria-label")).toBe("Call in Standup. Tap the tile to open the call.");
    // The same size class as the video tile: three 40 pt buttons.
    expect([CALL_TILE_W, CALL_TILE_H]).toEqual([152, 56]);
    rerender(<Floats open />);
    expect(callTile()).toBeNull();
    rerender(<Floats />);
    expect(callTile()).toBeTruthy();
    await act(() => useVoiceCall.getState().leave());
    expect(callTile()).toBeNull();
    // Page-only: it never places the native layer.
    expect(sent.filter((f) => f.visible)).toEqual([]);
  });

  it("becomes the video tile while a picture plays, and back when it stops", async () => {
    render(<Floats />);
    const e = await inCall();
    expect(callTile()).toBeTruthy();
    // Video, but no frame yet: still the call tile, never an empty video tile.
    act(() => e.events()?.onVideo?.(true));
    expect(callTile()).toBeTruthy();
    expect(videoTile()).toBeNull();
    act(() => onPipEvent({ event: "pip_first_frame" }));
    expect(callTile()).toBeNull();
    expect(videoTile()).toBeTruthy();
    act(() => onPipEvent({ event: "pip_stalled" }));
    expect(videoTile()).toBeNull();
    expect(callTile()).toBeTruthy();
    act(() => onPipEvent({ event: "pip_first_frame" }));
    expect(videoTile()).toBeTruthy();
    act(() => e.events()?.onVideo?.(false));
    expect(videoTile()).toBeNull();
    expect(callTile()).toBeTruthy();
  });

  it("Mute, Deafen and Hang up are the call's own actions, and show the engine's state", async () => {
    render(<Floats />);
    const e = await inCall();
    expect(btn("mute").getAttribute("aria-pressed")).toBe("false");
    expect(btn("mute").getAttribute("aria-label")).toBe("Mute");
    tap(btn("mute"));
    expect(e.asked).toEqual(["mute:true"]);
    expect(btn("mute").getAttribute("aria-pressed")).toBe("true");
    expect(btn("mute").getAttribute("aria-label")).toBe("Unmute");
    tap(btn("mute"));
    expect(e.asked).toEqual(["mute:true", "mute:false"]);

    tap(btn("deafen"));
    expect(last(e.asked)).toBe("deafen:true");
    expect(btn("deafen").getAttribute("aria-pressed")).toBe("true");
    expect(btn("deafen").getAttribute("aria-label")).toBe("Undeafen");
    // A deafen mutes too.
    expect(btn("mute").getAttribute("aria-pressed")).toBe("true");
    // The mic back on brings the sound back (the call bar's rule), one step.
    tap(btn("mute"));
    expect(last(e.asked)).toBe("deafen:false:mute:false");
    expect(btn("deafen").getAttribute("aria-pressed")).toBe("false");
    expect(btn("mute").getAttribute("aria-pressed")).toBe("false");

    // The engine's word wins (the system's button, another device).
    act(() => e.events()?.onSelfMute?.(true, { deafened: true, muteLocked: false, deafLocked: false }));
    expect(btn("deafen").getAttribute("aria-pressed")).toBe("true");
    tap(btn("deafen"));
    expect(last(e.asked)).toBe("deafen:false");

    tap(btn("leave"));
    await act(async () => {});
    expect(last(e.asked)).toBe("leave");
    expect(useVoiceCall.getState().phase).toBe("idle");
    expect(callTile()).toBeNull();
  });

  it("a moderator's mute: the mic shows locked and does nothing", async () => {
    render(<Floats />);
    const e = await inCall();
    act(() => e.events()?.onSelfMute?.(false, { deafened: false, muteLocked: true, deafLocked: false }));
    const mute = btn("mute");
    expect(mute.getAttribute("aria-disabled")).toBe("true");
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    expect(mute.getAttribute("aria-label")).toBe("Muted by a moderator");
    expect(mute.getAttribute("data-locked")).toBe("yes");
    tap(mute);
    expect(e.asked).toEqual([]);
    // Deafen still works; a moderator's deafen locks it the same way.
    tap(btn("deafen"));
    expect(e.asked).toEqual(["deafen:true"]);
    act(() => e.events()?.onSelfMute?.(true, { deafened: false, muteLocked: true, deafLocked: true }));
    expect(btn("deafen").getAttribute("aria-label")).toBe("Deafened by a moderator");
    expect(btn("deafen").getAttribute("aria-pressed")).toBe("true");
    tap(btn("deafen"));
    expect(e.asked).toEqual(["deafen:true"]);
    // Lifted: the mic is yours again.
    act(() => e.events()?.onSelfMute?.(false, { deafened: false, muteLocked: false, deafLocked: false }));
    expect(btn("mute").getAttribute("aria-disabled")).toBeNull();
    expect(btn("mute").getAttribute("aria-pressed")).toBe("false");
  });

  it("a tap on a button is the button's; a tap on the tile opens the call; a drag is neither", async () => {
    const onOpen = vi.fn();
    render(<Floats onOpen={onOpen} />);
    const e = await inCall();
    tap(btn("mute"));
    expect(e.asked).toEqual(["mute:true"]);
    expect(onOpen).not.toHaveBeenCalled();
    // The tile's edge, not a button: the call area.
    tap(callTile()!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(e.asked).toEqual(["mute:true"]);
    // A small wobble is still a tap.
    fireEvent.pointerDown(btn("deafen"), { pointerId: 2, clientX: 250, clientY: 130 });
    fireEvent.pointerMove(btn("deafen"), { pointerId: 2, clientX: 254, clientY: 133 });
    fireEvent.pointerUp(btn("deafen"), { pointerId: 2, clientX: 254, clientY: 133 });
    fireEvent.click(btn("deafen"));
    expect(e.asked).toEqual(["mute:true", "deafen:true"]);
    // A drag that starts on a button moves the tile, and its click is no tap.
    const el = callTile()!;
    drag(btn("leave"), 3, [[1000, 340, 130], [1200, 100, 640]], { up: false });
    expect(el.style.transform).toBe("translate(-240px, 510px)");
    flush();
    clock = 1600;
    fireEvent.pointerUp(btn("leave"), { pointerId: 3, clientX: 100, clientY: 640 });
    fireEvent.click(btn("leave"));
    expect(e.asked).toEqual(["mute:true", "deafen:true"]);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(useVoiceCall.getState().phase).toBe("connected");
    expect(callTile()?.getAttribute("data-corner")).toBe("bottom-left");
    // The same snap as the video tile: lift, spring home, a light tap as it lands.
    flush();
    expect(el.style.transform).toBe("");
    expect(haptics).toEqual(["prepare", "tap"]);
    // The next tap on a button acts again (deafened: the mic back on undeafens).
    tap(btn("mute"));
    expect(last(e.asked)).toBe("deafen:false:mute:false");
  });

  it("caught mid-flight it stops under the finger; Reduce Motion gets no lift", async () => {
    render(<Floats />);
    await inCall();
    const el = callTile()!;
    drag(el, 1, [[0, 200, 130], [100, 100, 640]]);
    flush(3);
    const moving = el.style.transform;
    expect(moving).not.toBe("");
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 60, clientY: 690 });
    flush();
    expect(el.style.transform).toBe(moving);
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 60, clientY: 690 });
    flush();
    expect(el.style.transform).toBe("");

    reduce = true;
    drag(el, 3, [[5000, 60, 690], [5200, 300, 140]], { up: false });
    flush();
    expect(el.style.transform).toBe("translate(240px, -550px)");
    clock = 6000;
    fireEvent.pointerUp(el, { pointerId: 3, clientX: 300, clientY: 140 });
    expect(el.getAttribute("data-corner")).toBe("top-right");
    flush();
    expect(el.style.transform).toBe("");
  });

  it("shares the saved corner with the video tile, both ways", async () => {
    render(<Floats />);
    const e = await inCall();
    expect(callTile()?.getAttribute("data-corner")).toBe("top-right");
    drag(callTile()!, 1, [[0, 300, 130], [300, 60, 700]]);
    flush();
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe("bottom-left");
    // The picture starts: the video tile comes up in the same corner.
    act(() => e.events()?.onVideo?.(true));
    act(() => onPipEvent({ event: "pip_first_frame" }));
    expect(videoTile()?.getAttribute("data-corner")).toBe("bottom-left");
    flush();
    expect(last(sent)).toMatchObject({ visible: true, x: 12, y: 660, w: 120, h: 68 });
    // Moved as video, then the picture stops: the call tile follows it.
    drag(videoTile()!, 2, [[1000, 60, 690], [1300, 330, 690]]);
    flush();
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe("bottom-right");
    act(() => onPipEvent({ event: "pip_stalled" }));
    expect(callTile()?.getAttribute("data-corner")).toBe("bottom-right");
  });
});
