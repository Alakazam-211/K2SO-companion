import { describe, expect, it } from "vitest";
import { stripClock, tallyBits, threadStripView } from "./threadStrip";
import type { ThreadTurn } from "./threadTurn";

const T0 = 1_000_000;

function turn(over: Partial<ThreadTurn> = {}): ThreadTurn {
  return {
    turnId: "t",
    state: "working",
    phase: "working",
    startedAt: T0,
    phaseSince: T0,
    line: null,
    subagents: 0,
    subagentsDone: 0,
    background: 0,
    tally: { read: 0, search: 0, cmd: 0, edit: 0 },
    waitingOn: null,
    end: null,
    rev: 1,
    skewMs: 0,
    ...over,
  };
}

describe("stripClock", () => {
  it("formats seconds, minutes and hours", () => {
    expect(stripClock(8_400)).toBe("8s");
    expect(stripClock(65_000)).toBe("1m 05s");
    expect(stripClock(3_720_000)).toBe("1h 02m");
    expect(stripClock(-5)).toBe("0s");
  });
});

describe("tallyBits", () => {
  it("capitalises the first bit and pluralises", () => {
    expect(tallyBits({ read: 3, search: 1, cmd: 2, edit: 0 })).toEqual([
      "Read 3 files",
      "searched 1 time",
      "ran 2 commands",
    ]);
    expect(tallyBits({ read: 0, search: 0, cmd: 0, edit: 1 })).toEqual(["Edited 1 file"]);
  });
});

describe("threadStripView", () => {
  it("says Working once when the step is unknown", () => {
    const v = threadStripView(turn(), T0 + 12_000);
    expect(v?.label).toBe("Working");
    expect(v?.since).toBe("12s");
    expect(v?.step).toBeNull();
  });

  it("lets a tool line speak instead of the word", () => {
    const v = threadStripView(
      turn({ phase: "tool", line: "Running `npm test`", phaseSince: T0 + 10_000 }),
      T0 + 14_000
    );
    expect(v?.label).toBe("");
    expect(v?.step).toEqual({ kind: "line", text: "Running `npm test`", elapsed: "4s" });
    expect(v?.ariaLabel).toContain("Running npm test");
  });

  it("times thinking", () => {
    const v = threadStripView(turn({ phase: "thinking", phaseSince: T0 + 2_000 }), T0 + 10_000);
    expect(v?.step).toEqual({ kind: "thinking", text: "Thinking… 8s", elapsed: null });
  });

  it("states a wait as a fact", () => {
    const v = threadStripView(
      turn({ state: "needs-you", phase: "waiting", waitingOn: "question" }),
      T0 + 62_000
    );
    expect(v?.tone).toBe("needs-you");
    expect(v?.label).toBe("Needs you");
    expect(v?.step?.text).toBe("Stuck on a question");
    expect(v?.since).toBe("1m 02s");
  });

  it("corrects the clock by the server skew", () => {
    const v = threadStripView(turn({ skewMs: 5_000 }), T0);
    expect(v?.since).toBe("5s");
  });

  it("shows children after a reply, with no step", () => {
    const v = threadStripView(
      turn({
        phase: "children",
        subagents: 2,
        subagentsDone: 1,
        background: 1,
        tally: { read: 1, search: 0, cmd: 0, edit: 0 },
      }),
      T0 + 250_000
    );
    expect(v?.label).toBe("2 subagents running, 1 done · 1 background task");
    expect(v?.since).toBe("4m 10s");
    expect(v?.step).toBeNull();
    expect(v?.tally).toEqual(["Read 1 file"]);
  });

  it("adds counts to the tally while the lead works", () => {
    const v = threadStripView(
      turn({ subagents: 1, tally: { read: 0, search: 0, cmd: 2, edit: 0 } }),
      T0
    );
    expect(v?.tally).toEqual(["Ran 2 commands", "1 subagent running"]);
  });

  it("hides an ended turn, except a brief Stopped", () => {
    expect(
      threadStripView(turn({ end: { reason: "reply", detail: null, at: T0 + 5_000 } }), T0 + 5_000)
    ).toBeNull();
    const stopped = turn({ end: { reason: "interrupted", detail: null, at: T0 + 14_000 } });
    expect(threadStripView(stopped, T0 + 15_000)?.label).toBe("Stopped");
    expect(threadStripView(stopped, T0 + 15_000)?.since).toBe("stopped after 14s");
    expect(threadStripView(stopped, T0 + 17_500)).toBeNull();
  });

  it("reports minutes without an update when stale", () => {
    // phaseSince = staleSince = last evidence + 30m.
    const v = threadStripView(
      turn({ state: "unverifiable", phase: "stale", phaseSince: T0 + 30 * 60_000 }),
      T0 + 34 * 60_000
    );
    expect(v?.label).toBe("No update in 34m");
    expect(v?.tone).toBe("unverifiable");
  });
});
