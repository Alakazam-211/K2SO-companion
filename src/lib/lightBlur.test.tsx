// @vitest-environment jsdom
// Diagnostics → Light blur: an A/B switch, off by default (the shipped
// four-layer blur), kept per phone, stamped on <html> as a class that
// index.css turns into a two-layer stack.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LIGHT_BLUR_CLASS, LIGHT_BLUR_KEY, initLightBlur, lightBlurOn, setLightBlur } from "./lightBlur";
import { LightBlurRow } from "../zen/LightBlurDiagnostics";

let css = "";
beforeAll(async () => {
  // @ts-expect-error Node fs — vitest runtime, not in app tsconfig libs
  const { readFileSync } = await import("fs");
  css = readFileSync("src/styles/index.css", "utf8") as string;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove(LIGHT_BLUR_CLASS);
});

describe("light blur A/B", () => {
  it("off by default: no class, the four-layer stack", () => {
    initLightBlur();
    expect(lightBlurOn()).toBe(false);
    expect(document.documentElement.classList.contains(LIGHT_BLUR_CLASS)).toBe(false);
  });

  it("the switch turns it on and off, kept in storage and on <html>", () => {
    render(<LightBlurRow />);
    const sw = screen.getByRole("switch");
    act(() => {
      fireEvent.click(sw);
    });
    expect(localStorage.getItem(LIGHT_BLUR_KEY)).toBe("1");
    expect(document.documentElement.classList.contains(LIGHT_BLUR_CLASS)).toBe(true);
    act(() => setLightBlur(false));
    expect(localStorage.getItem(LIGHT_BLUR_KEY)).toBeNull();
    expect(document.documentElement.classList.contains(LIGHT_BLUR_CLASS)).toBe(false);
  });

  it("a saved choice is stamped at startup", () => {
    localStorage.setItem(LIGHT_BLUR_KEY, "1");
    initLightBlur();
    expect(document.documentElement.classList.contains(LIGHT_BLUR_CLASS)).toBe(true);
  });

  it("index.css: light mode hides layers 1 and 3 of both stacks", () => {
    expect(css).toMatch(
      /\.k2-light-blur \.zen-header-blur-1,\s*\.k2-light-blur \.zen-header-blur-3,\s*\.k2-light-blur \.zen-footer-blur-1,\s*\.k2-light-blur \.zen-footer-blur-3 \{\s*display: none;/
    );
  });
});
