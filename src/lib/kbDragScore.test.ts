import { describe, expect, it } from "vitest";
import { gapSeries, isTrace, keyboardTopAt, scoreTrace, TRACE_VERSION, type KbTrace } from "./kbDragScore";

function trace(over: Partial<KbTrace> = {}): KbTrace {
  return {
    v: TRACE_VERSION,
    device: "iPhone",
    ios: "26.0",
    dpr: 3,
    refreshHz: 120,
    restTop: 508,
    padding: 64,
    clockErrMs: 0.6,
    samples: [],
    page: [],
    events: [],
    ...over,
  };
}

describe("kbDragScore", () => {
  it("keyboardTopAt interpolates between native samples", () => {
    const s: KbTrace["samples"] = [
      [0, 508, 1000],
      [10, 528, 980],
    ];
    expect(keyboardTopAt(s, 5)).toBe(518);
    expect(keyboardTopAt(s, -1)).toBeNull();
    expect(keyboardTopAt(s, 11)).toBeNull();
  });

  it("scores gaps, the correction, the steady phase, the lift, the hand-off and the tail", () => {
    const f = 1000 / 120;
    const samples: KbTrace["samples"] = [];
    const page: KbTrace["page"] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i * f;
      const kb = 510 + i * 2;
      samples.push([t, kb, 1500 - i * 2]);
      // 3px low until the correction ends at 50ms, then on it; 4px off
      // in the one hand-off frame after the lift at 300ms.
      const g = t < 50 ? 3 : t > 300 && t <= 310 ? 4 : 0;
      // one dropped frame (skip i = 20)
      if (i !== 20) page.push([t, kb + g, 0]);
    }
    const s = scoreTrace(
      trace({
        samples,
        page,
        events: [
          { t: 0, k: "attach", via: "touch" },
          { t: 10, k: "correct", d: -3, ms: 40 },
          { t: 300, k: "lift" },
          { t: 310, k: "release", fromTop: 580, copyBottom: 584 },
        ],
      })
    );
    expect(s.frames).toBe(60);
    expect(s.maxGap).toBe(4);
    expect(s.correctionStartMs).toBe(10);
    expect(s.correctionMs).toBe(40);
    expect(s.steadyMaxGap).toBe(0);
    expect(s.steadyOffFrames).toBe(0);
    expect(s.droppedFrames).toBe(1);
    expect(s.releaseJump).toBe(0);
    expect(s.handoffMaxGap).toBe(4);
    expect(s.releaseLandingErr).toBe(0);
    expect(s.tailMaxGap).toBe(0);
    expect(s.earlyAttachMs).toBe(0);
    expect(gapSeries(trace({ samples, page })).length).toBe(60);
  });

  it("flags an attach before the keyboard moved", () => {
    const s = scoreTrace(
      trace({
        samples: [
          [0, 508, 0],
          [30, 508, 0],
          [40, 512, 0],
        ],
        page: [[0, 508, 0]],
        events: [{ t: 0, k: "attach", via: "touch" }],
      })
    );
    expect(s.earlyAttachMs).toBe(40);
  });

  it("isTrace accepts v1 traces only", () => {
    expect(isTrace(trace())).toBe(true);
    expect(isTrace({ ...trace(), v: 2 })).toBe(false);
    expect(isTrace(null)).toBe(false);
  });
});
