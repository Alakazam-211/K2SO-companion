// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { backHandlerCount, handleAndroidBack, pushBackHandler, useBackHandler } from "./androidBack";

describe("androidBack", () => {
  it("returns false with nothing registered (native falls through)", () => {
    expect(backHandlerCount()).toBe(0);
    expect(handleAndroidBack()).toBe(false);
  });

  it("runs only the most recently registered handler", () => {
    const under = vi.fn();
    const top = vi.fn();
    const offUnder = pushBackHandler(under);
    const offTop = pushBackHandler(top);
    expect(handleAndroidBack()).toBe(true);
    expect(top).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
    offTop();
    handleAndroidBack();
    expect(under).toHaveBeenCalledTimes(1);
    offUnder();
    expect(backHandlerCount()).toBe(0);
  });

  it("useBackHandler registers only while active and uses the latest closure", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ active, fn }) => useBackHandler(active, fn),
      { initialProps: { active: false, fn: first } },
    );
    expect(handleAndroidBack()).toBe(false);
    rerender({ active: true, fn: first });
    rerender({ active: true, fn: second });
    expect(handleAndroidBack()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    rerender({ active: false, fn: second });
    expect(handleAndroidBack()).toBe(false);
    unmount();
  });
});
