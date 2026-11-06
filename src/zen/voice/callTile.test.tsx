// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), addPluginListener: vi.fn(async () => ({ unregister() {} })) }));

import { CALL_TILE_H, CALL_TILE_W, CALL_TILE_W_CAMERA, CallTile, CARD_EDGE, CARD_TOP_RADIUS, cardVideoHeight } from "./callTile";
import { SNAP_SPRING } from "./miniSnap";
import { __setTileCameraLoaderForTests, useTileCamera, type TileCamera } from "./tileCamera";
import { __resetCornerForTests, anchorStyle, MINI_CORNER_KEY, type Corner } from "./videoLayer";
import { __resetPipForTests, __setHapticForTests, __setTileSenderForTests, HIDDEN, onPipEvent, type TileFrame } from "./videoTile";
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

// The card on a 375×812 phone, as the CSS lays it out: 12 from the sides,
// its top edge 110 from the top in a top corner, its bottom edge 84 + 0 from
// the bottom in a bottom one (so the whole card, picture and strip, stays
// clear of the header and the composer). Its size is its style's; its
// picture sits inside its 1 pt edge at the top. Rects follow the corner and
// the transform like a browser's.
const VIDEO_H = cardVideoHeight(CALL_TILE_W); // 84
const CARD_H = CALL_TILE_H + VIDEO_H; // 140
const size = (el: HTMLElement): [number, number] => [parseFloat(el.style.width) || CALL_TILE_W, parseFloat(el.style.height) || CALL_TILE_H];
function home(corner: string, w: number, h: number) {
  const [v, side] = corner.split("-");
  return { left: side === "left" ? 12 : 375 - 12 - w, top: v === "top" ? 110 : 728 - h };
}
function cardRect(el: HTMLElement) {
  const [w0, h0] = size(el);
  const at = home(el.dataset.corner ?? "top-right", w0, h0);
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)(?: scale\(([\d.]+)\))?/.exec(el.style.transform);
  const [x, y, s] = m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 1];
  const w = w0 * s;
  const h = h0 * s;
  return { left: at.left + w0 / 2 + x - w / 2, top: at.top + h0 / 2 + y - h / 2, width: w, height: h };
}
function pictureRect(pic: HTMLElement) {
  const card = pic.closest<HTMLElement>('[data-testid="voice-call-tile"]')!;
  const c = cardRect(card);
  const s = c.width / size(card)[0];
  return {
    left: c.left + CARD_EDGE * s,
    top: c.top + CARD_EDGE * s,
    width: (size(card)[0] - 2 * CARD_EDGE) * s,
    height: (parseFloat(pic.style.height) || 0) * s,
  };
}
const half = (v: number) => Math.round(v * 2) / 2;
/** The native layer's frame for the picture where it's drawn now. */
const frameOf = (r: { left: number; top: number; width: number; height: number }) => ({
  visible: true,
  x: half(r.left),
  y: half(r.top),
  w: half(r.width),
  h: half(r.height),
  radius: CARD_TOP_RADIUS - CARD_EDGE,
  corners: "top",
});
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
  // The kit's camera stays out of these: each test sets the store itself.
  __setTileCameraLoaderForTests(async () => () => {});
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
    const r =
      id === "voice-call-tile"
        ? cardRect(this)
        : id === "voice-call-tile-picture"
          ? pictureRect(this)
          : { left: 20, top: 500, width: 320, height: 180 };
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
  __setCallShimForTests(callShim());
  HTMLElement.prototype.getBoundingClientRect = rect;
});

const card = () => screen.queryByTestId("voice-call-tile");
const picture = () => screen.getByTestId("voice-call-tile-picture");
const btn = (name: "mute" | "deafen" | "camera" | "leave") => screen.getByTestId(`voice-call-tile-${name}`);
const visibleFrames = () => sent.filter((f) => f.visible);

