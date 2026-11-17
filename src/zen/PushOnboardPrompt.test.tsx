// @vitest-environment jsdom
// The one-time push onboarding prompt (4.3.0): who sees it, once, and what
// its answers do (lib/pushOnboard.ts + zen/PushOnboardPrompt.tsx). The
// native plugin calls are mocked at lib/push.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.hoisted(() => ({
  pushAvailability: vi.fn(async () => ({ available: true, platform: "ios" }) as { available: boolean; platform: string }),
  notificationState: vi.fn(async () => "notDetermined" as string),
  osAllowsNotifications: (s: string) => s === "authorized" || s === "provisional" || s === "ephemeral",
  requestPushPermission: vi.fn(async () => true),
  openNotificationSettings: vi.fn(async () => true),
  registerAllSignedIn: vi.fn(async () => undefined),
  setPushEnabled: vi.fn(async () => undefined),
}));
vi.mock("../lib/push", () => push);

const calls = vi.hoisted(() => ({
  voice: { phase: "idle" as string },
  dm: { rings: [] as unknown[], active: null as unknown },
}));
vi.mock("./voice/voiceCall", () => ({ useVoiceCall: { getState: () => calls.voice } }));
vi.mock("./calls/dmCall", () => ({ useDmCalls: { getState: () => calls.dm } }));

import { PUSH_ONBOARD_KEY } from "../lib/pushOnboard";
import { PUSH_ONBOARD_COPY, PushOnboardHost } from "./PushOnboardPrompt";
import { useCallScreen } from "./voice/callScreen";

