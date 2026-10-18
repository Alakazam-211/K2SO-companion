// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));
vi.mock("../api/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/client")>();
  return { ...real, serverHasFeature: vi.fn(), getNotifyPrefs: vi.fn(), setNotifyPrefs: vi.fn() };
});
vi.mock("../lib/revive", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/revive")>();
  return { ...real, connectServer: vi.fn() };
});
vi.mock("./ticketEvents", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ticketEvents")>();
  return { ...real, connectNotifyPrefsEvents: vi.fn(() => ({ stop: vi.fn() })) };
});

import { getNotifyPrefs, serverHasFeature } from "../api/client";
import { __resetScopesForTests } from "../api/scope";
import { handleAndroidBack } from "../lib/androidBack";
import { __setBadgeTotalsDepsForTests } from "../lib/badgeTotals";
import { __resetIdentityForTests } from "../lib/sessionAuthor";
import { useServersStore } from "../stores/servers";
import { useNotifyPrefsStore } from "../stores/notifyPrefs";
import { usePushPreviewsStore } from "../stores/pushPreviews";
import { OverlayServers } from "./OverlayServers";
import { __resetServerUpdateForTests, useServerUpdateStore } from "./serverUpdateStore";
import { listBody } from "../test/llmTokensFixture";

const ok = (body: unknown) => ({
  status: 200,
  ok: true,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const VERSIONS: Record<string, string> = { "home.k2.dev": "0.47.1", "other.k2.dev": "0.46.0" };
const WHOAMI: Record<string, unknown> = {
  "home.k2.dev": { username: "baden", owner: false, role: "admin" },
  "other.k2.dev": { username: "jeremie", owner: false, role: "member" },
};

function prefsOn(enabled = true) {
  return {
    ok: true,
    data: {
      ok: true,
      principal: "owner",
      server: { enabled, source: "fallback" },
      default: true,
      devices: 1,
      push: "ready",
      workspaces: [],
    },
  } as never;
}

beforeEach(() => {
  __resetServerUpdateForTests();
  __resetScopesForTests();
  __resetIdentityForTests();
  tauriFetch.mockReset();
  tauriFetch.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/boot-status") return ok({ version: VERSIONS[u.host], features: [] });
    if (u.pathname === "/cli/auth/whoami") return ok(WHOAMI[u.host]);
    if (u.pathname === "/cli/llm/accounts/list") return ok(listBody());
    if (u.pathname === "/cli/llm/accounts/refresh") return ok({ accounts: [], usageChecked: true });
    throw new Error("offline");
  });
  vi.mocked(serverHasFeature).mockReset();
  vi.mocked(serverHasFeature).mockResolvedValue(false);
  vi.mocked(getNotifyPrefs).mockReset();
  useNotifyPrefsStore.setState({ threadPush: {}, prefs: {}, errors: {} });
  usePushPreviewsStore.setState({ previews: {}, allowed: {}, feature: {}, errors: {} });
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "baden", rememberPassword: false },
      { id: "s2", nickname: "Other", url: "https://other.k2.dev", username: "jeremie", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t1", s2: "t2" },
    recovery: { s1: "connected", s2: "reconnecting" },
  });
});
const realRemoveServer = useServersStore.getState().removeServer;
const realSetServerEnabled = useNotifyPrefsStore.getState().setServerEnabled;
afterEach(() => {
  cleanup();
  useServersStore.setState({ removeServer: realRemoveServer });
  useNotifyPrefsStore.setState({ setServerEnabled: realSetServerEnabled });
});

