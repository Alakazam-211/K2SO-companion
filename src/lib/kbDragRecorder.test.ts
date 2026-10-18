// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardDragObserver } from "../zen/keyboardDragDock";

let observer: KeyboardDragObserver | null = null;
let bottom: number | null = 508;
vi.mock("../zen/keyboardDragDock", () => ({
  setKeyboardDragObserver: vi.fn((o: KeyboardDragObserver | null) => {
    observer = o;
  }),
  composerBottomNow: () => bottom,
  dismissPaddingPx: () => 64,
}));
vi.mock("./useViewportHeight", () => ({ keyboardTopNow: () => 508 }));

import {
  __resetKbRecorderForTests,
  clearRecordedDrags,
  initKbDragRecorder,
  recordedDrags,
  recorderOn,
  setRecorderOn,
} from "./kbDragRecorder";
import { setKeyboardDragObserver } from "../zen/keyboardDragDock";

function rec(top: number, scrollY: number) {
  window.dispatchEvent(
    new CustomEvent("k2-keyboard-rec", {
      detail: { top, scrollY, t: performance.timeOrigin + performance.now() },
    })
  );
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
  localStorage.clear();
  __resetKbRecorderForTests();
  observer = null;
  bottom = 508;
  vi.mocked(setKeyboardDragObserver).mockClear();
});
afterEach(() => {
  __resetKbRecorderForTests();
  vi.useRealTimers();
});

describe("kbDragRecorder", () => {
  it("off by default: nothing installed, nothing recorded; the dev switch exists", () => {
    initKbDragRecorder();
    expect(recorderOn()).toBe(false);
    expect(setKeyboardDragObserver).not.toHaveBeenCalled();
    rec(520, 900);
    expect(recordedDrags()).toEqual([]);
    expect(typeof (window as unknown as { __k2KbRecorder?: { on: unknown } }).__k2KbRecorder?.on).toBe("function");
  });

  it("on: one drag is recorded attach → release → settled, scored and kept", () => {
    setRecorderOn(true);
    expect(localStorage.getItem("k2.kbDragRecorder.v1")).toBe("1");
    expect(observer).not.toBeNull();
    // Native frames before the attach (pre-roll), then the drag.
    for (let i = 0; i < 3; i++) {
      rec(508, 1000);
      vi.advanceTimersByTime(8);
    }
    observer!.attached("touch");
    for (let i = 1; i <= 20; i++) {
      rec(508 + i * 3, 1000 - i * 3);
      bottom = 508 + i * 3;
      vi.advanceTimersToNextFrame();
    }
    observer!.corrected(-2, 110);
    window.dispatchEvent(new Event("touchend"));
    observer!.released(568, 568);
    window.dispatchEvent(new CustomEvent("k2-keyboard-will", { detail: { show: false, duration: 250 } }));
    observer!.detached();
    for (let i = 0; i < 40; i++) {
      rec(568 + i * 5, 940);
      bottom = 568 + i * 5;
      vi.advanceTimersToNextFrame();
    }
    const drags = recordedDrags();
    expect(drags).toHaveLength(1);
    const { trace, score } = drags[0];
    expect(trace.v).toBe(1);
    expect(trace.restTop).toBe(508);
    expect(trace.padding).toBe(64);
    expect(trace.samples.length).toBeGreaterThan(20);
    expect(trace.page.length).toBeGreaterThan(20);
    expect(trace.events.map((e) => e.k)).toEqual(
      expect.arrayContaining(["attach", "correct", "lift", "release", "will", "end"])
    );
    expect(score.frames).toBeGreaterThan(10);
    expect(score.correctionMs).toBe(110);
    // Persisted (compact JSON), and cleared.
    expect(JSON.parse(localStorage.getItem("k2.kbDragTraces.v1") ?? "[]")).toHaveLength(1);
    clearRecordedDrags();
    expect(recordedDrags()).toEqual([]);
  });

  it("off again: uninstalled and native frames ignored", () => {
    setRecorderOn(true);
    setRecorderOn(false);
    expect(observer).toBeNull();
    expect(localStorage.getItem("k2.kbDragRecorder.v1")).toBeNull();
    rec(520, 900);
    expect(recordedDrags()).toEqual([]);
  });
});