function Float({ open = false, onOpen = () => {} }: { open?: boolean; onOpen?: () => void }) {
  return <CallTile callViewOpen={open} onOpen={onOpen} />;
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

/** Someone's picture plays on the native layer. */
function videoLive(e: Awaited<ReturnType<typeof inCall>>) {
  act(() => e.events()?.onVideo?.(true));
  act(() => onPipEvent({ event: "pip_first_frame" }));
}

/** The kit's camera, as tileCameraKit would set it. */
function camera(next: Partial<TileCamera>) {
  act(() => useTileCamera.setState({ shown: true, state: "off", enabled: true, label: "Turn on camera", ...next }));
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
  it("shows while a call is up and the call area closed: the plain pill without a picture", async () => {
    const { rerender } = render(<Float />);
    expect(card()).toBeNull();
    await inCall();
    expect(card()).toBeTruthy();
    expect(card()?.getAttribute("aria-label")).toBe("Call in Standup. Tap the tile to open the call.");
    expect(card()?.getAttribute("data-picture")).toBe("none");
    // Three 40 pt buttons: the pill Rosson liked, unchanged.
    expect([CALL_TILE_W, CALL_TILE_H]).toEqual([152, 56]);
    expect(card()?.style.width).toBe("152px");
    expect(card()?.style.height).toBe("56px");
    expect(picture().style.height).toBe("0px");
    expect(screen.queryByTestId("voice-call-tile-camera")).toBeNull();
    rerender(<Float open />);
    expect(card()).toBeNull();
    rerender(<Float />);
    expect(card()).toBeTruthy();
    await act(() => useVoiceCall.getState().leave());
    expect(card()).toBeNull();
    // No picture: it never places the native layer.
    expect(visibleFrames()).toEqual([]);
  });

  it("someone's video: the picture opens on top of the strip, one card, the layer on the picture", async () => {
    render(<Float />);
    const e = await inCall();
    // Video, but no frame yet: still the pill, never an empty picture.
    act(() => e.events()?.onVideo?.(true));
    expect(card()?.getAttribute("data-picture")).toBe("none");
    act(() => onPipEvent({ event: "pip_first_frame" }));
    expect(card()?.getAttribute("data-picture")).toBe("remote");
    flush(4);
    // On its way: the card grows down from under the header (top corner),
    // the layer on the picture frame by frame, its top corners rounded only.
    const mid = parseFloat(card()!.style.height);
    expect(mid).toBeGreaterThan(CALL_TILE_H);
    expect(mid).toBeLessThan(CARD_H);
    expect(last(sent)).toEqual(frameOf(pictureRect(picture())));
    flush();
    expect(card()?.style.height).toBe(`${CARD_H}px`);
    expect(picture().style.height).toBe(`${VIDEO_H}px`);
    expect(card()?.style.borderRadius).toBe(`${CARD_TOP_RADIUS}px ${CARD_TOP_RADIUS}px 28px 28px`);
    expect(picture().style.borderRadius).toBe(`${CARD_TOP_RADIUS - 1}px ${CARD_TOP_RADIUS - 1}px 0px 0px`);
    // 16:9 at the strip's width, inside the card's edge.
    expect(last(sent)).toEqual({ visible: true, x: 212, y: 111, w: 150, h: 84, radius: 15, corners: "top" });
    // Every frame on the way was the picture's: growing, its top fixed.
    const heights = visibleFrames().map((f) => (f.visible ? f.h : 0));
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(visibleFrames().every((f) => f.visible && f.y === 111 && f.x === 212 && f.w === 150)).toBe(true);
  });

  it("when the video stops the picture folds away into the pill, in the same corner, and back", async () => {
    localStorage.setItem(MINI_CORNER_KEY, "bottom-left");
    render(<Float />);
    const e = await inCall();
    videoLive(e);
    flush();
    // In a bottom corner the strip stays put and the picture grew above it.
    expect(last(sent)).toEqual({ visible: true, x: 13, y: 728 - CARD_H + 1, w: 150, h: 84, radius: 15, corners: "top" });
    expect(visibleFrames().every((f) => f.visible && Math.abs(f.y + f.h - (728 - CALL_TILE_H + 1)) <= 0.5)).toBe(true);
    act(() => onPipEvent({ event: "pip_stalled" }));
    // The layer goes under the page at once (no live picture to show).
    expect(last(sent)).toEqual(HIDDEN);
    expect(card()?.getAttribute("data-picture")).toBe("none");
    flush(4);
    const h = parseFloat(card()!.style.height);
    expect(h).toBeGreaterThan(CALL_TILE_H);
    expect(h).toBeLessThan(CARD_H);
    // Fading as it folds.
    expect(Number(picture().style.opacity)).toBeLessThan(1);
    flush();
    expect(card()?.style.height).toBe("56px");
    expect(card()?.getAttribute("data-corner")).toBe("bottom-left");
    expect(card()?.getAttribute("data-open")).toBe("no");
    // The picture back: the card opens again in place.
    act(() => onPipEvent({ event: "pip_first_frame" }));
    flush();
    expect(card()?.style.height).toBe(`${CARD_H}px`);
    expect(last(sent)).toMatchObject({ visible: true, x: 13, y: 589, h: 84 });
    act(() => e.events()?.onVideo?.(false));
    flush();
    expect(card()?.style.height).toBe("56px");
    expect(last(sent)).toEqual(HIDDEN);
  });

  it("with Reduce Motion the picture opens and folds at once", async () => {
    reduce = true;
    render(<Float />);
    const e = await inCall();
    videoLive(e);
    expect(card()?.style.height).toBe(`${CARD_H}px`);
    act(() => onPipEvent({ event: "pip_cleared" }));
    expect(card()?.style.height).toBe("56px");
  });

  it("dragged as one card: the layer follows the picture's part, through the lift and on the spring", async () => {
    render(<Float />);
    const e = await inCall();
    videoLive(e);
    flush();
    const el = card()!;
    // Slowly, down to the bottom left, picked up on the camera-less strip.
    drag(el, 2, [[1000, 300, 140], [1200, 80, 640]], { up: false });
    expect(el.style.transform).toBe("translate(-220px, 500px)");
    flush(1);
    // The same frame: the card a little bigger now it's held, the layer on its picture.
    expect(el.style.transform).toMatch(/^translate\(-220px, 500px\) scale\(1\.0\d+\)$/);
    expect(last(sent)).toEqual(frameOf(pictureRect(picture())));
    flush();
    clock = 1600;
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 80, clientY: 641 });
    flush(1);
    expect(el.style.transform).toBe("translate(-220px, 501px) scale(1.04)");
    expect(last(sent)).toEqual(frameOf(pictureRect(picture())));
    clock = 1900;
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 80, clientY: 641 });
    expect(el.getAttribute("data-corner")).toBe("bottom-left");
    // Swift gets the picture's spot in the new corner (the card's bottom edge
    // on the composer's inset) and the spring to get there by, once.
    expect(last(sent)).toEqual({
      visible: true,
      x: 13,
      y: 728 - CARD_H + 1,
      w: 150,
      h: 84,
      radius: 15,
      corners: "top",
      animate: { duration: expect.any(Number), ...SNAP_SPRING, velocityX: 0, velocityY: 0, startedAt: expect.any(Number) },
    });
    const count = sent.length;
    flush();
    expect(el.style.transform).toBe("");
    // Nothing more for Swift: it ran the same spring itself.
    expect(sent.length).toBe(count);
    expect(haptics).toEqual(["prepare", "tap"]);
  });

  it("caught mid-flight it stops under the finger, the layer on its picture; Reduce Motion eases", async () => {
    render(<Float />);
    const e = await inCall();
    videoLive(e);
    flush();
    const el = card()!;
    drag(el, 1, [[0, 300, 140], [16, 290, 160], [32, 270, 200], [48, 250, 240]]);
    expect(el.getAttribute("data-corner")).toBe("bottom-left");
    flush(6);
    const n = sent.length;
    clock += 5;
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 100, clientY: 400 });
    expect(sent.length).toBe(n + 1);
    expect(sent[n]).toEqual(frameOf(pictureRect(picture())));
    const t = el.style.transform;
    flush();
    expect(el.style.transform).toBe(t);
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 100, clientY: 400 });
    flush();
    expect(el.style.transform).toBe("");

    reduce = true;
    drag(el, 3, [[5000, 60, 690], [5200, 300, 140]], { up: false });
    flush();
    expect(el.style.transform).toBe("translate(240px, -550px)");
    clock = 6000;
    fireEvent.pointerUp(el, { pointerId: 3, clientX: 300, clientY: 140 });
    expect(el.getAttribute("data-corner")).toBe("top-right");
    expect(last(sent)).toEqual({ ...frameOf({ left: 212, top: 111, width: 150, height: 84 }), animate: { duration: 0.22, startedAt: expect.any(Number) } });
    flush();
    expect(el.style.transform).toBe("");
  });

  it("a fling goes to the corner it's thrown at, a slow release to the nearest", async () => {
    render(<Float />);
    const e = await inCall();
    videoLive(e);
    flush();
    // A short, fast throw down and to the left from the top right.
    drag(card()!, 1, [[0, 300, 140], [16, 290, 160], [32, 270, 200], [48, 250, 240]]);
    expect(card()?.getAttribute("data-corner")).toBe("bottom-left");
    const thrown = last(sent) as { animate: { velocityX: number; velocityY: number } };
    expect(thrown.animate.velocityX).toBeCloseTo(-1041.7, 0);
    expect(thrown.animate.velocityY).toBeCloseTo(2083.3, 0);
    flush();
    // Back up the same way, slowly, with a pause before letting go: it stays.
    drag(card()!, 2, [[1000, 60, 690], [1200, 70, 670], [1400, 90, 630], [1600, 110, 590], [1900, 110, 590]]);
    expect(card()?.getAttribute("data-corner")).toBe("bottom-left");
    expect(last(sent)).toMatchObject({ x: 13, y: 589, animate: { velocityX: 0, velocityY: 0 } });
  });

  it("while Swift springs the layer, the page doesn't move it", async () => {
    render(<Float />);
    const e = await inCall();
    videoLive(e);
    flush();
    drag(card()!, 1, [[0, 300, 140], [200, 80, 640], [600, 80, 641]]);
    const n = sent.length;
    flush(3);
    fireEvent.scroll(document);
    flush(3);
    expect(sent.length).toBe(n);
    flush();
    expect(sent.length).toBe(n);
    expect(card()!.style.transform).toBe("");
  });

  it("each corner's insets hold the whole card: its top edge under the header, its bottom over the composer", async () => {
    for (const c of ["top-left", "top-right", "bottom-left", "bottom-right"] as Corner[]) {
      cleanup();
      __resetVoiceCallForTests();
      __resetPipForTests();
      sent.length = 0;
      localStorage.setItem(MINI_CORNER_KEY, c);
      render(<Float />);
      const e = await inCall();
      videoLive(e);
      flush();
      const el = card()!;
      const [v, h] = c.split("-") as ["top" | "bottom", "left" | "right"];
      const want = anchorStyle(c) as Record<string, string>;
      // Anchored by the card's own edges (the safe area plus the header, or
      // plus the composer): a taller card grows away from them.
      expect(want[v]).toContain(v === "top" ? "safe-area-inset-top" : "--safe-bottom");
      expect(want[v]).toContain(v === "top" ? "64px" : "84px");
      expect(el.style[v]).toContain(v === "top" ? "safe-area-inset-top" : "--safe-bottom");
      expect(el.style[h]).toContain(`safe-area-inset-${h}`);
      expect(el.style[v === "top" ? "bottom" : "top"]).toBe("");
      expect(el.style[h === "left" ? "right" : "left"]).toBe("");
      const r = cardRect(el);
      expect(r.height).toBe(CARD_H);
      expect(v === "top" ? r.top : r.top + r.height).toBe(v === "top" ? 110 : 728);
      expect(last(sent)).toMatchObject({ x: h === "left" ? 13 : 212, y: v === "top" ? 111 : 589, h: 84 });
    }
  });

  it("Mute, Deafen and Hang up are the call's own actions, and show the engine's state", async () => {
    render(<Float />);
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
    expect(card()).toBeNull();
  });

  it("a moderator's mute: the mic shows locked and does nothing, with or without a picture", async () => {
    render(<Float />);
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
    // The card with its picture: the same strip, the same lock.
    videoLive(e);
    flush();
    expect(card()?.getAttribute("data-picture")).toBe("remote");
    expect(btn("mute").getAttribute("data-locked")).toBe("yes");
    tap(btn("mute"));
    tap(btn("deafen"));
    expect(e.asked).toEqual(["deafen:true"]);
    // Lifted: the mic is yours again.
    act(() => e.events()?.onSelfMute?.(false, { deafened: false, muteLocked: false, deafLocked: false }));
    expect(btn("mute").getAttribute("aria-disabled")).toBeNull();
    expect(btn("mute").getAttribute("aria-pressed")).toBe("false");
  });

  it("a tap on a button is the button's; a tap on the picture or the edge opens the call; a drag is neither", async () => {
    const onOpen = vi.fn();
    const toggle = vi.fn();
    render(<Float onOpen={onOpen} />);
    const e = await inCall();
    camera({ toggle });
    videoLive(e);
    flush();
    tap(btn("mute"));
    expect(e.asked).toEqual(["mute:true"]);
    tap(btn("camera"));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    // The picture: the call area, as the video tile always did.
    tap(picture());
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The card's edge, not a button: the call area too.
    tap(card()!);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(e.asked).toEqual(["mute:true"]);
    // A small wobble is still a tap.
    fireEvent.pointerDown(btn("deafen"), { pointerId: 2, clientX: 250, clientY: 130 });
    fireEvent.pointerMove(btn("deafen"), { pointerId: 2, clientX: 254, clientY: 133 });
    fireEvent.pointerUp(btn("deafen"), { pointerId: 2, clientX: 254, clientY: 133 });
    fireEvent.click(btn("deafen"));
    expect(e.asked).toEqual(["mute:true", "deafen:true"]);
    // A drag that starts on a button moves the card, and its click is no tap.
    const el = card()!;
    drag(btn("leave"), 3, [[1000, 340, 130], [1200, 100, 640]], { up: false });
    expect(el.style.transform).toBe("translate(-240px, 510px)");
    flush();
    clock = 1600;
    fireEvent.pointerUp(btn("leave"), { pointerId: 3, clientX: 100, clientY: 640 });
    fireEvent.click(btn("leave"));
    expect(e.asked).toEqual(["mute:true", "deafen:true"]);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(useVoiceCall.getState().phase).toBe("connected");
    expect(card()?.getAttribute("data-corner")).toBe("bottom-left");
    flush();
    expect(el.style.transform).toBe("");
    expect(haptics).toEqual(["prepare", "tap"]);
    // Dragged from the camera button or the picture: moved, nothing toggled or opened.
    drag(btn("camera"), 4, [[3000, 100, 640], [3200, 300, 150]]);
    fireEvent.click(btn("camera"));
    flush();
    drag(picture(), 5, [[4000, 300, 150], [4200, 80, 640]]);
    flush();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(card()?.getAttribute("data-corner")).toBe("bottom-left");
    // The next tap on a button acts again (deafened: the mic back on undeafens).
    tap(btn("mute"));
    expect(last(e.asked)).toBe("deafen:false:mute:false");
  });

  it("keeps the saved corner through the picture coming and going", async () => {
    render(<Float />);
    const e = await inCall();
    expect(card()?.getAttribute("data-corner")).toBe("top-right");
    drag(card()!, 1, [[0, 300, 130], [300, 60, 700]]);
    flush();
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe("bottom-left");
    videoLive(e);
    flush();
    expect(card()?.getAttribute("data-corner")).toBe("bottom-left");
    expect(last(sent)).toMatchObject({ visible: true, x: 13, y: 589, w: 150, h: 84 });
    drag(card()!, 2, [[1000, 60, 690], [1300, 330, 690]]);
    flush();
    expect(localStorage.getItem(MINI_CORNER_KEY)).toBe("bottom-right");
    act(() => onPipEvent({ event: "pip_stalled" }));
    flush();
    expect(card()?.getAttribute("data-corner")).toBe("bottom-right");
  });
});

