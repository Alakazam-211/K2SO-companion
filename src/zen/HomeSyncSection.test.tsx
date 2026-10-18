// @vitest-environment jsdom
// Server settings → Home sync, the Home tab badge and the Home menu line
// (K2 0.46.1 `homes-sync-v1`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { __resetScopesForTests } from "../api/scope";
import { useServersStore } from "../stores/servers";
import { fakeHomesServer, type FakeHomesServer } from "../test/fakeHomesServer";
import { useHomeServerIds } from "./homeServerIds";
import { HomeMenu } from "./HomeMenu";
import { HomeSyncSection } from "./HomeSyncSection";
import { HomeTabToggle } from "./HomeTabToggle";
import { useHomesStore } from "./homes";
import { __resetHomesSyncForTests, enableHomesSync, syncHomesNow, useHomesSyncStore } from "./homesSync";

const PHONE = "phone-1";
let A: FakeHomesServer;
let B: FakeHomesServer;

beforeEach(() => {
  localStorage.clear();
  __resetScopesForTests();
  A = fakeHomesServer("home.k2.dev", { serverId: "0123456789abcdef" });
  B = fakeHomesServer("work.k2.dev", { serverId: "fedcba9876543210" });
  tauriFetch.mockReset();
  tauriFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const host = new URL(url).host;
    if (host === A.host) return A.fetch(url, init);
    if (host === B.host) return B.fetch(url, init);
    throw new Error("offline");
  });
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home box", url: "https://home.k2.dev", username: "r", rememberPassword: false },
      { id: "s2", nickname: "Work box", url: "https://work.k2.dev", username: "r", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "t1", s2: "t2" },
    hydrated: true,
  });
  useHomeServerIds.getState().reload();
  useHomesStore.getState().reload();
  useHomesStore.getState().ensureSeeded();
  __resetHomesSyncForTests({ deviceId: PHONE });
});

afterEach(() => {
  cleanup();
  __resetHomesSyncForTests({ deviceId: PHONE });
  useHomeServerIds.setState({ bySaved: {}, hostByBox: {} });
});

const section = () => screen.findByTestId("server-settings-homesync");

