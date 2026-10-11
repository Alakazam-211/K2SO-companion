// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../lib/push", () => ({
  pushAvailability: vi.fn(async () => ({ available: true, platform: "apns" })),
  getPushEnabled: vi.fn(async () => false),
  setPushEnabled: vi.fn(async () => undefined),
  registerAllSignedIn: vi.fn(async () => undefined),
  unregisterAll: vi.fn(async () => undefined),
}));

vi.mock("../lib/about", () => ({
  ABOUT: { app: "K2", version: "9.8.7", engine: "Tauri v2", terminal: "Kessel" },
}));

import {
  registerAllSignedIn,
  getPushEnabled,
  pushAvailability,
  setPushEnabled,
  unregisterAll,
} from "../lib/push";
import { useServersStore } from "../stores/servers";
import { LEAVE_ZEN_PATH, ZenSettings } from "./ZenSettings";
import { MULTI_SERVER_KEY, useMultiServerPrefs } from "./multi/prefs";
import {
  ZEN_FONT_ATTR,
  ZEN_FONT_STORAGE_KEY,
  ZEN_TEXT_SCALE_VAR,
  ZEN_TEXT_SIZE_STORAGE_KEY,
  initZenFont,
  useZenFontStore,
} from "./zenFont";

const SERVER = {
  id: "s1",
  nickname: "test",
  url: "https://example.k2.dev",
  username: "u",
  rememberPassword: false,
};

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function mount(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/zen"]}>
      <Routes>
        <Route path="/zen" element={<ZenSettings onClose={onClose} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pushAvailability).mockResolvedValue({ available: true, platform: "apns" });
  vi.mocked(getPushEnabled).mockResolvedValue(false);
  useServersStore.setState({
    servers: [SERVER],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t" },
  });
  localStorage.clear();
  useZenFontStore.setState({ font: "system", textSize: "default" });
  document.documentElement.removeAttribute(ZEN_FONT_ATTR);
  document.documentElement.style.removeProperty(ZEN_TEXT_SCALE_VAR);
});

afterEach(cleanup);

