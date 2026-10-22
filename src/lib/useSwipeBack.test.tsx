// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useSwipeBack } from "./useSwipeBack";
import { releaseAnimation } from "./swipeBack";

// jsdom innerWidth: 1024 → distance threshold ≈ 358px.
const W = 1024;

function Screen({
  onBack,
  onDragChange,
}: {
  onBack: () => void;
  onDragChange?: (d: boolean) => void;
}) {
  const under = useRef<HTMLDivElement>(null);
  const ref = useSwipeBack(onBack, { onDragChange, underlay: () => under.current });
  return (
    <div>
      <div ref={under} data-testid="under" />
      <div ref={ref} data-testid="screen">
        <input data-testid="input" />
      </div>
    </div>
  );
}

/** Fire a touch event at clientX `x` with an explicit timeStamp (ms). */
function touch(
  kind: "touchStart" | "touchMove" | "touchEnd",
  el: HTMLElement,
  x: number,
  t: number
) {
  const pt = { clientX: x, clientY: 300 };
  const ev = createEvent[kind](el, {
    touches: kind === "touchEnd" ? [] : [pt],
    changedTouches: [pt],
  });
  Object.defineProperty(ev, "timeStamp", { value: t });
  act(() => {
    fireEvent(el, ev);
  });
}

/** Drag from the edge to `x` over `ms`, then lift `liftMs` later at `liftX`. */
function swipe(el: HTMLElement, path: Array<[number, number]>) {
  const [[x0, t0], ...rest] = path;
  touch("touchStart", el, x0, t0);
  const last = rest.pop()!;
  for (const [x, t] of rest) touch("touchMove", el, x, t);
  touch("touchEnd", el, last[0], last[1]);
}

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  window.matchMedia = ((q: string) => ({
    matches: reduced && q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const onBack = vi.fn();
  const onDragChange = vi.fn();
  render(<Screen onBack={onBack} onDragChange={onDragChange} />);
  return { onBack, onDragChange, el: screen.getByTestId("screen"), under: screen.getByTestId("under") };
}

describe("useSwipeBack release", () => {
  it("past the threshold: animates to the full width, THEN goes back", () => {
    const { onBack, onDragChange, el, under } = setup();
    touch("touchStart", el, 5, 0);
    touch("touchMove", el, 40, 100);
    touch("touchMove", el, 505, 1000);
    expect(el.style.transform).toBe("translateX(500px)");
    // The underlay trails with parallax + dim.
    expect(under.style.transform).toMatch(/^translateX\(-\d/);
    expect(Number(under.style.opacity)).toBeLessThan(1);
    // Held still, then lifted: completes on distance.
    touch("touchEnd", el, 505, 1300);
    const { durationMs } = releaseAnimation(500, W, 0);
    expect(el.style.transform).toBe(`translateX(${W}px)`);
    expect(el.style.transition).toBe(`transform ${durationMs}ms cubic-bezier(0.25, 0.25, 0.25, 1)`);
    // Underlay finishes its parallax/dim with the same animation.
    expect(under.style.transform).toBe("");
    expect(under.style.opacity).toBe("");
    expect(under.style.transition).toContain(`transform ${durationMs}ms`);
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(durationMs - 10);
    });
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onDragChange.mock.calls).toEqual([[true], [false]]);
    // Still mounted here (a screen that stays, e.g. the docs list): home.
    expect(el.style.transform).toBe("");
    expect(el.style.transition).toBe("");
    expect(under.style.transition).toBe("");
  });

  it("finishes on transitionend without waiting for the fallback timer", () => {
    const { onBack, el } = setup();
    swipe(el, [[5, 0], [40, 100], [505, 1000], [505, 1300]]);
    const ev = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(ev, "propertyName", { value: "transform" });
    act(() => {
      el.dispatchEvent(ev);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("an early release with a fast rightward flick completes", () => {
    const { onBack, el } = setup();
    // 80px in the last 60ms ≈ 1.33 px/ms, released at 105px (< threshold).
    swipe(el, [[5, 0], [25, 100], [65, 140], [105, 200], [105, 201]]);
    expect(el.style.transform).toBe(`translateX(${W}px)`);
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("a slow early release animates back to 0 and does not go back", () => {
    const { onBack, onDragChange, el, under } = setup();
    swipe(el, [[5, 0], [40, 100], [125, 1000], [125, 1400]]);
    // Animates home from 120px (not an instant reset).
    expect(el.style.transform).toBe("");
    expect(el.style.transition).toMatch(/^transform 180ms cubic-bezier/);
    expect(under.style.transition).toContain("transform 180ms");
    expect(onDragChange).toHaveBeenLastCalledWith(true);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onBack).not.toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    expect(el.style.transition).toBe("");
    expect(el.style.boxShadow).toBe("");
    expect(under.style.transform).toBe("");
    expect(under.style.opacity).toBe("");
  });

  it("a fast leftward flick cancels even past the threshold", () => {
    const { onBack, el } = setup();
    swipe(el, [[5, 0], [40, 100], [705, 1000], [600, 1050], [600, 1060]]);
    expect(el.style.transform).toBe("");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("ignores touches while a release animation runs", () => {
    const { onBack, el } = setup();
    swipe(el, [[5, 0], [40, 100], [505, 1000], [505, 1300]]);
    touch("touchStart", el, 5, 1310);
    touch("touchMove", el, 200, 1320);
    expect(el.style.transform).toBe(`translateX(${W}px)`);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("blurs the focused field on a completing release (keyboard dismisses)", () => {
    const { el } = setup();
    const input = screen.getByTestId("input") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    swipe(el, [[5, 0], [40, 100], [505, 1000], [505, 1300]]);
    expect(document.activeElement).not.toBe(input);
  });

  it("the keyboard drops as the screen starts to follow the finger", () => {
    const { el } = setup();
    const input = screen.getByTestId("input") as HTMLInputElement;
    input.focus();
    touch("touchStart", el, 5, 0);
    touch("touchMove", el, 40, 100);
    touch("touchMove", el, 200, 200);
    expect(document.activeElement).not.toBe(input);
  });

  it("a swipe that springs home gives the field its keyboard back; a completed one does not", () => {
    const { el } = setup();
    const input = screen.getByTestId("input") as HTMLInputElement;
    input.focus();
    swipe(el, [[5, 0], [40, 100], [125, 1000], [125, 1400]]);
    expect(document.activeElement).toBe(input);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    swipe(el, [[5, 2000], [40, 2100], [505, 3000], [505, 3300]]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(document.activeElement).not.toBe(input);
  });

  it("nothing focused: a cancel focuses nothing", () => {
    const { el } = setup();
    swipe(el, [[5, 0], [40, 100], [125, 1000], [125, 1400]]);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("useSwipeBack release, reduced motion", () => {
  it("complete: fades where it is (no slide, no jump), then goes back", () => {
    reduced = true;
    const { onBack, el } = setup();
    swipe(el, [[5, 0], [40, 100], [505, 1000], [505, 1300]]);
    expect(el.style.transform).toBe("translateX(500px)");
    expect(el.style.opacity).toBe("0");
    expect(el.style.transition).toBe("opacity 120ms linear");
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("cancel: fades out, returns home while invisible, fades back in", () => {
    reduced = true;
    const { onBack, el } = setup();
    swipe(el, [[5, 0], [40, 100], [125, 1000], [125, 1400]]);
    expect(el.style.transform).toBe("translateX(120px)");
    expect(el.style.opacity).toBe("0");
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(el.style.transform).toBe("");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(el.style.opacity).toBe("");
    expect(el.style.transition).toBe("");
    expect(onBack).not.toHaveBeenCalled();
  });
});
