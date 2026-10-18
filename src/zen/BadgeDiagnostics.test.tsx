// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { __setBadgeTotalsDepsForTests, localDayKey } from "../lib/badgeTotals";
import { useServersStore } from "../stores/servers";
import { BadgeDiagnosticsRow, formatLastReceived } from "./BadgeDiagnostics";

let avail: { available: boolean; platform: string };
let diagCalls: number;
const today = localDayKey(new Date());
const twoDaysAgo = (() => {
  const d = new Date();
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 2));
})();
const LAST = new Date(2026, 9, 17, 9, 30).getTime();

function install(enabled = true) {
  __setBadgeTotalsDepsForTests({
    enabled: () => enabled,
    availability: async () => avail,
    call: (async (cmd: string) => {
      if (cmd !== "get_badge_diagnostics") throw new Error(cmd);
      diagCalls++;
      return {
        available: true,
        version: 1,
        days: {
          [today]: { home: { silent: 2, alert: 5, lastAt: LAST } },
          [twoDaysAgo]: { home: { silent: 3, alert: 1, lastAt: LAST - 1000 } },
        },
      };
    }) as never,
    listen: async () => ({ unregister: () => {} }),
    servers: () => useServersStore.getState().servers,
  });
}

beforeEach(() => {
  avail = { available: true, platform: "ios" };
  diagCalls = 0;
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "baden", rememberPassword: false },
      { id: "lan", nickname: "Lan", url: "http://192.168.1.5:60710", username: "x", rememberPassword: false },
    ],
  } as never);
  install();
});

afterEach(() => {
  cleanup();
  __setBadgeTotalsDepsForTests(null);
});

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("BadgeDiagnosticsRow", () => {
  it("is collapsed by default and loads nothing until opened", async () => {
    render(<BadgeDiagnosticsRow serverId="s1" />);
    const toggle = await screen.findByTestId("server-settings-badge-diagnostics-toggle");
    expect(toggle.textContent).toContain("Diagnostics");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("server-settings-badge-diagnostics-panel")).toBeNull();
    expect(diagCalls).toBe(0);
  });

  it("opens to today's and the 7-day counts plus the last-received time", async () => {
    render(<BadgeDiagnosticsRow serverId="s1" />);
    fireEvent.click(await screen.findByTestId("server-settings-badge-diagnostics-toggle"));
    await waitFor(() => expect(screen.getByTestId("badge-diag-today").textContent).toBe("2 silent · 5 alert"));
    expect(screen.getByTestId("badge-diag-week").textContent).toBe("5 silent · 6 alert");
    expect(screen.getByTestId("badge-diag-last").textContent).toBe(formatLastReceived(LAST));
    expect(
      screen.getByTestId("server-settings-badge-diagnostics-toggle").getAttribute("aria-expanded")
    ).toBe("true");

    fireEvent.click(screen.getByTestId("server-settings-badge-diagnostics-toggle"));
    expect(screen.queryByTestId("server-settings-badge-diagnostics-panel")).toBeNull();
  });

  it("is hidden when push is not available", async () => {
    avail = { available: false, platform: "ios" };
    render(<BadgeDiagnosticsRow serverId="s1" />);
    await settle();
    expect(screen.queryByTestId("server-settings-badge-diagnostics")).toBeNull();
  });

  it("is hidden off iOS and outside Tauri", async () => {
    avail = { available: true, platform: "android" };
    const { unmount } = render(<BadgeDiagnosticsRow serverId="s1" />);
    await settle();
    expect(screen.queryByTestId("server-settings-badge-diagnostics")).toBeNull();
    unmount();

    install(false);
    avail = { available: true, platform: "ios" };
    render(<BadgeDiagnosticsRow serverId="s1" />);
    await settle();
    expect(screen.queryByTestId("server-settings-badge-diagnostics")).toBeNull();
  });

  it("is hidden for a server off k2.dev", async () => {
    render(<BadgeDiagnosticsRow serverId="lan" />);
    await settle();
    expect(screen.queryByTestId("server-settings-badge-diagnostics")).toBeNull();
  });

  it("says Never when nothing was received", async () => {
    expect(formatLastReceived(null)).toBe("Never");
  });
});