describe("ZenSettings", () => {
  it("Experimental: 'Show agents from all servers' is off by default and persists (MS40)", () => {
    useMultiServerPrefs.setState({ multiServer: false });
    mount();
    const group = within(screen.getByTestId("settings-experimental"));
    expect(group.getByText("Experimental")).not.toBeNull();
    const sw = screen.getByRole("switch", { name: "Show agents from all servers" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(MULTI_SERVER_KEY)).toBe("1");
    fireEvent.click(sw);
    expect(localStorage.getItem(MULTI_SERVER_KEY)).toBe(null);
    expect(useMultiServerPrefs.getState().multiServer).toBe(false);
  });

  it("renders Notifications, Appearance, About and Leave Zen Mode in glass cards", async () => {
    mount();
    expect(screen.getByTestId("overlay-settings")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).not.toBeNull();
    for (const id of ["settings-notifications", "settings-appearance", "settings-about"]) {
      expect(screen.getByTestId(id).querySelector(".k2-tile")).not.toBeNull();
    }
    expect(within(screen.getByTestId("settings-notifications")).getByText("Notifications")).not.toBeNull();
    expect(screen.getByTestId("settings-scroll").className).toMatch(/overflow-y-auto/);
    expect(screen.getByRole("button", { name: "Done" }).className).toMatch(/zen-glass-pill/);
    const leave = screen.getByRole("button", { name: "Leave Zen Mode" });
    expect(leave.closest(".k2-tile")).not.toBeNull();
    expect(screen.queryByText(/Terminal view/)).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Push Notifications" }).hasAttribute("disabled")).toBe(false)
    );
  });

  it("About shows App K2, the shared version and engine", () => {
    mount();
    const about = within(screen.getByTestId("settings-about"));
    expect(about.getByText("App").nextElementSibling?.textContent).toBe("K2");
    expect(about.getByText("Version").nextElementSibling?.textContent).toBe("9.8.7");
    expect(about.getByText("Engine").nextElementSibling?.textContent).toBe("Tauri v2");
    expect(about.getByText("Terminal").nextElementSibling?.textContent).toBe("Kessel");
    expect(screen.getByTestId("overlay-settings").textContent).not.toMatch(/K2SO/);
  });

  it("push switch reflects the stored state", async () => {
    vi.mocked(getPushEnabled).mockResolvedValue(true);
    mount();
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Push Notifications" }).getAttribute("aria-checked")).toBe("true")
    );
  });

  it("toggle ON: setPushEnabled(true) then register on every signed-in server", async () => {
    let finish!: () => void;
    vi.mocked(registerAllSignedIn).mockImplementation(
      () => new Promise<void>((r) => (finish = r))
    );
    mount();
    const sw = screen.getByRole("switch", { name: "Push Notifications" });
    await waitFor(() => expect(sw.hasAttribute("disabled")).toBe(false));
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(registerAllSignedIn).toHaveBeenCalled());
    expect(setPushEnabled).toHaveBeenCalledWith(true);
    // In flight: disabled with a spinner.
    expect(sw.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("push-pending")).not.toBeNull();
    await act(async () => finish());
    await waitFor(() => expect(sw.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByTestId("push-pending")).toBeNull();
    expect(unregisterAll).not.toHaveBeenCalled();
  });

  it("toggle OFF runs setPushEnabled(false) then unregisterAll", async () => {
    vi.mocked(getPushEnabled).mockResolvedValue(true);
    mount();
    const sw = screen.getByRole("switch", { name: "Push Notifications" });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(sw);
    await waitFor(() => expect(unregisterAll).toHaveBeenCalled());
    expect(setPushEnabled).toHaveBeenCalledWith(false);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(registerAllSignedIn).not.toHaveBeenCalled();
  });

  it("dormant build: switch disabled with the old page's Unavailable text", async () => {
    vi.mocked(pushAvailability).mockResolvedValue({
      available: false,
      platform: "ios",
      reason: "no aps-environment",
    });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("push-unavailable").textContent).toBe("Unavailable: no aps-environment")
    );
    const sw = screen.getByRole("switch", { name: "Push Notifications" });
    expect(sw.hasAttribute("disabled")).toBe(true);
    fireEvent.click(sw);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });

  it("dormant build without a reason says Not available in this build", async () => {
    vi.mocked(pushAvailability).mockResolvedValue({ available: false, platform: "ios" });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("push-unavailable").textContent).toBe("Not available in this build")
    );
  });

  it("Leave Zen Mode closes the sheet and navigates to /servers", () => {
    const onClose = mount();
    fireEvent.click(screen.getByRole("button", { name: "Leave Zen Mode" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(LEAVE_ZEN_PATH).toBe("/servers");
    expect(screen.getByTestId("where").textContent).toBe("/servers");
  });

  it("Done closes the sheet without navigating", () => {
    const onClose = mount();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("font control persists the choice and stamps <html>", () => {
    mount();
    const system = screen.getByRole("radio", { name: "System" });
    const meslo = screen.getByRole("radio", { name: "Meslo Nerd Font" });
    expect(system.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(meslo);
    expect(meslo.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(ZEN_FONT_STORAGE_KEY)).toBe("meslo");
    expect(document.documentElement.getAttribute(ZEN_FONT_ATTR)).toBe("meslo");
    fireEvent.click(system);
    expect(localStorage.getItem(ZEN_FONT_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.hasAttribute(ZEN_FONT_ATTR)).toBe(false);
  });

  it("Text Size slider sits under Font with 3 stops: Small / Default / Large", () => {
    mount();
    const appearance = screen.getByTestId("settings-appearance");
    const fontRow = screen.getByTestId("font-segments");
    const row = within(appearance).getByTestId("text-size-row");
    // Below the Font control.
    expect(fontRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "Text Size" }) as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("2");
    expect(slider.step).toBe("1");
    expect(slider.value).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("Default");
    expect(within(row).getAllByTestId("text-size-tick")).toHaveLength(3);
    expect(within(row).getByTestId("text-size-track").className).toMatch(/zen-glass/);
    expect(within(row).getByTestId("text-size-value").textContent).toBe("Default");
  });

  it("Text Size persists and sets --zen-text-scale to 0.9 / 1 / 1.15", () => {
    mount();
    const slider = screen.getByRole("slider", { name: "Text Size" });
    const root = document.documentElement;
    for (const [v, size, label, scale] of [
      ["0", "small", "Small", "0.9"],
      ["2", "large", "Large", "1.15"],
      ["1", "default", "Default", "1"],
    ] as const) {
      fireEvent.change(slider, { target: { value: v } });
      expect(localStorage.getItem(ZEN_TEXT_SIZE_STORAGE_KEY)).toBe(size);
      expect(root.style.getPropertyValue(ZEN_TEXT_SCALE_VAR)).toBe(scale);
      expect(slider.getAttribute("aria-valuetext")).toBe(label);
      expect(screen.getByTestId("text-size-value").textContent).toBe(label);
    }
  });

  it("Text Size restores on load", () => {
    localStorage.setItem(ZEN_TEXT_SIZE_STORAGE_KEY, "large");
    initZenFont();
    expect(document.documentElement.style.getPropertyValue(ZEN_TEXT_SCALE_VAR)).toBe("1.15");
    mount();
    const slider = screen.getByRole("slider", { name: "Text Size" }) as HTMLInputElement;
    expect(slider.value).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("Large");
  });
});