describe("Server settings → Home sync", () => {
  it("hidden without homes-sync-v1 or without a login", async () => {
    A.features = [];
    const { unmount } = render(<HomeSyncSection serverId="s1" label="Home box" />);
    await waitFor(() => expect(useHomesSyncStore.getState().feature.s1).toBe(false));
    expect(screen.queryByTestId("server-settings-homesync")).toBeNull();
    unmount();
    useServersStore.setState({ tokens: { s2: "t2" } });
    A.features = ["homes-sync-v1"];
    render(<HomeSyncSection serverId="s1" label="Home box" />);
    await act(async () => {});
    expect(screen.queryByTestId("server-settings-homesync")).toBeNull();
  });

  it("switch on: registers, syncs, shows the status and this phone in the devices list", async () => {
    render(<HomeSyncSection serverId="s1" label="Home box" />);
    const sec = await section();
    expect(within(sec).getByTestId("homesync-status").textContent).toBe("Not synced");
    const sw = within(sec).getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(within(sec).getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect(within(sec).getByTestId("homesync-status").textContent).toBe("Synced · just now"));
    expect(A.devices.has(PHONE)).toBe(true);
    const row = await within(sec).findByTestId(`homesync-device-${PHONE}`);
    expect(within(row).getByTestId("homesync-this-phone")).toBeTruthy();
  });

  it("switch off: removes this phone there and keeps the Homes", async () => {
    await enableHomesSync("s1");
    const homes = useHomesStore.getState().homes;
    render(<HomeSyncSection serverId="s1" label="Home box" />);
    const sec = await section();
    fireEvent.click(within(sec).getByRole("switch"));
    await waitFor(() => expect(useHomesSyncStore.getState().serverId).toBeNull());
    await waitFor(() => expect(A.devices.has(PHONE)).toBe(false));
    expect(useHomesStore.getState().homes).toBe(homes);
    expect(within(sec).getByTestId("homesync-status").textContent).toBe("Not synced");
  });

  it("another server is the sync server: asks to move, Cancel keeps it, Move moves it", async () => {
    await enableHomesSync("s1");
    render(<HomeSyncSection serverId="s2" label="Work box" />);
    const sec = await section();
    expect(within(sec).getByTestId("homesync-status").textContent).toBe("Home syncs with Home box");
    fireEvent.click(within(sec).getByRole("switch"));
    const confirm = within(sec).getByTestId("homesync-move-confirm");
    expect(confirm.textContent).toContain("Move Home sync from Home box to this server?");
    fireEvent.click(within(confirm).getByTestId("homesync-move-confirm-cancel"));
    expect(useHomesSyncStore.getState().serverId).toBe("s1");
    fireEvent.click(within(sec).getByRole("switch"));
    fireEvent.click(within(sec).getByTestId("homesync-move-confirm-yes"));
    await waitFor(() => expect(useHomesSyncStore.getState().serverId).toBe("s2"));
    expect(B.devices.has(PHONE)).toBe(true);
    await waitFor(() => expect(A.devices.has(PHONE)).toBe(false));
  });

  it("devices: Remove another device after a confirm", async () => {
    A.devices.set("laptop", { deviceId: "laptop", name: "MacBook", platform: "macos", lastSyncAt: Date.now() });
    await enableHomesSync("s1");
    render(<HomeSyncSection serverId="s1" label="Home box" />);
    const sec = await section();
    const laptop = await within(sec).findByTestId("homesync-device-laptop");
    expect(laptop.textContent).toContain("MacBook");
    expect(laptop.textContent).toContain("macOS");
    fireEvent.click(within(laptop).getByTestId("homesync-device-remove-laptop"));
    fireEvent.click(within(laptop).getByTestId("homesync-device-remove-confirm-yes"));
    await waitFor(() => expect(within(sec).queryByTestId("homesync-device-laptop")).toBeNull());
    expect(A.devices.has("laptop")).toBe(false);
    expect(useHomesSyncStore.getState().serverId).toBe("s1");
  });

  it("removed elsewhere (410): the one-time notice, then OK clears it", async () => {
    await enableHomesSync("s1");
    A.removed.add(PHONE);
    render(<HomeSyncSection serverId="s1" label="Home box" />);
    const sec = await section();
    await act(() => syncHomesNow()); // the next pull answers 410
    await waitFor(() => expect(within(sec).getByTestId("homesync-removed-notice").textContent).toBe(
      "This phone was removed from Home sync on Home box.OK"
    ));
    expect(within(sec).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(sec).getByTestId("homesync-removed-notice-ok"));
    expect(within(sec).queryByTestId("homesync-removed-notice")).toBeNull();
  });
});

describe("Home tab badge + Home menu", () => {
  it("no badge when not syncing; the sync server's initial when syncing", async () => {
    const { rerender } = render(<HomeTabToggle tab="home" onTab={() => {}} />);
    expect(screen.queryByTestId("home-sync-badge")).toBeNull();
    expect(screen.getByTestId("list-tab-home").getAttribute("aria-label")).toBe("Home");
    await act(async () => {
      await enableHomesSync("s1");
    });
    rerender(<HomeTabToggle tab="home" onTab={() => {}} />);
    const badge = screen.getByTestId("home-sync-badge");
    expect(badge.textContent).toBe("H");
    expect(badge.getAttribute("data-server-id")).toBe("s1");
    expect(screen.getByTestId("list-tab-home").getAttribute("aria-label")).toBe("Home, synced from Home box");
    act(() => useHomesSyncStore.setState({ serverId: null }));
    expect(screen.queryByTestId("home-sync-badge")).toBeNull();
  });

  it("the Home menu says where Home syncs from, or the removed notice", () => {
    const homes = useHomesStore.getState().homes;
    const base = {
      homes,
      currentId: homes[0].id,
      onSelect: () => {},
      onCreate: () => {},
      onRename: () => {},
      onDelete: () => {},
      onClose: () => {},
    };
    const { rerender } = render(<HomeMenu {...base} />);
    expect(screen.queryByTestId("home-menu-synced-from")).toBeNull();
    rerender(<HomeMenu {...base} syncedFrom="Home box" />);
    expect(screen.getByTestId("home-menu-synced-from").textContent).toBe("Synced from Home box");
    const dismiss = vi.fn();
    rerender(<HomeMenu {...base} syncNotice="Home box" onDismissSyncNotice={dismiss} />);
    expect(screen.getByTestId("home-menu-sync-notice").textContent).toContain(
      "This phone was removed from Home sync on Home box."
    );
    fireEvent.click(screen.getByTestId("home-menu-sync-notice-ok"));
    expect(dismiss).toHaveBeenCalled();
  });
});
