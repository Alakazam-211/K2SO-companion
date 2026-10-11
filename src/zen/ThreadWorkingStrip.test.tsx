// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DRAWER_EXPANDED_KEY,
  DRAWER_MS,
  BRAILLE_FRAMES,
  SPINNER_STATIC,
  STRIP_ICON,
  ThreadWorkingStrip,
} from "./ThreadWorkingStrip";
import { AgentIcon, CogIcon, FileIcon, PencilIcon, SearchIcon, TerminalIcon } from "./icons";

/** A counter's visible number(s): running, then done (subagents). */
const nums = (key: string) => {
  const el = screen.getByTestId(`thread-strip-count-${key}`);
  if (key !== "subagents") return el.querySelector(":scope > [aria-hidden='true']")?.textContent;
  const run = el.querySelector("[data-testid='thread-strip-running']");
  const done = el.querySelector("[data-testid='thread-strip-done']");
  return [run?.lastChild?.textContent ?? null, done?.lastChild?.textContent ?? null];
};
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
  it("is one line: pulse, step with code, icon counters (zeros hidden) and an m:ss clock", () => {
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
    const icons = Array.from(counters.children).map((n) => n.querySelector("svg")?.getAttribute("data-k2-icon"));
    expect(icons).toEqual(["agent", "cog", "file", "search", "terminal"]);
    expect(nums("subagents")).toEqual(["2", "1"]);
    expect(["background", "read", "search", "cmd"].map(nums)).toEqual(["1", "3", "1", "2"]);
    expect(screen.queryByTestId("thread-strip-count-edit")).toBeNull();
    expect(screen.getByTestId("thread-strip-since").textContent).toBe("1:12");
  });

  it("draws each counter with the app's shared icon: stroked, muted, aria-hidden, ~13px", () => {
    render(<ThreadWorkingStrip turn={busy({ tally: { read: 3, search: 1, cmd: 2, edit: 4 } })} />);
    const want = {
      subagents: "agent",
      background: "cog",
      read: "file",
      search: "search",
      cmd: "terminal",
      edit: "pencil",
    } as const;
    for (const [key, icon] of Object.entries(want)) {
      const svg = screen.getByTestId(`thread-strip-count-${key}`).querySelector("svg")!;
      expect(svg.getAttribute("data-k2-icon")).toBe(icon);
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("width")).toBe("13");
      // The number right after the icon (subagents: after the spinner).
      if (key !== "subagents") expect(svg.nextSibling?.textContent).toMatch(/^\d+$/);
    }
    // Muted: the counters inherit the clock's colour.
    expect(screen.getByTestId("thread-strip-counters").style.color).toBe("var(--text-muted)");
    expect(STRIP_ICON).toEqual({
      subagents: AgentIcon,
      background: CogIcon,
      read: FileIcon,
      search: SearchIcon,
      cmd: TerminalIcon,
      edit: PencilIcon,
    });
  });

  it("no emoji anywhere in the drawer, collapsed or expanded", () => {
    const emoji = /[\p{Extended_Pictographic}\u{FE0F}\u2713\u2714]/u;
    render(<ThreadWorkingStrip turn={busy({ tally: { read: 3, search: 1, cmd: 2, edit: 4 } })} />);
    expect(strip().textContent).not.toMatch(emoji);
    fireEvent.click(toggle());
    expect(strip().textContent).not.toMatch(emoji);
  });

  it("subagents: agent icon, a braille spinner by the running count, a gap, a check by the done count", () => {
    reducedMotion(false);
    render(<ThreadWorkingStrip turn={busy({ subagents: 1, subagentsDone: 2 })} />);
    const sub = screen.getByTestId("thread-strip-count-subagents");
    const visible = sub.querySelector(":scope > [aria-hidden='true']")!;
    expect(visible.firstElementChild?.getAttribute("data-k2-icon")).toBe("agent");
    const run = screen.getByTestId("thread-strip-running");
    const spinner = run.querySelector("[data-testid='thread-strip-spinner']")!;
    expect(run.firstElementChild).toBe(spinner);
    expect(spinner.className).toContain("k2-braille-spinner");
    expect(spinner.getAttribute("data-static")).toBeNull();
    expect(spinner.textContent).toBe(BRAILLE_FRAMES);
    expect(run.lastChild?.textContent).toBe("1");
    const done = screen.getByTestId("thread-strip-done");
    expect(done.firstElementChild?.getAttribute("data-k2-icon")).toBe("check");
    expect(done.lastChild?.textContent).toBe("2");
    expect(done.style.marginLeft).toBe("7px");
    expect(run.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sub.querySelector(".sr-only")?.textContent).toBe("1 subagent running, 2 done");
  });

  it("each subagent group hides at zero; done alone keeps the agent icon before it", () => {
    const { unmount } = render(<ThreadWorkingStrip turn={busy({ subagents: 2, subagentsDone: 0 })} />);
    expect(screen.getByTestId("thread-strip-running")).not.toBeNull();
    expect(screen.queryByTestId("thread-strip-done")).toBeNull();
    unmount();
    render(<ThreadWorkingStrip turn={busy({ subagents: 0, subagentsDone: 3 })} />);
    expect(screen.queryByTestId("thread-strip-running")).toBeNull();
    expect(screen.queryByTestId("thread-strip-spinner")).toBeNull();
    const done = screen.getByTestId("thread-strip-done");
    expect(done.style.marginLeft).toBe("0px");
    const visible = screen.getByTestId("thread-strip-count-subagents").querySelector(":scope > [aria-hidden='true']")!;
    expect(visible.firstElementChild?.getAttribute("data-k2-icon")).toBe("agent");
    expect(nums("subagents")).toEqual([null, "3"]);
    cleanup();
    render(<ThreadWorkingStrip turn={busy({ subagents: 0, subagentsDone: 0 })} />);
    expect(screen.queryByTestId("thread-strip-count-subagents")).toBeNull();
  });

  it("reduced motion: the spinner is a still dot", () => {
    reducedMotion(true);
    render(<ThreadWorkingStrip turn={busy({ subagents: 1 })} />);
    const spinner = screen.getByTestId("thread-strip-spinner");
    expect(spinner.getAttribute("data-static")).toBe("true");
    expect(spinner.textContent).toBe(SPINNER_STATIC);
  });

  it("keeps words for screen readers: a full-sentence label and hidden text per counter", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    expect(toggle().getAttribute("aria-label")).toBe(
      "Agent working, 1m 12s since your message: Running npm test"
    );
    const sub = screen.getByTestId("thread-strip-count-subagents");
    expect(sub.querySelector(":scope > [aria-hidden='true']")).not.toBeNull();
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

  it("a narrow drawer drops the done group, search and read before commands; subagents and background stay", () => {
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
    expect(screen.queryByTestId("thread-strip-done")).toBeNull();
    expect(screen.getByTestId("thread-strip-running")).not.toBeNull();
    // The step keeps its slot and truncates.
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Running npm test");
  });

  it("children phase: Replied, the counters and the clock", () => {
    render(
      <ThreadWorkingStrip
        turn={turn({
          phase: "children",
          subagents: 1,
          subagentsDone: 2,
          background: 2,
          tally: { read: 1, search: 0, cmd: 0, edit: 0 },
        })}
      />
    );
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Replied");
    const icons = Array.from(screen.getByTestId("thread-strip-counters").children).map((n) =>
      n.querySelector("svg")?.getAttribute("data-k2-icon")
    );
    expect(icons).toEqual(["agent", "cog", "file"]);
    expect(nums("subagents")).toEqual(["1", "2"]);
    expect(nums("background")).toBe("2");
    expect(nums("read")).toBe("1");
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