const mount = () => render(<PushOnboardHost delayMs={0} retryMs={10} />);
const flag = () => {
  const raw = localStorage.getItem(PUSH_ONBOARD_KEY);
  return raw ? (JSON.parse(raw) as { outcome: string }) : null;
};
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 80)));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  push.pushAvailability.mockResolvedValue({ available: true, platform: "ios" });
  push.notificationState.mockResolvedValue("notDetermined");
  push.requestPushPermission.mockResolvedValue(true);
  calls.voice.phase = "idle";
  calls.dm = { rings: [], active: null };
  useCallScreen.setState({ open: false });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("push onboarding prompt", () => {
  it("shows once the flag is missing and iOS hasn't asked yet", async () => {
    mount();
    const sheet = await screen.findByTestId("push-onboard");
    expect(sheet.textContent).toContain(PUSH_ONBOARD_COPY.title);
    expect(screen.getByTestId("push-onboard-body").textContent).toBe(PUSH_ONBOARD_COPY.body);
    expect(screen.getByTestId("push-onboard-yes").textContent).toBe("Turn on notifications");
    expect(screen.getByTestId("push-onboard-no").textContent).toBe("Not now");
    // Nothing is asked of iOS until the yes.
    expect(push.requestPushPermission).not.toHaveBeenCalled();
    // Killed while open: it may show once more.
    expect(flag()).toBeNull();
  });

  it.each(["authorized", "provisional", "ephemeral"])("already %s: never shown, flag set silently", async (state) => {
    push.notificationState.mockResolvedValue(state);
    mount();
    await waitFor(() => expect(flag()?.outcome).toBe("granted"));
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
  });

  it("Yes: the push preference on, iOS's alert, then registration on every signed-in server", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("push-onboard-yes"));
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    await waitFor(() => expect(push.registerAllSignedIn).toHaveBeenCalledTimes(1));
    expect(push.setPushEnabled).toHaveBeenCalledWith(true);
    expect(push.requestPushPermission).toHaveBeenCalledTimes(1);
    const order = [
      push.setPushEnabled.mock.invocationCallOrder[0],
      push.requestPushPermission.mock.invocationCallOrder[0],
      push.registerAllSignedIn.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(push.openNotificationSettings).not.toHaveBeenCalled();
    expect(flag()?.outcome).toBe("granted");
  });

  it("Yes, then Don't Allow on iOS's alert: no registration, never asked again", async () => {
    push.requestPushPermission.mockResolvedValue(false);
    mount();
    fireEvent.click(await screen.findByTestId("push-onboard-yes"));
    await waitFor(() => expect(flag()?.outcome).toBe("refused"));
    expect(push.registerAllSignedIn).not.toHaveBeenCalled();
  });

  it("denied in iOS: says so, and Yes opens the app's iOS Settings instead of the alert", async () => {
    push.notificationState.mockResolvedValue("denied");
    mount();
    await screen.findByTestId("push-onboard");
    expect(screen.getByTestId("push-onboard-body").textContent).toBe(
      `${PUSH_ONBOARD_COPY.body} Notifications are off in iOS Settings for K2.`
    );
    expect(screen.getByTestId("push-onboard-yes").textContent).toBe("Turn on in Settings");
    fireEvent.click(screen.getByTestId("push-onboard-yes"));
    await waitFor(() => expect(push.openNotificationSettings).toHaveBeenCalledTimes(1));
    expect(push.requestPushPermission).not.toHaveBeenCalled();
    expect(push.setPushEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(flag()?.outcome).toBe("settings"));
  });

  it("the not-yet-asked copy never mentions iOS Settings", async () => {
    mount();
    await screen.findByTestId("push-onboard");
    expect(screen.getByTestId("push-onboard").textContent).not.toContain("iOS Settings");
  });

  it("Not now: closes, asks nothing, and is never shown again", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("push-onboard-no"));
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    expect(flag()?.outcome).toBe("notNow");
    expect(push.requestPushPermission).not.toHaveBeenCalled();
    expect(push.setPushEnabled).not.toHaveBeenCalled();
    cleanup();
    push.notificationState.mockClear();
    mount();
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    expect(push.notificationState).not.toHaveBeenCalled();
  });

  it("a tap outside is Not now", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("push-onboard"));
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    expect(flag()?.outcome).toBe("notNow");
  });

  it("waits for another sheet to close instead of covering it", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    mount();
    await waitFor(() => expect(push.notificationState).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    other.remove();
    expect(await screen.findByTestId("push-onboard")).toBeTruthy();
  });

  it("never over the Set your new password step", async () => {
    const step = document.createElement("form");
    step.setAttribute("data-testid", "set-password");
    document.body.appendChild(step);
    mount();
    await waitFor(() => expect(push.notificationState).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    step.remove();
    expect(await screen.findByTestId("push-onboard")).toBeTruthy();
  });

  it("never during a call, or while someone is typing", async () => {
    calls.voice.phase = "connected";
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    mount();
    await waitFor(() => expect(push.notificationState).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    calls.voice.phase = "idle";
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    input.blur();
    expect(await screen.findByTestId("push-onboard")).toBeTruthy();
  });

  it("never while a DM call rings or the call screen is open", async () => {
    calls.dm = { rings: [{ key: "r1" }], active: null };
    useCallScreen.setState({ open: true });
    mount();
    await waitFor(() => expect(push.notificationState).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    calls.dm = { rings: [], active: null };
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    act(() => useCallScreen.setState({ open: false }));
    expect(await screen.findByTestId("push-onboard")).toBeTruthy();
  });

  it("iOS only: Android never shows it and keeps no flag", async () => {
    push.pushAvailability.mockResolvedValue({ available: true, platform: "android" });
    mount();
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    expect(flag()).toBeNull();
  });

  it("a build without push (dormant) shows nothing and keeps no flag", async () => {
    push.pushAvailability.mockResolvedValue({ available: false, platform: "ios" });
    mount();
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    expect(flag()).toBeNull();
  });

  it("an iOS that can't say (older native build): nothing shown, no flag", async () => {
    push.notificationState.mockResolvedValue("unknown");
    mount();
    await waitFor(() => expect(push.notificationState).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId("push-onboard")).toBeNull();
    expect(flag()).toBeNull();
  });
});
