// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { scoreTrace, TRACE_VERSION, type KbTrace } from "../lib/kbDragScore";

const trace: KbTrace = {
  v: TRACE_VERSION,
  device: "iPhone",
  ios: "26.0",
  dpr: 3,
  refreshHz: 120,
  restTop: 508,
  padding: 64,
  clockErrMs: 0.5,
  samples: [
    [0, 508, 1000],
    [8.3, 512, 996],
    [16.7, 516, 992],
  ],
  page: [
    [0, 508, 1000],
    [8.3, 513, 996],
    [16.7, 516, 992],
  ],
  events: [{ t: 0, k: "attach", via: "touch" }],
};
const h = vi.hoisted(() => ({
  state: { on: false },
  setRecorderOn: vi.fn(),
  clearRecordedDrags: vi.fn(),
  drags: [] as unknown[],
}));
const { setRecorderOn, clearRecordedDrags } = h;
vi.mock("../lib/kbDragRecorder", () => ({
  recorderOn: () => h.state.on,
  setRecorderOn: (v: boolean) => h.setRecorderOn(v),
  recordedDrags: () => h.drags,
  clearRecordedDrags: () => h.clearRecordedDrags(),
  subscribeRecorder: () => () => {},
}));
h.drags = [{ trace, score: scoreTrace(trace) }];

import { KeyboardDragRow, scoreLines } from "./KeyboardDragDiagnostics";

afterEach(cleanup);

describe("KeyboardDragRow", () => {
  it("toggles the recorder, lists drags with a sparkline, clears, copies (textarea fallback)", () => {
    render(<KeyboardDragRow />);
    fireEvent.click(screen.getByRole("switch"));
    expect(setRecorderOn).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("kb-drag-toggle-panel"));
    const row = screen.getByTestId("kb-drag-row");
    expect(row.querySelector("svg path")).not.toBeNull();
    expect(row.textContent).toMatch(/3 frames · max 1px/);
    // No clipboard: the JSON shows in a selectable textarea.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    fireEvent.click(screen.getByTestId("kb-drag-copy"));
    const ta = screen.getByTestId("kb-drag-json") as HTMLTextAreaElement;
    expect(JSON.parse(ta.value).v).toBe(1);
    fireEvent.click(screen.getByTestId("kb-drag-clear"));
    expect(clearRecordedDrags).toHaveBeenCalled();
  });

  it("copies to the clipboard when it can", () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<KeyboardDragRow />);
    fireEvent.click(screen.getByTestId("kb-drag-toggle-panel"));
    fireEvent.click(screen.getByTestId("kb-drag-copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("kb-drag-json")).toBeNull();
  });

  it("scoreLines reads as two lines", () => {
    const [a, b] = scoreLines(scoreTrace(trace));
    expect(a).toMatch(/frames/);
    expect(b).toMatch(/correction/);
  });
});