describe("Servers sheet gear → Server settings", () => {
  it("shows a gear on every server card, right of the bell and usage gauge", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn());
    render(<OverlayServers onClose={() => {}} />);
    const pinned = screen.getByTestId("servers-pinned");
    const usage = await within(pinned).findByTestId("server-usage");
    const gear = within(pinned).getByTestId("server-settings");
    expect(usage.nextElementSibling).toBe(gear);
    expect(gear.getAttribute("aria-label")).toBe("Settings for Home");
    expect(gear.querySelector("svg")?.getAttribute("data-k2-icon")).toBe("cog");

    const list = screen.getByTestId("overlay-servers-list");
    const rowBell = await within(list).findByTestId("server-bell");
    const rowGear = within(list).getByTestId("server-settings");
    expect(rowBell.nextElementSibling).toBe(rowGear);
    expect(rowGear.getAttribute("aria-label")).toBe("Settings for Other");
  });

  it("opens the page for that server id: title, address, user, role, status, version", async () => {
    render(<OverlayServers onClose={() => {}} />);
    const list = screen.getByTestId("overlay-servers-list");
    fireEvent.click(within(list).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    expect(within(page).getByTestId("server-settings-title").textContent).toBe("Other");
    expect(within(page).getByText("Server settings")).toBeTruthy();
    expect(within(page).getByTestId("server-settings-address").textContent).toBe("other.k2.dev");
    await waitFor(() =>
      expect(within(page).getByTestId("server-settings-role").textContent).toBe("Member")
    );
    expect(within(page).getByTestId("server-settings-username").textContent).toBe("jeremie");
    expect(within(page).getByTestId("server-settings-status").textContent).toBe("reconnecting…");
    await waitFor(() =>
      expect(within(page).getByTestId("server-version").textContent).toBe("K2 0.46.0")
    );
    const hosts = tauriFetch.mock.calls.map((c) => new URL(c[0] as string).host);
    expect(hosts.every((h) => h === "other.k2.dev")).toBe(true);
  });

  it("the active server shows its admin role and connected state", async () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    await waitFor(() =>
      expect(within(page).getByTestId("server-settings-role").textContent).toBe("Admin")
    );
    expect(within(page).getByTestId("server-settings-username").textContent).toBe("baden");
    expect(within(page).getByTestId("server-settings-status").textContent).toBe("Connected");
    await waitFor(() =>
      expect(within(page).getByTestId("server-version").textContent).toBe("K2 0.47.1")
    );
  });

  it("back chevron and Android Back return to Servers without closing it", async () => {
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);
    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    fireEvent.click(await screen.findByTestId("server-settings-back"));
    await waitFor(() => expect(screen.queryByTestId("server-settings-page")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("overlay-servers")).toBeTruthy();

    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    await screen.findByTestId("server-settings-page");
    expect(handleAndroidBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("server-settings-page")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the Usage row opens Usage for this server; back returns to Server settings", async () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(within(screen.getByTestId("overlay-servers-list")).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    fireEvent.click(within(page).getByTestId("server-settings-usage"));
    const usage = await screen.findByTestId("usage-page");
    expect(within(usage).getByTestId("usage-server").textContent).toBe("Other");

    expect(handleAndroidBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("usage-page")).toBeNull());
    expect(screen.getByTestId("server-settings-page")).toBeTruthy();
  });

  it("notifications row mirrors the bell: hidden without thread push, toggles the same pref", async () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    expect(within(page).queryByTestId("server-settings-notify")).toBeNull();
    cleanup();

    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(true));
    const setServerEnabled = vi.fn(async () => true);
    useNotifyPrefsStore.setState({ setServerEnabled });
    render(<OverlayServers onClose={() => {}} />);
    await within(screen.getByTestId("servers-pinned")).findByTestId("server-bell");
    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    const page2 = await screen.findByTestId("server-settings-page");
    expect(within(page2).getByTestId("server-settings-notify-status").textContent).toBe(
      "Notifications on"
    );
    fireEvent.click(within(within(page2).getByTestId("server-settings-notify")).getByRole("switch"));
    expect(setServerEnabled).toHaveBeenCalledWith("s1", false);
  });

  it("Notifications has a collapsed Diagnostics disclosure only where badge totals work (iOS push)", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(true));
    // Default deps: not Tauri → no disclosure.
    render(<OverlayServers onClose={() => {}} />);
    await within(screen.getByTestId("servers-pinned")).findByTestId("server-bell");
    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    await within(page).findByTestId("server-settings-notify");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(within(page).queryByTestId("server-settings-badge-diagnostics")).toBeNull();
    cleanup();

    __setBadgeTotalsDepsForTests({
      enabled: () => true,
      availability: async () => ({ available: true, platform: "ios" }),
      call: (async () => ({ available: true, version: 1, days: {} })) as never,
      servers: () => useServersStore.getState().servers,
    });
    try {
      render(<OverlayServers onClose={() => {}} />);
      await within(screen.getByTestId("servers-pinned")).findByTestId("server-bell");
      fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
      const page2 = await screen.findByTestId("server-settings-page");
      const toggle = await within(page2).findByTestId("server-settings-badge-diagnostics-toggle");
      expect(within(page2).getByTestId("server-settings-shortcuts").contains(toggle)).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(within(page2).getByTestId("badge-diag-today").textContent).toBe("0 silent · 0 alert")
      );
      expect(within(page2).getByTestId("badge-diag-last").textContent).toBe("Never");
    } finally {
      __setBadgeTotalsDepsForTests(null);
    }
  });

  describe("Show message previews", () => {
    /** Thread push on; `push-previews-v1` only when `previews`. */
    const features = (previews: boolean) =>
      vi
        .mocked(serverHasFeature)
        .mockImplementation(async (_s, key) => key !== "push-previews-v1" || previews);

    async function openHome() {
      render(<OverlayServers onClose={() => {}} />);
      const pinned = screen.getByTestId("servers-pinned");
      await within(pinned).findByTestId("server-bell");
      fireEvent.click(within(pinned).getByTestId("server-settings"));
      const page = await screen.findByTestId("server-settings-page");
      await within(page).findByTestId("server-settings-notify");
      return page;
    }

    it("is hidden when the server lacks push-previews-v1", async () => {
      features(false);
      vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(true));
      const page = await openHome();
      await waitFor(() => expect(usePushPreviewsStore.getState().feature.s1).toBe(false));
      expect(within(page).queryByTestId("server-settings-previews")).toBeNull();
      expect(within(page).queryByText("Show message previews")).toBeNull();
    });

    it("is hidden while notifications are off for the server", async () => {
      features(true);
      vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(false));
      const page = await openHome();
      await waitFor(() => expect(usePushPreviewsStore.getState().feature.s1).toBe(true));
      expect(within(page).queryByTestId("server-settings-previews")).toBeNull();
    });

    it("shows under Notifications with the key: on by default, helper text, toggles", async () => {
      features(true);
      vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(true));
      const page = await openHome();
      const row = await within(page).findByTestId("server-settings-previews");
      expect(within(page).getByTestId("server-settings-notify").nextElementSibling).toBe(row);
      expect(within(row).getByText("Show message previews")).toBeTruthy();
      expect(within(row).getByTestId("server-settings-previews-status").textContent).toBe(
        "Show the first lines of new messages in notifications."
      );
      const sw = within(row).getByRole("switch");
      expect(sw.getAttribute("aria-checked")).toBe("true");
      expect((sw as HTMLButtonElement).disabled).toBe(false);
      // No push in this test runtime: the pref is just saved.
      fireEvent.click(sw);
      await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
      expect(usePushPreviewsStore.getState().previews.s1).toBe(false);
    });

    it("shows a failed save inline", async () => {
      features(true);
      vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(true));
      usePushPreviewsStore.setState({ errors: { s1: "Could not save. Try again." } });
      const page = await openHome();
      const status = await within(page).findByTestId("server-settings-previews-status");
      expect(status.textContent).toBe("Could not save. Try again.");
    });

    it("the owner's master switch locks it off", async () => {
      features(true);
      vi.mocked(getNotifyPrefs).mockResolvedValue(prefsOn(true));
      usePushPreviewsStore.setState({ allowed: { s1: false } });
      const page = await openHome();
      const row = await within(page).findByTestId("server-settings-previews");
      const sw = within(row).getByRole("switch") as HTMLButtonElement;
      expect(sw.disabled).toBe(true);
      expect(sw.getAttribute("aria-checked")).toBe("false");
      expect(within(row).getByTestId("server-settings-previews-status").textContent).toBe(
        "Turned off by the server owner"
      );
    });
  });

  it("renames the server in place", async () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(within(screen.getByTestId("servers-pinned")).getByTestId("server-settings"));
    const input = (await screen.findByTestId("server-settings-nickname")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Studio  " } });
    fireEvent.blur(input);
    expect(useServersStore.getState().servers.find((s) => s.id === "s1")?.nickname).toBe("Studio");
    expect(screen.getByTestId("server-settings-title").textContent).toBe("Studio");
  });

  it("Remove asks first, then calls removeServer and returns to Servers", async () => {
    const removeServer = vi.fn();
    useServersStore.setState({ removeServer });
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);
    fireEvent.click(within(screen.getByTestId("overlay-servers-list")).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    fireEvent.click(within(page).getByTestId("server-settings-remove"));
    expect(removeServer).not.toHaveBeenCalled();
    fireEvent.click(within(page).getByTestId("server-settings-remove-cancel"));
    expect(within(page).queryByTestId("server-settings-remove-confirm")).toBeNull();

    fireEvent.click(within(page).getByTestId("server-settings-remove"));
    fireEvent.click(within(page).getByTestId("server-settings-remove-confirm-button"));
    expect(removeServer).toHaveBeenCalledWith("s2");
    await waitFor(() => expect(screen.queryByTestId("server-settings-page")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Sign out drops only this server's token", async () => {
    render(<OverlayServers onClose={() => {}} />);
    fireEvent.click(within(screen.getByTestId("overlay-servers-list")).getByTestId("server-settings"));
    const page = await screen.findByTestId("server-settings-page");
    fireEvent.click(within(page).getByTestId("server-settings-signout"));
    const s = useServersStore.getState();
    expect(s.tokens).toEqual({ s1: "t1" });
    expect(s.recovery.s2).toBe("signin-required");
    await waitFor(() => expect(screen.queryByTestId("server-settings-page")).toBeNull());
  });
  it("the gear shows an update dot only from a stored 'available' check", async () => {
    useServerUpdateStore.setState({
      stored: {
        s2: {
          at: Date.now(),
          result: { kind: "available", current: "0.46.0", latest: "0.46.1", installKind: "standalone", platform: "linux-x86_64" },
        },
        s1: { at: Date.now(), result: { kind: "up-to-date", current: "0.47.1" } },
      },
    });
    render(<OverlayServers onClose={() => {}} />);
    const list = screen.getByTestId("overlay-servers-list");
    const rowGear = within(list).getByTestId("server-settings");
    expect(within(rowGear).getByTestId("server-settings-update-dot")).toBeTruthy();
    expect(rowGear.getAttribute("aria-label")).toBe("Settings for Other, update available");
    const pinnedGear = within(screen.getByTestId("servers-pinned")).getByTestId("server-settings");
    expect(within(pinnedGear).queryByTestId("server-settings-update-dot")).toBeNull();
    // The card never checks by itself.
    expect(tauriFetch.mock.calls.some(([u]) => String(u).includes("/cli/daemon/update/"))).toBe(false);
  });
});
