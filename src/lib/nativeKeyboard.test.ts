// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => true);
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => invoke() }));

import { focusWithKeyboard } from "./nativeKeyboard";

let input: HTMLInputElement;
beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(true);
  input = document.createElement("input");
  document.body.appendChild(input);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  input.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("focusWithKeyboard", () => {
  it("focuses at once, arms the shell, then focuses again", async () => {
    const spy = vi.spyOn(input, "focus");
    focusWithKeyboard(input);
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("no second focus if the shell can't allow it, or focus moved on", async () => {
    invoke.mockResolvedValue(false);
    const spy = vi.spyOn(input, "focus");
    focusWithKeyboard(input);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValue(true);
    const other = document.createElement("textarea");
    document.body.appendChild(other);
    focusWithKeyboard(input);
    other.focus();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("outside the shell: a plain focus only", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    focusWithKeyboard(input);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
    expect(invoke).not.toHaveBeenCalled();
  });
});