describe("the call tile's camera", () => {
  it("hidden while the call can't do video; else a fourth button before Hang up, the card widened", async () => {
    render(<Float />);
    await inCall();
    expect(screen.queryByTestId("voice-call-tile-camera")).toBeNull();
    camera({});
    const order = [...card()!.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"));
    expect(order).toEqual(["voice-call-tile-mute", "voice-call-tile-deafen", "voice-call-tile-camera", "voice-call-tile-leave"]);
    expect(CALL_TILE_W_CAMERA).toBe(200);
    expect(card()?.style.width).toBe("200px");
    expect(card()?.style.height).toBe("56px");
    camera({ shown: false });
    expect(screen.queryByTestId("voice-call-tile-camera")).toBeNull();
    expect(card()?.style.width).toBe("152px");
  });

  it("shows on, off, paused and asking; pressable only when the kit says so", async () => {
    const toggle = vi.fn();
    render(<Float />);
    await inCall();
    camera({ toggle });
    const cam = () => btn("camera");
    expect(cam().getAttribute("data-state")).toBe("off");
    expect(cam().getAttribute("aria-pressed")).toBe("false");
    expect(cam().getAttribute("aria-label")).toBe("Turn on camera");
    tap(cam());
    expect(toggle).toHaveBeenCalledTimes(1);
    camera({ toggle, state: "asking", enabled: false, label: "Turning on camera…" });
    expect(cam().getAttribute("aria-disabled")).toBe("true");
    tap(cam());
    expect(toggle).toHaveBeenCalledTimes(1);
    camera({ toggle, state: "on", label: "Turn off camera" });
    expect(cam().getAttribute("aria-pressed")).toBe("true");
    expect(cam().getAttribute("aria-disabled")).toBeNull();
    camera({ toggle, state: "paused", label: "Camera paused while the app is in the background." });
    expect(cam().getAttribute("data-state")).toBe("paused");
    expect(cam().getAttribute("aria-pressed")).toBe("true");
    expect(cam().getAttribute("aria-label")).toBe("Camera paused while the app is in the background.");
    // Refused for the call: the kit's sentence, and the tap does nothing.
    camera({ toggle, state: "off", enabled: false, label: "You can't send video in this call." });
    expect(cam().getAttribute("aria-label")).toBe("You can't send video in this call.");
    expect(cam().getAttribute("aria-disabled")).toBe("true");
    tap(cam());
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("your camera on and nobody else's video: you, in the picture, never on the native layer", async () => {
    render(<Float />);
    await inCall();
    const handle = { key: "local:camera", attach: vi.fn(), detach: vi.fn() };
    camera({ state: "on", selfOn: true, self: handle, mirrored: true });
    flush();
    expect(card()?.getAttribute("data-picture")).toBe("self");
    expect(card()?.style.height).toBe(`${cardVideoHeight(CALL_TILE_W_CAMERA) + CALL_TILE_H}px`);
    const view = screen.getByTestId("voice-self-view");
    expect(view.getAttribute("data-mirrored")).toBe("yes");
    expect(handle.attach).toHaveBeenCalledTimes(1);
    // No frame yet (Sew's next merge brings them): "Camera on", never a black box.
    expect(screen.getByTestId("voice-call-tile-camera-note").textContent).toBe("Camera on");
    const video = screen.getByTestId("voice-self-video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    fireEvent.loadedData(video);
    expect(screen.queryByTestId("voice-call-tile-camera-note")).toBeNull();
    // The back camera: not mirrored.
    camera({ state: "on", selfOn: true, self: handle, mirrored: false });
    expect(screen.getByTestId("voice-self-view").getAttribute("data-mirrored")).toBe("no");
    // Never the layer (so never PiP).
    expect(visibleFrames()).toEqual([]);
  });

  it("no self-view this webview can draw: the camera note stands in", async () => {
    render(<Float />);
    await inCall();
    camera({ state: "on", selfOn: true, self: null });
    flush();
    expect(card()?.getAttribute("data-picture")).toBe("self");
    expect(screen.getByTestId("voice-call-tile-camera-note").textContent).toBe("Camera on");
    camera({ state: "paused", selfOn: true, self: null });
    expect(screen.getByTestId("voice-call-tile-camera-note").textContent).toBe("Camera paused");
  });

  it("someone else's video goes live: the picture switches from you to them, in place; and back", async () => {
    render(<Float />);
    const e = await inCall();
    const handle = { key: "local:camera", attach: vi.fn(), detach: vi.fn() };
    camera({ state: "on", selfOn: true, self: handle });
    flush();
    const h = card()!.style.height;
    videoLive(e);
    flush();
    expect(card()?.getAttribute("data-picture")).toBe("remote");
    expect(screen.queryByTestId("voice-self-view")).toBeNull();
    expect(handle.detach).toHaveBeenCalledTimes(1);
    // The same card, no fold: the active speaker's picture on the layer.
    expect(card()?.style.height).toBe(h);
    expect(last(sent)).toEqual({ visible: true, x: 375 - 12 - 200 + 1, y: 111, w: 198, h: cardVideoHeight(200), radius: 15, corners: "top" });
    // Their video stops: you again, the layer gone.
    act(() => onPipEvent({ event: "pip_stalled" }));
    flush();
    expect(card()?.getAttribute("data-picture")).toBe("self");
    expect(card()?.style.height).toBe(h);
    expect(last(sent)).toEqual(HIDDEN);
    // Your camera off: the plain pill.
    camera({ state: "off", selfOn: false, self: null });
    flush();
    expect(card()?.getAttribute("data-picture")).toBe("none");
    expect(card()?.style.height).toBe("56px");
  });
});
