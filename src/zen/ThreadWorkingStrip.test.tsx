// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DRAWER_EXPANDED_KEY,
  DRAWER_MS,
  BRAILLE_FRAMES,
  SPINNER_STATIC,
  STRIP_ICON,
  TAG_H_PX,
  TAG_PAD_X_PX,
  SUPERSEDE_HOLD_MS,
  ThreadWorkingStrip,
  counterTagWidthPx,
} from "./ThreadWorkingStrip";
import { counterWidthPx } from "./threadStrip";

/** Vitest does not load CSS; the tag tests read the stylesheet as text. */
let drawerCss = "";
beforeAll(async () => {
  // @ts-expect-error Node fs — vitest runtime, not in app tsconfig libs
  const { readFileSync } = await import("fs");
  drawerCss = readFileSync("src/zen/threadDrawer.css", "utf8") as string;
});
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
    // Tinted per tag, not one muted colour for the row.
    expect(screen.getByTestId("thread-strip-counters").style.color).toBe("");
    expect(STRIP_ICON).toEqual({
      subagents: AgentIcon,
      background: CogIcon,
      read: FileIcon,
      search: SearchIcon,
      cmd: TerminalIcon,
      edit: PencilIcon,
    });
  });

  it("each counter is its own borderless pill tag holding its icon and number", () => {
    render(<ThreadWorkingStrip turn={busy({ tally: { read: 3, search: 1, cmd: 2, edit: 4 } })} />);
    const counters = screen.getByTestId("thread-strip-counters");
    const keys = ["subagents", "background", "read", "search", "cmd", "edit"];
    expect(Array.from(counters.children).map((n) => n.getAttribute("data-tag"))).toEqual(keys);
    for (const key of keys) {
      const tag = screen.getByTestId(`thread-strip-count-${key}`);
      expect(tag.parentElement).toBe(counters);
      expect(tag.className.split(" ")).toEqual(
        expect.arrayContaining(["k2-drawer-tag", "k2-drawer-count", `k2-drawer-tag-${key}`])
      );
      expect(tag.className).not.toMatch(/(^|\s)(border|outline|ring)(-|$|\s)/);
      expect(tag.style.border).toBe("");
      expect(tag.style.height).toBe(`${TAG_H_PX}px`);
      expect(tag.style.paddingLeft).toBe(`${TAG_PAD_X_PX}px`);
      expect(tag.style.paddingRight).toBe(`${TAG_PAD_X_PX}px`);
      // Icon and number inside the tag; only one tag per counter.
      expect(tag.querySelector("svg")).not.toBeNull();
      expect(tag.querySelector(".k2-drawer-tag")).toBeNull();
    }
    // The tag widths drive the overflow priority.
    const c = { key: "read" as const, count: 3, done: 0 };
    expect(counterTagWidthPx(c)).toBe(counterWidthPx(c, 12) + 2 * TAG_PAD_X_PX);
  });

  it("the subagent tag holds the agent icon, running spinner+count and done check+count together", () => {
    reducedMotion(false);
    render(<ThreadWorkingStrip turn={busy({ subagents: 1, subagentsDone: 2 })} />);
    const tag = screen.getByTestId("thread-strip-count-subagents");
    expect(tag.className).toContain("k2-drawer-tag-subagents");
    const run = screen.getByTestId("thread-strip-running");
    const done = screen.getByTestId("thread-strip-done");
    expect(tag.contains(run)).toBe(true);
    expect(tag.contains(done)).toBe(true);
    expect(tag.contains(run.querySelector("[data-testid='thread-strip-spinner']"))).toBe(true);
    expect(done.style.marginLeft).toBe("7px");
    expect(screen.getAllByTestId(/^thread-strip-count-/)).toHaveLength(5);
  });

  it("the tag CSS: no border or outline, pill radius, a tint per kind, rgba fallbacks before color-mix", () => {
    const rule = (sel: string) => {
      const m = drawerCss.match(new RegExp(`(^|\\n)${sel.replace(/[.-]/g, "\\$&")} \\{([^}]*)\\}`));
      return m?.[2] ?? "";
    };
    const base = rule(".k2-drawer-tag");
    expect(base).toMatch(/border: 0;/);
    expect(base).toMatch(/outline: 0;/);
    expect(base).toMatch(/border-radius: 9999px;/);
    expect(base).toMatch(/background: var\(--k2-tag-fill\)/);
    expect(base).toMatch(/color: var\(--k2-tag-ink\)/);
    const hues: Record<string, string> = {
      subagents: "var(--accent)",
      cmd: "var(--success)",
      edit: "var(--warning)",
      read: "#2dd4bf",
      search: "var(--group-5)",
      background: "var(--text-muted)",
    };
    const fills = new Set<string>();
    for (const [key, hue] of Object.entries(hues)) {
      const r = rule(`.k2-drawer-tag-${key}`);
      expect(r).toContain(`--k2-tag-hue: ${hue};`);
      const fill = r.match(/--k2-tag-fill: (rgba\([^)]*\));/)?.[1];
      expect(fill).toBeTruthy();
      expect(r).toMatch(/--k2-tag-ink: #[0-9a-f]{6};/);
      fills.add(fill!);
    }
    expect(fills.size).toBe(6);
    // color-mix only inside @supports, after the plain fallbacks.
    const supports = drawerCss.indexOf("@supports (color: color-mix(");
    expect(supports).toBeGreaterThan(drawerCss.indexOf(".k2-drawer-tag-background {"));
    expect(drawerCss.slice(0, supports)).not.toContain("color-mix(");
    expect(drawerCss).not.toMatch(/\.k2-drawer-[a-z-]+ \{[^}]*\bborder: [^0]/);
  });

  it("the tool call in the step is a neutral borderless code tag, collapsed and expanded", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    const check = (code: Element | null) => {
      expect(code?.textContent).toBe("npm test");
      expect(code?.tagName).toBe("CODE");
      expect(code?.className).toContain("k2-drawer-tag");
      expect(code?.className).toContain("k2-drawer-code");
      expect(code?.className).toContain("font-mono");
      expect(code?.className).not.toMatch(/(^|\s)(border|outline|ring)(-|$|\s)/);
      expect((code as HTMLElement).style.border).toBe("");
      expect((code as HTMLElement).style.background).toBe("");
    };
    check(screen.getByTestId("thread-strip-step-text").querySelector("code"));
    fireEvent.click(toggle());
    check(screen.getByTestId("thread-strip-step-full").querySelector("code"));
    const code = drawerCss.match(/\n\.k2-drawer-code \{([^}]*)\}/g)!.join("");
    expect(code).toContain("--k2-tag-fill: rgba(228, 228, 231, 0.11);");
    expect(code).toContain("color: inherit;");
  });

  it("the clock is plain text, not a tag: right-aligned and tabular", () => {
    render(<ThreadWorkingStrip turn={busy()} />);
    const clock = screen.getByTestId("thread-strip-since");
    expect(clock.className).not.toContain("k2-drawer-tag");
    expect(clock.className).toContain("tabular-nums");
    expect(clock.className).toContain("text-right");
    expect(clock.parentElement).toBe(screen.getByTestId("thread-strip-line"));
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

describe("ThreadWorkingStrip across your sends", () => {
  // What K2 sends when you post while the agent works: the turn on screen
  // ends `superseded` (state stopped) at once, and the next turn's first
  // frame follows once your message is delivered (~0.5-1s).
  const superseded = (over: Partial<ThreadTurn> = {}) =>
    busy({ state: "stopped", end: { reason: "superseded", detail: null, at: T0 + 72_000 }, rev: 2, ...over });
  const next = (over: Partial<ThreadTurn> = {}) =>
    turn({ turnId: "t2", startedAt: T0 + 72_000, phaseSince: T0 + 72_000, rev: 1, ...over });

  it("a send while working never hides it: held through the supersede, the next turn swaps in place", () => {
    const space = vi.fn();
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} onSpace={space} />);
    const el = strip();
    rerender(<ThreadWorkingStrip turn={superseded()} onSpace={space} />);
    expect(strip()).toBe(el);
    expect(strip().getAttribute("data-leaving")).toBeNull();
    expect(strip().className).toBe("k2-drawer-slide-in");
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Running npm test");
    expect(space).toHaveBeenLastCalledWith(32);
    // The clock keeps counting while held.
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("thread-strip-since").textContent).toBe("1:13");
    rerender(<ThreadWorkingStrip turn={next()} onSpace={space} />);
    expect(strip()).toBe(el);
    expect(strip().getAttribute("data-leaving")).toBeNull();
    expect(strip().className).toBe("k2-drawer-slide-in");
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Working");
    expect(screen.getByTestId("thread-strip-since").textContent).toBe("0:01");
    expect(space).not.toHaveBeenCalledWith(0);
    // Past the hold it is just the new turn: nothing left to time out.
    act(() => vi.advanceTimersByTime(SUPERSEDE_HOLD_MS + 500));
    expect(strip()).toBe(el);
    expect(strip().getAttribute("data-leaving")).toBeNull();
  });

  it("a {turn:null} catch-up during the hold does not take it down early", () => {
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} />);
    rerender(<ThreadWorkingStrip turn={superseded()} />);
    rerender(<ThreadWorkingStrip turn={null} />);
    expect(strip().getAttribute("data-leaving")).toBeNull();
    rerender(<ThreadWorkingStrip turn={next()} />);
    expect(strip().getAttribute("data-leaving")).toBeNull();
  });

  it("a new turnId while working swaps content without hiding", () => {
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} />);
    const el = strip();
    rerender(<ThreadWorkingStrip turn={next({ phase: "thinking" })} />);
    expect(strip()).toBe(el);
    expect(strip().className).toBe("k2-drawer-slide-in");
    expect(strip().getAttribute("data-leaving")).toBeNull();
    expect(screen.getByTestId("thread-strip-step-text").textContent).toMatch(/^Thinking/);
  });

  it("no next turn within the hold: it slides away then", () => {
    const space = vi.fn();
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} onSpace={space} />);
    rerender(<ThreadWorkingStrip turn={superseded()} onSpace={space} />);
    act(() => vi.advanceTimersByTime(SUPERSEDE_HOLD_MS - 100));
    expect(strip().getAttribute("data-leaving")).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(strip().getAttribute("data-leaving")).toBe("true");
    expect(space).toHaveBeenLastCalledWith(0);
    act(() => vi.advanceTimersByTime(DRAWER_MS + 100));
    expect(screen.queryByTestId("thread-working-strip")).toBeNull();
    // The same ended turn re-rendered does not hold again.
    rerender(<ThreadWorkingStrip turn={superseded({ rev: 3 })} onSpace={space} />);
    expect(screen.queryByTestId("thread-working-strip")).toBeNull();
  });

  it("a real end still hides at once; an interrupt still shows Stopped for the linger", () => {
    const { rerender } = render(<ThreadWorkingStrip turn={busy()} />);
    rerender(<ThreadWorkingStrip turn={busy({ state: "idle", end: { reason: "done", detail: null, at: T0 + 72_000 }, rev: 2 })} />);
    expect(strip().getAttribute("data-leaving")).toBe("true");
    act(() => vi.advanceTimersByTime(DRAWER_MS + 100));
    expect(screen.queryByTestId("thread-working-strip")).toBeNull();

    rerender(<ThreadWorkingStrip turn={busy({ turnId: "t3", rev: 1 })} />);
    rerender(<ThreadWorkingStrip turn={busy({ turnId: "t3", state: "stopped", end: { reason: "interrupted", detail: null, at: T0 + 72_000 }, rev: 2 })} />);
    expect(screen.getByTestId("thread-strip-step-text").textContent).toBe("Stopped");
    act(() => vi.advanceTimersByTime(3_100));
    expect(strip().getAttribute("data-leaving")).toBe("true");
  });

  it("a supersede of a turn never shown holds nothing", () => {
    const { rerender } = render(<ThreadWorkingStrip turn={null} />);
    rerender(<ThreadWorkingStrip turn={superseded()} />);
    expect(screen.queryByTestId("thread-working-strip")).toBeNull();
  });
});
