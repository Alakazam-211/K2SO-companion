import { describe, expect, it } from "vitest";

import {
  driveEnterFrames,
  driveLeaveFrames,
  driveResizeFrames,
  isUsableFit,
} from "./driveMode";
import {
  FALLBACK_SPAWN_COLS,
  FALLBACK_SPAWN_ROWS,
  measurePaneFit,
} from "./measurePaneFit";

const CW = 8;
const CH = 16;

function jsonOf(frames: unknown[]): string {
  return JSON.stringify(frames);
}

describe("driveEnterFrames — measure-first", () => {
  it("sends only set_mode:claimer when the pane is unmeasurable (never 80×24)", () => {
    const frames = driveEnterFrames(null);
    expect(frames).toEqual([{ action: "set_mode", mode: "claimer" }]);
    expect(jsonOf(frames)).not.toContain(`"cols":${FALLBACK_SPAWN_COLS}`);
    expect(jsonOf(frames)).not.toContain(`"rows":${FALLBACK_SPAWN_ROWS}`);
    expect(driveEnterFrames(measurePaneFit({ width: 0, height: 0 }, CW, CH))).toEqual(
      frames,
    );
  });

  it("sends set_mode then set_active at the measured content-box fit", () => {
    const fit = measurePaneFit({ width: 800, height: 640 }, CW, CH);
    expect(fit).toEqual({ cols: 99, rows: 39 });
    expect(driveEnterFrames(fit)).toEqual([
      { action: "set_mode", mode: "claimer" },
      { action: "set_active", active: true, cols: 99, rows: 39 },
      { action: "resize", cols: 99, rows: 39 },
    ]);
  });

  it("does not treat the VT spawn fallback as a measured fit", () => {
    expect(
      isUsableFit({ cols: FALLBACK_SPAWN_COLS, rows: FALLBACK_SPAWN_ROWS }),
    ).toBe(true);
    // Usable if someone measured 80×24 for real — but Drive never
    // substitutes those constants when measurePaneFit returns null.
    expect(isUsableFit(null)).toBe(false);
    expect(driveEnterFrames(undefined)).toEqual([
      { action: "set_mode", mode: "claimer" },
    ]);
  });
});

describe("driveResizeFrames", () => {
  it("is empty until a real measure exists", () => {
    expect(driveResizeFrames(null)).toEqual([]);
    expect(driveResizeFrames({ cols: 0, rows: 24 })).toEqual([]);
  });

  it("re-asserts set_active at the new measured size (no set_mode)", () => {
    const fit = measurePaneFit({ width: 400, height: 320 }, CW, CH);
    expect(fit).not.toBeNull();
    expect(driveResizeFrames(fit)).toEqual([
      { action: "set_active", active: true, cols: fit!.cols, rows: fit!.rows },
      { action: "resize", cols: fit!.cols, rows: fit!.rows },
    ]);
  });
});

describe("driveLeaveFrames", () => {
  it("drops to viewer and releases the active slot", () => {
    expect(driveLeaveFrames()).toEqual([
      { action: "set_mode", mode: "viewer" },
      { action: "set_active", active: false },
    ]);
  });
});
