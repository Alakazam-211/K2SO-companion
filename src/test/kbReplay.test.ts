// @vitest-environment jsdom
// Keyboard-drag replays: every trace in src/test/kbTraces/ (synthetic now;
// real device traces dropped in later — Server settings → Diagnostics →
// Keyboard drag recorder → "Copy trace JSON" → save as
// src/test/kbTraces/<name>.json) is replayed through the real page logic
// and must meet the thresholds below.
//
// Thresholds (px / ms):
//   - steady phase (after the correction, until the release): max |gap|
//     ≤ 1 px — the composer copy rides the keyboard exactly;
//   - the correction lasts ≤ 220 ms (CORRECTION_MAX_MS) and starts within
//     3 frames of the attach;
//   - release: the composer lands on the keyboard (first frame after the
//     hand-off ≤ 1 px) and the copy was on it when released (jump ≤ 1 px);
//   - the release tail (the FLIP play) stays on the keyboard (≤ 1 px:
//     synthetic traces model the keyboard on the page's own curve);
//   - no attach before the keyboard moved (≤ 1 frame early).
import { describe, expect, it } from "vitest";
import { isTrace, type KbTrace } from "../lib/kbDragScore";
import { CORRECTION_MAX_MS } from "../zen/keyboardDragDock";
import { replayTrace } from "./kbReplay";

const files = import.meta.glob("./kbTraces/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;
const traces = Object.entries(files)
  .filter(([, t]) => isTrace(t))
  .map(([path, t]) => ({ name: path.replace(/^.*\//, "").replace(/\.json$/, ""), trace: t as KbTrace }));

describe("keyboard drag replays", () => {
  it("has traces", () => {
    expect(traces.length).toBeGreaterThanOrEqual(4);
  });

  for (const { name, trace } of traces) {
    it(`${name}${trace.synthetic ? " (synthetic)" : ""}`, () => {
      const { score } = replayTrace(trace, { ipcFrames: 1, pageLagFrames: 1 });
      const frame = 1000 / (trace.refreshHz || 60);
      // eslint-disable-next-line no-console
      console.log(`[kb replay] ${name}`, JSON.stringify(score));
      expect(score.frames).toBeGreaterThan(10);
      expect(score.steadyMaxGap).toBeLessThanOrEqual(1);
      if (score.correctionMs != null) {
        expect(score.correctionMs).toBeLessThanOrEqual(CORRECTION_MAX_MS);
        expect(score.correctionStartMs ?? 0).toBeLessThanOrEqual(3 * frame + 0.5);
      }
      expect(score.releaseLandingErr ?? 0).toBeLessThanOrEqual(1);
      expect(score.releaseJump ?? 0).toBeLessThanOrEqual(1);
      expect(score.tailMaxGap).toBeLessThanOrEqual(1);
      expect(score.earlyAttachMs).toBeLessThanOrEqual(frame + 0.5);
    });
  }
});
