import { describe, expect, it } from "vitest";
import {
  counterSpoken,
  counterWidthPx,
  fitStripCounters,
  stripClock,
  stripClockShort,
  stripCounters,
  tallyBits,
  threadDrawerLine,
  threadStripView,
} from "./threadStrip";
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

/** "subagents2+1", "read3": a counter's key, number and done count. */
const label = (c: { key: string; count: number; done: number }) =>
  `${c.key}${c.count}${c.done ? `+${c.done}` : ""}`;

describe("drawer line", () => {
  const busy = turn({
    phase: "tool",
    line: "Running `npm test`",
    subagents: 2,
    subagentsDone: 1,
    background: 1,
    tally: { read: 3, search: 1, cmd: 2, edit: 1 },
  });

  it("maps counts to counters, hides zeros, in display order", () => {
    const c = stripCounters(busy);
    expect(c.map(label)).toEqual(["subagents2+1", "background1", "read3", "search1", "cmd2", "edit1"]);
    expect(stripCounters(turn({ tally: { read: 2, search: 0, cmd: 0, edit: 0 } })).map(label)).toEqual([
      "read2",
    ]);
    expect(stripCounters(turn())).toEqual([]);
  });

  it("subagents: a running group and a done group, each only above zero", () => {
    expect(stripCounters(turn({ subagents: 1 })).map(label)).toEqual(["subagents1"]);
    expect(stripCounters(turn({ subagents: 0, subagentsDone: 3 })).map(label)).toEqual(["subagents0+3"]);
    expect(stripCounters(turn({ subagents: 1, subagentsDone: 2 })).map(label)).toEqual(["subagents1+2"]);
    const l = threadDrawerLine(turn({ subagents: 1, subagentsDone: 2 }), T0 + 1_000)!;
    expect(l.detail.children).toBe("1 subagent running, 2 done");
  });

  it("speaks each counter in words", () => {
    expect(stripCounters(busy).map(counterSpoken)).toEqual([
      "2 subagents running, 1 done",
      "1 background task",
      "read 3 files",
      "searched 1 time",
      "ran 2 commands",
      "edited 1 file",
    ]);
    expect(counterSpoken({ key: "subagents", count: 0, done: 2 })).toBe("2 subagents done");
  });

  it("drops the done group, then search, read, edit, commands; subagents and background stay", () => {
    const all = stripCounters(busy);
    const each = () => 10; // every counter 10px wide, 6px gaps
    const keys = (budget: number) =>
      fitStripCounters(all, budget, each).map((c) => `${c.key}${c.done ? "+done" : ""}`);
    expect(keys(Infinity)).toEqual(["subagents+done", "background", "read", "search", "cmd", "edit"]);
    expect(keys(90)).toEqual(["subagents+done", "background", "read", "search", "cmd", "edit"]);
    // One px short: the done group goes first, then search (a flat
    // measure, so dropping done alone did not help).
    expect(keys(89)).toEqual(["subagents", "background", "read", "cmd", "edit"]);
    expect(keys(74)).toEqual(["subagents", "background", "read", "cmd", "edit"]);
    expect(keys(58)).toEqual(["subagents", "background", "cmd", "edit"]);
    expect(keys(42)).toEqual(["subagents", "background", "cmd"]);
    expect(keys(26)).toEqual(["subagents", "background"]);
    expect(keys(0)).toEqual(["subagents", "background"]);
  });

  it("the done group shows only when it fits; with nothing running it is the counter and stays", () => {
    const all = stripCounters(turn({ subagents: 2, subagentsDone: 1 }));
    expect(fitStripCounters(all, 100).map(label)).toEqual(["subagents2+1"]);
    expect(fitStripCounters(all, 10).map(label)).toEqual(["subagents2"]);
    const doneOnly = stripCounters(turn({ subagents: 0, subagentsDone: 4 }));
    expect(fitStripCounters(doneOnly, 0).map(label)).toEqual(["subagents0+4"]);
  });

  it("a counter is as wide as its icon, a gap and its number; subagents add spinner and check", () => {
    const n = (count: number, done = 0) => counterWidthPx({ key: "subagents", count, done });
    expect(counterWidthPx({ key: "read", count: 3, done: 0 })).toBe(13 + 2 + 8);
    expect(n(1)).toBe(13 + 2 + 10 + 8);
    expect(n(1, 2)).toBe(n(1) + 7 + 11 + 2 + 8);
    expect(n(0, 2)).toBe(13 + 2 + 11 + 2 + 8);
  });

  it("one line: step, counters and an m:ss clock", () => {
    const l = threadDrawerLine(busy, T0 + 72_000)!;
    expect(l.step.text).toBe("Running `npm test`");
    expect(l.clock).toBe("1:12");
    expect(l.ariaLabel).toBe(
      "Agent working, 1m 12s since your message: Running npm test"
    );
    expect(l.detail.head).toBe("Working · 1m 12s since your message");
    expect(l.detail.step?.elapsed).toBe("1m 12s");
    expect(l.detail.tally).toBe("Read 3 files · searched 1 time · ran 2 commands · edited 1 file");
    expect(l.detail.children).toBe("2 subagents running, 1 done · 1 background task");
    expect(stripClockShort(3_723_000)).toBe("1:02:03");
    expect(stripClockShort(8_000)).toBe("0:08");
  });

  it("the state word when there is no step; thinking times itself", () => {
    expect(threadDrawerLine(turn(), T0 + 5_000)!.step.text).toBe("Working");
    expect(threadDrawerLine(turn({ phase: "thinking", phaseSince: T0 + 2_000 }), T0 + 10_000)!.step.text).toBe(
      "Thinking… 8s"
    );
    expect(threadDrawerLine(turn({ phase: "delivering" }), T0 + 1_000)!.step.text).toBe("Delivering…");
    expect(
      threadDrawerLine(turn({ state: "needs-you", phase: "waiting", waitingOn: "permission" }), T0 + 1_000)!.step
        .text
    ).toBe("Stuck on a permission prompt");
  });

  it("children phase: Replied, the counters and the clock", () => {
    const l = threadDrawerLine(
      turn({ phase: "children", subagents: 1, background: 2, tally: { read: 1, search: 0, cmd: 0, edit: 0 } }),
      T0 + 30_000
    )!;
    expect(l.step.text).toBe("Replied");
    expect(l.counters.map(label)).toEqual(["subagents1", "background2", "read1"]);
    expect(l.clock).toBe("0:30");
    expect(l.ariaLabel).toMatch(/^Agent replied; 1 subagent running/);
    expect(l.detail.head).toBe("Replied · 30s since your message");
  });

  it("unverifiable says how long; a stop lingers as Stopped", () => {
    const stale = threadDrawerLine(
      turn({ state: "unverifiable", phase: "stale", phaseSince: T0 + 30 * 60_000 }),
      T0 + 34 * 60_000
    )!;
    expect(stale.tone).toBe("unverifiable");
    expect(stale.step.text).toBe("No update in 34m");
    const stopped = threadDrawerLine(
      turn({ state: "stopped", end: { reason: "interrupted", detail: null, at: T0 + 12_000 } }),
      T0 + 13_000
    )!;
    expect(stopped.step.text).toBe("Stopped");
    expect(stopped.clock).toBe("0:12");
  });
});
