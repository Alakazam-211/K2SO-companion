// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAndroidSystemBars } from "./androidSystemBars";

afterEach(() => {
  delete (window as unknown as { K2Insets?: unknown }).K2Insets;
});

describe("installAndroidSystemBars", () => {
  it("sends the palette's scheme now and on every change, once per change", async () => {
    const setLightBars = vi.fn();
    (window as unknown as { K2Insets: unknown }).K2Insets = { setLightBars };
    const root = document.createElement("html");
    root.setAttribute("data-scheme", "dark");
    installAndroidSystemBars(root);
    expect(setLightBars.mock.calls).toEqual([[false]]);
    root.setAttribute("data-scheme", "light");
    await Promise.resolve();
    root.setAttribute("data-scheme", "light");
    await Promise.resolve();
    root.setAttribute("data-scheme", "dark");
    await Promise.resolve();
    expect(setLightBars.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("does nothing on an older shell without the bridge method", () => {
    (window as unknown as { K2Insets: unknown }).K2Insets = { safeBottom: () => 0 };
    expect(() => installAndroidSystemBars(document.createElement("html"))).not.toThrow();
  });
});
