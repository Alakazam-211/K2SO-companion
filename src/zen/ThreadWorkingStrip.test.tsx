// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DRAWER_EXPANDED_KEY,
  DRAWER_MS,
  ThreadWorkingStrip,
} from "./ThreadWorkingStrip";
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

const busy = (over: Partial<ThreadTurn> = {}) =>
  turn({
    phase: "tool",
    line: "Running `npm test`",
    phaseSince: T0 + 2_000,
    subagents: 2,
    subagentsDone: 1,
    background: 1,
    tally: { read: 3, search: 1, cmd: 2, edit: 0 },
    ...over,
  });

const strip = () => screen.getByTestId("thread-working-strip");
const toggle = () => screen.getByTestId("thread-strip-toggle");

function reducedMotion(on: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 72_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
});

describe("ThreadWorkingStrip drawer", () => {
  it("is one line: pulse, step with code, emoji counters (zeros hidden) and an m:ss clock", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    expect(screen.getByTestId("thread-strip-line")).not.toBeNull();
    expect(screen.queryByTestId("thread-strip-detail")).toBeNull();
    const step = screen.getByTestId("thread-strip-step-text");
    expect(step.textContent).toBe("Running npm test");
    expect(step.querySelector("code")?.textContent).toBe("npm test");
    expect(step.className).toContain("text-ellipsis");
    expect(step.className).toContain("whitespace-nowrap");
    const counters = screen.getByTestId("thread-strip-counters");
    expect(counters.className).toContain("tabular-nums");
    expect(counters.className).toContain("flex-none");
    const shown = Array.from(counters.querySelectorAll("[aria-hidden='true']")).map((n) => n.textContent);
    expect(shown).toEqual(["🤖2✓1", "⚙️1", "📄3", "🔍1", "⌨️2"]);
    expect(screen.queryByTestId("thread-strip-count-edit")).toBeNull();
    expect(screen.getByTestId("thread-strip-since").textContent).toBe("1:12");
  });

  it("keeps words for screen readers: a full-sentence label and hidden text per counter", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    expect(toggle().getAttribute("aria-label")).toBe(
      "Agent working, 1m 12s since your message: Running npm test"
    );
    const sub = screen.getByTestId("thread-strip-count-subagents");
    expect(sub.querySelector("[aria-hidden='true']")?.textContent).toBe("🤖2✓1");
    const words = sub.querySelector(".sr-only");
    expect(words?.textContent).toBe("2 subagents running, 1 done");
    expect(screen.getByTestId("thread-strip-count-read").querySelector(".sr-only")?.textContent).toBe(
      "read 3 files"
    );
  });

  it("scales the step with Settings → Text Size", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    expect(screen.getByTestId("thread-strip-step-text").style.fontSize).toContain("--zen-text-scale");
  });

  it("a narrow drawer drops ✓done, search and read before commands; subagents and background stay", () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-testid") === "thread-strip-toggle" ? 230 : 0;
      },
    });
    render(<ThreadWorkingStrip turn={busy()} />);
    const keys = Array.from(screen.getByTestId("thread-strip-counters").children).map((n) =>
      n.getAttribute("data-testid")
    );
    expect(keys).toContain("thread-strip-count-subagents");
    expect(keys).toContain("thread-strip-count-background");
    expect(keys).not.toContain("thread-strip-count-search");
    expect(keys).not.toContain("thread-strip-count-read");
    expect(screen.getByTestId("thread-strip-count-subagents").textContent).not.toContain("✓");
    // The step keeps its slot and truncates.
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Running npm test");
  });

  it("children phase: Replied, the counters and the clock", () => {
    render(
      <ThreadWorkingStrip
        turn={turn({ phase: "children", subagents: 1, background: 2, tally: { read: 1, search: 0, cmd: 0, edit: 0 } })}
      />
    );
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Replied");
    expect(screen.getByTestId("thread-strip-counters").textContent).toContain("🤖1");
    expect(screen.getByTestId("thread-strip-counters").textContent).toContain("⚙️2");
    expect(screen.getByTestId("thread-strip-since").textContent).toBe("1:12");
    expect(toggle().getAttribute("aria-label")).toMatch(/^Agent replied; 1 subagent running/);
  });

  it("unverifiable is dashed with No update in Nm", () => {
    vi.setSystemTime(T0 + 34 * 60_000);
    render(
      <ThreadWorkingStrip turn={turn({ state: "unverifiable", phase: "stale", phaseSince: T0 + 30 * 60_000 })} />
    );
    expect(toggle().style.borderStyle).toBe("dashed");
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("No update in 34m");
  });

  it("is a drawer tile: top corners rounded, bottom square with no bottom rim, no gap below", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    const tile = toggle();
    expect(tile.className).toContain("k2-tile");
    expect(tile.className).toContain("k2-tile-sheet");
    expect(tile.style.borderRadius).toBe(
      "var(--k2-drawer-radius, 15px) var(--k2-drawer-radius, 15px) 0 0"
    );
    // Its bottom tucks behind the field by the slot's tuck; nothing spaces it off.
    expect(tile.style.paddingBottom).toBe("var(--k2-drawer-tuck, 0px)");
    for (const el of [strip(), tile]) {
      expect(el.className).not.toMatch(/(^|\s)(mb|pb|my|py)-/);
      expect(el.style.marginBottom).toBe("");
    }
    expect(strip().style.paddingBottom).toBe("");
  });

  it("slides up when a turn starts and down when it ends, then unmounts", () => {
    const space = vi.fn();
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} onSpace={space} />);
    expect(strip().className).toBe("k2-drawer-slide-in");
    expect(space).toHaveBeenLastCalledWith(32);
    rerender(<ThreadWorkingStrip turn={null} onSpace={space} />);
    expect(strip().className).toBe("k2-drawer-slide-out");
    expect(strip().getAttribute("data-leaving")).toBe("true");
    expect(space).toHaveBeenLastCalledWith(0);
    act(() => vi.advanceTimersByTime(DRAWER_MS + 100));
    expect(screen.queryByTestId("thread-working-strip")).toBeNull();
  });

  it("fades instead under reduced motion, with no height animation", () => {
    reducedMotion(true);
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} />);
    expect(strip().className).toBe("k2-drawer-fade-in");
    expect(toggle().style.transition).toBe("none");
    rerender(<ThreadWorkingStrip turn={null} />);
    expect(strip().className).toBe("k2-drawer-fade-out");
  });

  it("a tap expands to the full detail in words, a second tap collapses, the choice persists", () => {
    const space = vi.fn();
    const { unmount } = render(<ThreadWorkingStrip turn={busy()} onSpace={space} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByTestId("thread-strip-line")).toBeNull();
    expect(screen.getByTestId("thread-strip-head").textContent).toBe(
      "Working · 1m 12s since your message"
    );
    expect(screen.getByTestId("thread-strip-step-full").textContent).toBe("Running npm test1m 10s");
    expect(screen.getByTestId("thread-strip-tally").textContent).toBe(
      "Read 3 files · searched 1 time · ran 2 commands"
    );
    expect(screen.getByTestId("thread-strip-children").textContent).toBe(
      "2 subagents running, 1 done · 1 background task"
    );
    expect(localStorage.getItem(DRAWER_EXPANDED_KEY)).toBe("1");
    // The room it takes grows with it.
    const expandedSpace = space.mock.calls[space.mock.calls.length - 1]?.[0] as number;
    expect(expandedSpace).toBeGreaterThan(32);
    unmount();

    // A new turn opens the way it was left.
    render(<ThreadWorkingStrip turn={busy()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("thread-strip-line")).not.toBeNull();
    expect(localStorage.getItem(DRAWER_EXPANDED_KEY)).toBe("0");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ThreadWorkingStrip turn={busy()} />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    vi.restoreAllMocks();
  });
});
