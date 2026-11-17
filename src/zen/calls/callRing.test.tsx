// @vitest-environment jsdom
// Ring for incoming calls (Settings → Calls; Riley 2026-11-17): one switch,
// this phone only, default On like push. Off = no in-app ring tone and a
// quiet call push (the Notification Service Extension reads the App Group
// copy `call_op ring {on}` writes).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ios = vi.hoisted(() => ({ on: true }));
vi.mock("../../lib/nativePicker", async (orig) => ({
  ...(await orig<typeof import("../../lib/nativePicker")>()),
  isIosWebView: () => ios.on,
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../lib/push", () => ({
  pushAvailability: vi.fn(async () => ({ available: true, platform: "apns" })),
  getPushEnabled: vi.fn(async () => false),
  setPushEnabled: vi.fn(async () => undefined),
  registerAllSignedIn: vi.fn(async () => undefined),
  unregisterAll: vi.fn(async () => undefined),
}));

import { CALL_RING_KEY, loadCallRing, saveCallRing, shareCallRing, syncCallRing, useCallRingStore } from "./callRing";
import { ZenSettings } from "../ZenSettings";

const OP = "plugin:k2-push|call_op";

beforeEach(() => {
  localStorage.clear();
  ios.on = true;
  invoke.mockReset();
  invoke.mockImplementation(async (_cmd: string, args?: { on?: boolean }) => ({ ok: true, on: args?.on }));
  useCallRingStore.setState({ on: loadCallRing() });
});
afterEach(cleanup);

describe("the setting", () => {
  it("is On by default, and only an explicit Off turns it off", () => {
    expect(loadCallRing()).toBe(true);
    localStorage.setItem(CALL_RING_KEY, "on");
    expect(loadCallRing()).toBe(true);
    localStorage.setItem(CALL_RING_KEY, "off");
    expect(loadCallRing()).toBe(false);
  });

  it("persists under k2.calls.ring", () => {
    saveCallRing(false);
    expect(localStorage.getItem("k2.calls.ring")).toBe("off");
    saveCallRing(true);
    expect(localStorage.getItem("k2.calls.ring")).toBe("on");
  });

  it("the store keeps the choice and copies it for the push extension", async () => {
    useCallRingStore.getState().setOn(false);
    expect(useCallRingStore.getState().on).toBe(false);
    expect(localStorage.getItem(CALL_RING_KEY)).toBe("off");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(OP, { op: "ring", on: false }));
    useCallRingStore.getState().setOn(true);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith(OP, { op: "ring", on: true }));
  });
});

describe("shareCallRing", () => {
  it("sends the stored choice (at launch too)", async () => {
    saveCallRing(false);
    expect(await shareCallRing()).toBe(true);
    expect(invoke).toHaveBeenCalledWith(OP, { op: "ring", on: false });
    invoke.mockClear();
    localStorage.clear();
    syncCallRing();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(OP, { op: "ring", on: true }));
  });

  it("never throws: an older native build answers false", async () => {
    invoke.mockRejectedValueOnce(new Error("callOp: unknown op ring"));
    expect(await shareCallRing(false)).toBe(false);
  });

  it("is iOS only", async () => {
    ios.on = false;
    expect(await shareCallRing(false)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("Settings → Calls → Ring for incoming calls", () => {
  const sw = () => screen.getByRole("switch", { name: "Ring for incoming calls" });

  it("is On by default, with its footnote", () => {
    render(<ZenSettings onClose={() => {}} />);
    const group = screen.getByTestId("settings-calls");
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(group.textContent).toContain(
      "Ring for incoming calls: the phone rings when someone calls you. Off: calls arrive as a quiet notification."
    );
    expect(screen.getByRole("switch", { name: "Noise removal" })).toBeTruthy();
  });

  it("turning it off stores Off and tells the extension", async () => {
    render(<ZenSettings onClose={() => {}} />);
    fireEvent.click(sw());
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(CALL_RING_KEY)).toBe("off");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(OP, { op: "ring", on: false }));
  });

  it("an Off stored before shows off", () => {
    saveCallRing(false);
    useCallRingStore.setState({ on: loadCallRing() });
    render(<ZenSettings onClose={() => {}} />);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });
});
