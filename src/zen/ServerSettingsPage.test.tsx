// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import { __resetIdentityForTests } from "../lib/sessionAuthor";
import { useServersStore } from "../stores/servers";
import { useNotifyPrefsStore } from "../stores/notifyPrefs";
import { OverlayServers } from "./OverlayServers";
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
    fireEvent.click(within(page2).getByRole("switch"));
    expect(setServerEnabled).toHaveBeenCalledWith("s1", false);
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
});
