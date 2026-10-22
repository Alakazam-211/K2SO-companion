// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn(async (_cmd: string, args: { action: string }) => (args.action === "report" ? "now: retaining=no\n  1.000s  page: swipe start" : ""));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: { action: string }) => invoke(cmd, args) }));

import { kbMark, returnHoldOn, setReturnHoldOn } from "../lib/kbDiag";
import { KeyboardEventsRow } from "./KeyboardEventsDiagnostics";

beforeEach(() => {
  invoke.mockClear();
  localStorage.clear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("keyboard events diagnostics", () => {
  it("the return hold is on by default and remembered when switched off", async () => {
    expect(returnHoldOn()).toBe(true);
    setReturnHoldOn(false);
    expect(returnHoldOn()).toBe(false);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ios_keyboard_diag", { action: "hold", on: false }));
  });

  it("marks go to the native log; nothing outside the shell", async () => {
    kbMark("swipe start");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ios_keyboard_diag", { action: "mark", label: "swipe start" }));
    invoke.mockClear();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    kbMark("x");
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opening the row shows the log", async () => {
    render(<KeyboardEventsRow />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("kb-events-toggle-panel"));
    });
    expect((await screen.findByTestId("kb-events-log")).textContent).toContain("swipe start");
  });
});
