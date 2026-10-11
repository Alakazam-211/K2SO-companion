// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadWorkingStrip } from "./ThreadWorkingStrip";
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 12_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ThreadWorkingStrip", () => {
  it("spans the full column width with no max-width", () => {
    render(<ThreadWorkingStrip turn={turn({ phase: "tool", line: "Running `npm test`" })} />);
    const cls = screen.getByTestId("thread-working-strip").className;
    expect(cls).toContain("self-stretch");
    expect(cls).toContain("w-full");
    expect(cls).not.toMatch(/max-w-/);
    expect(cls).not.toContain("self-start");
  });

  it("truncates the step and right-aligns tabular clocks", () => {
    render(
      <ThreadWorkingStrip
        turn={turn({ phase: "tool", line: "Running `npm test`", phaseSince: T0 + 2_000 })}
      />
    );
    const step = screen.getByTestId("thread-strip-step-text").className;
    expect(step).toContain("whitespace-nowrap");
    expect(step).toContain("text-ellipsis");
    for (const id of ["thread-strip-since", "thread-strip-elapsed"]) {
      const cls = screen.getByTestId(id).className;
      expect(cls).toContain("ml-auto");
      expect(cls).toContain("tabular-nums");
    }
  });

  it("holds the step and tally rows while live so the height stays put", () => {
    render(<ThreadWorkingStrip turn={turn()} />);
    expect(screen.queryByTestId("thread-strip-step")).toBeNull();
    expect(screen.getByTestId("thread-strip-step-slot")).not.toBeNull();
    expect(screen.getByTestId("thread-strip-tally-slot")).not.toBeNull();
  });
});
