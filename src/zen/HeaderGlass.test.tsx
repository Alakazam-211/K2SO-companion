// @vitest-environment jsdom
// The merged layer must find its header on the first mount: a parent's
// ref is not attached yet when a child's layout effect runs (the bug that
// kept 4.1.0 build 202610221908 from merging).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";

vi.mock("./glassMerge", async (orig) => ({
  ...(await orig<typeof import("./glassMerge")>()),
  renderGlassMasks: vi.fn(() => ({ fill: "data:fill", rim: "data:rim" })),
}));

import { GLASS_MERGED_ATTR, HeaderGlass } from "./HeaderGlass";

function Header() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="host">
      <HeaderGlass />
      <button data-glass-shape="button">b</button>
      <span data-glass-shape="pill">name</span>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // jsdom lays nothing out: give every box a size.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0, toJSON() {},
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HeaderGlass", () => {
  it("merges on the first mount: the host is its own parent", () => {
    render(<Header />);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(screen.getByTestId("host").hasAttribute(GLASS_MERGED_ATTR)).toBe(true);
    expect(screen.getByTestId("header-glass-fill").style.webkitMaskImage).toContain("data:fill");
  });
});
