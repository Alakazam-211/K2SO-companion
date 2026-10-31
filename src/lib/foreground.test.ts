// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForegroundForTests, afterForeground, cancelForeground, onForegroundLater } from "./foreground";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  __resetForegroundForTests();
  vi.useRealTimers();
});

describe("staggered foreground (speed PRD A1)", () => {
  it("runs after the stagger; a later call for the same key replaces the earlier", () => {
    const fn = vi.fn();
    afterForeground("k", fn);
    afterForeground("k", fn);
    vi.advanceTimersByTime(1499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a reopen that already did the work cancels the waiting run", () => {
    const fn = vi.fn();
    afterForeground("k", fn);
    expect(cancelForeground("k")).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    expect(cancelForeground("k")).toBe(false);
  });

  it("listens for returns to the foreground until removed", () => {
    const fn = vi.fn();
    const off = onForegroundLater("k", fn);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
