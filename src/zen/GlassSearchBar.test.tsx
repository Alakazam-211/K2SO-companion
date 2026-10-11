// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  GlassSearchBar,
  SEARCH_BAR_KEYBOARD_GAP,
  SEARCH_BAR_REST_BOTTOM,
} from "./GlassSearchBar";

afterEach(cleanup);

function mount() {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  render(
    <GlassSearchBar
      query=""
      onQuery={() => {}}
      onPlus={() => {}}
      plusLabel="New message"
      testId="bar"
      inputTestId="bar-input"
      plusTestId="bar-plus"
    />
  );
  return {
    bar: screen.getByTestId("bar"),
    input: screen.getByTestId("bar-input"),
    plus: screen.getByTestId("bar-plus"),
  };
}

describe("GlassSearchBar keyboard gap", () => {
  it("matches the thread composer's 8px keyboard gap", () => {
    expect(SEARCH_BAR_KEYBOARD_GAP).toBe(8);
  });

  it("keyboard closed: rests above the home indicator (safe-area offset)", () => {
    const { bar } = mount();
    expect(SEARCH_BAR_REST_BOTTOM).toContain("env(safe-area-inset-bottom)");
    expect(bar.dataset.bottom).toBe(SEARCH_BAR_REST_BOTTOM);
    expect(bar.dataset.typing).toBeUndefined();
  });

  it("focused (keyboard up): 8px gap, no safe-area inset", () => {
    const { bar, input } = mount();
    fireEvent.focus(input);
    expect(bar.style.bottom).toBe("8px");
    expect(bar.dataset.bottom).toBe("8px");
    expect(bar.dataset.typing).toBe("1");
  });

  it("blur restores the resting safe-area offset", () => {
    const { bar, input } = mount();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(bar.dataset.bottom).toBe(SEARCH_BAR_REST_BOTTOM);
    expect(bar.dataset.typing).toBeUndefined();
  });

  it("focusing the + button is not typing", () => {
    const { bar, plus } = mount();
    fireEvent.focus(plus);
    expect(bar.dataset.bottom).toBe(SEARCH_BAR_REST_BOTTOM);
  });
});
