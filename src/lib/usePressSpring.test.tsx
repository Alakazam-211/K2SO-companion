// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PRESS_SCALE, PRESSING_CLASS, stepSpring, usePressSpring } from "./usePressSpring";

function Btn() {
  const ref = usePressSpring<HTMLButtonElement>();
  return <button ref={ref} data-testid="b">x</button>;
}

const frames = (n: number) =>
  act(() => {
    for (let i = 0; i < n; i++) vi.advanceTimersByTime(16);
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("press spring (LiquidGlassJS constants)", () => {
  it("settles on its target; the release spring overshoots below 1 once", () => {
    const s = { value: 1, velocity: 0, target: PRESS_SCALE, k: 550, c: 30 };
    for (let i = 0; i < 120 && stepSpring(s, 1 / 60); i++);
    expect(s.value).toBe(PRESS_SCALE);
    Object.assign(s, { target: 1, k: 300, c: 16 });
    let min = s.value;
    for (let i = 0; i < 240 && stepSpring(s, 1 / 60); i++) min = Math.min(min, s.value);
    expect(s.value).toBe(1);
    expect(min).toBeLessThan(1);
  });

  it("grows while held, marks the button pressing, and rests clean after release", () => {
    render(<Btn />);
    const b = screen.getByTestId("b");
    fireEvent.pointerDown(b);
    expect(b.classList.contains(PRESSING_CLASS)).toBe(true);
    frames(30);
    expect(b.style.transform).toBe(`scale(${PRESS_SCALE.toFixed(4)})`);
    fireEvent.pointerUp(b);
    frames(90);
    expect(b.style.transform).toBe("");
    expect(b.classList.contains(PRESSING_CLASS)).toBe(false);
  });

  it("reduced motion or a disabled button: no spring", () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    render(<Btn />);
    fireEvent.pointerDown(screen.getByTestId("b"));
    frames(10);
    expect(screen.getByTestId("b").style.transform).toBe("");
  });
});
