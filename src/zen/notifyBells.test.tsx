// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn(async () => { throw new Error("offline"); }) }));
vi.mock("../api/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/client")>();
  return {
    ...real,
    serverHasFeature: vi.fn(),
    getNotifyPrefs: vi.fn(),
    setNotifyPrefs: vi.fn(),
  };
});
vi.mock("../lib/revive", () => ({ connectServer: vi.fn() }));
const prefsEvents: Array<() => void> = [];
vi.mock("./ticketEvents", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ticketEvents")>();
  return {
    ...real,
    connectNotifyPrefsEvents: vi.fn((_scope: unknown, cb: () => void) => {
      prefsEvents.push(cb);
      return { stop: vi.fn() };
    }),
  };
});

import { getNotifyPrefs, serverHasFeature, setNotifyPrefs } from "../api/client";
import { useServersStore } from "../stores/servers";
import { useNotifyPrefsStore } from "../stores/notifyPrefs";
import { OverlayServers } from "./OverlayServers";
import { SessionsPane } from "./SessionsPane";
import { connectNotifyPrefsEvents } from "./ticketEvents";

const prefs = (over: Record<string, unknown> = {}) => ({
  ok: true,
  principal: "owner",
  server: { enabled: true, source: "fallback" },
  default: true,
  devices: 1,
  push: "ready",
  workspaces: [
    { projectId: "p1", name: "k2", handle: "k2", threadPush: true, source: "default" },
  ],
  ...over,
});

beforeEach(() => {
  prefsEvents.length = 0;
  vi.mocked(serverHasFeature).mockReset();
  vi.mocked(getNotifyPrefs).mockReset();
  vi.mocked(setNotifyPrefs).mockReset();
  vi.mocked(connectNotifyPrefsEvents).mockClear();
  useNotifyPrefsStore.setState({ threadPush: {}, prefs: {}, errors: {} });
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "baden", rememberPassword: false },
      { id: "s2", nickname: "Other", url: "https://other.k2.dev", username: "baden", rememberPassword: false },
    ],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t1", s2: "t2" },
    recovery: { s1: "connected", s2: "connected" },
  });
});
afterEach(() => cleanup());

describe("Servers sheet bell", () => {
  it("hidden on every server without thread-push-v1; nothing fetched", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(false);
    render(<OverlayServers onClose={() => {}} />);
    await waitFor(() => expect(serverHasFeature).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId("server-bell")).toBeNull();
    expect(screen.queryByTestId("server-notify-status")).toBeNull();
    expect(getNotifyPrefs).not.toHaveBeenCalled();
    expect(connectNotifyPrefsEvents).not.toHaveBeenCalled();
  });

  it("a bell + status per server; the other server's bell writes to THAT server", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockImplementation(async (scope) =>
      scope.id === "s2" ? { ok: true, data: prefs({ push: "dormant" }) } : { ok: true, data: prefs() }
    );
    vi.mocked(setNotifyPrefs).mockResolvedValue({ ok: true, data: prefs({ server: { enabled: false, source: "user" } }) });
    render(<OverlayServers onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("server-bell")).toHaveLength(2));
    const pinned = screen.getByTestId("servers-pinned");
    expect(within(pinned).getByTestId("server-notify-status").textContent).toBe("Notifications on");
    const list = screen.getByTestId("overlay-servers-list");
    expect(within(list).getByTestId("server-notify-status").textContent).toBe("Can't send pushes yet");
    fireEvent.click(within(list).getByTestId("server-bell"));
    expect(setNotifyPrefs).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }), { server: { enabled: false } });
    await waitFor(() =>
      expect(within(list).getByTestId("server-notify-status").textContent).toBe("Notifications off")
    );
    expect(within(list).getByTestId("server-bell").getAttribute("aria-pressed")).toBe("false");
  });

  it("a failed toggle rolls the bell back", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue({ ok: true, data: prefs() });
    vi.mocked(setNotifyPrefs).mockResolvedValue({ ok: false, error: "HTTP 500", status: 500 });
    render(<OverlayServers onClose={() => {}} />);
    const pinned = await screen.findByTestId("servers-pinned");
    const bell = await within(pinned).findByTestId("server-bell");
    fireEvent.click(bell);
    await waitFor(() => expect(setNotifyPrefs).toHaveBeenCalled());
    await waitFor(() => expect(within(pinned).getByTestId("server-bell").getAttribute("aria-pressed")).toBe("true"));
    expect(within(pinned).getByTestId("server-notify-status").textContent).toContain("Could not save");
  });

  it("air-gap status", async () => {
    vi.mocked(serverHasFeature).mockImplementation(async (scope) => scope.id === "s1");
    vi.mocked(getNotifyPrefs).mockResolvedValue({ ok: true, data: prefs({ push: "airgap" }) });
    render(<OverlayServers onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("server-notify-status").textContent).toBe("Off: air-gap"));
    expect(screen.getAllByTestId("server-bell")).toHaveLength(1);
  });

  it("notify_prefs_changed refetches the active server's prefs", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue({ ok: true, data: prefs() });
    render(<OverlayServers onClose={() => {}} />);
    await waitFor(() => expect(prefsEvents.length).toBeGreaterThan(0));
    vi.mocked(getNotifyPrefs).mockResolvedValue({
      ok: true,
      data: prefs({ server: { enabled: false, source: "user" } }),
    });
    const before = vi.mocked(getNotifyPrefs).mock.calls.length;
    await act(async () => prefsEvents[prefsEvents.length - 1]());
    expect(vi.mocked(getNotifyPrefs).mock.calls.length).toBe(before + 1);
    expect(vi.mocked(getNotifyPrefs).mock.lastCall?.[0]?.id).toBe("s1");
    const pinned = screen.getByTestId("servers-pinned");
    await waitFor(() =>
      expect(within(pinned).getByTestId("server-notify-status").textContent).toBe("Notifications off")
    );
  });
});

const MAIN = { id: "/ws", name: "K2", initial: "K", path: "/ws", addr: "k2", joinMiss: null, kind: "agent" as const };
const SIDE = { ...MAIN, id: "/ws::k2/reviewer", addr: "k2/reviewer" };

describe("Sessions drawer workspace bell", () => {
  const renderPane = (agent = MAIN) =>
    render(<SessionsPane agent={agent} onClose={() => {}} onOpenTerminal={() => {}} />);

  it("hidden without thread-push-v1", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(false);
    renderPane();
    await waitFor(() => expect(serverHasFeature).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("workspace-notify")).toBeNull();
    expect(getNotifyPrefs).not.toHaveBeenCalled();
  });

  it("shows Default (on), toggles off, then Set by you + Reset sends null", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue({ ok: true, data: prefs() });
    renderPane();
    const box = await screen.findByTestId("workspace-notify");
    expect(box.textContent).toContain("Notifications for k2");
    expect(screen.getByTestId("workspace-notify-source").textContent).toBe("Default (on)");
    expect(screen.queryByTestId("workspace-notify-reset")).toBeNull();

    vi.mocked(setNotifyPrefs).mockResolvedValue({
      ok: true,
      data: prefs({
        workspaces: [{ projectId: "p1", name: "k2", handle: "k2", threadPush: false, source: "user", updatedBy: "owner" }],
      }),
    });
    fireEvent.click(screen.getByTestId("workspace-bell"));
    expect(setNotifyPrefs).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), { workspace: { projectId: "p1", threadPush: false } });
    await waitFor(() => expect(screen.getByTestId("workspace-notify-source").textContent).toBe("Set by you"));
    expect(screen.getByTestId("workspace-bell").getAttribute("aria-checked")).toBe("false");

    vi.mocked(setNotifyPrefs).mockResolvedValue({ ok: true, data: prefs() });
    fireEvent.click(screen.getByTestId("workspace-notify-reset"));
    expect(setNotifyPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s1" }), { workspace: { projectId: "p1", threadPush: null } });
    await waitFor(() => expect(screen.getByTestId("workspace-notify-source").textContent).toBe("Default (on)"));
  });

  it("Set by another person; a sidecar shares its workspace's bell", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue({
      ok: true,
      data: prefs({
        workspaces: [{ projectId: "p1", name: "k2", handle: "k2", threadPush: false, source: "user", updatedBy: "gina" }],
      }),
    });
    renderPane(SIDE);
    await waitFor(() => expect(screen.getByTestId("workspace-notify-source").textContent).toBe("Set by gina"));
    expect(screen.getByTestId("workspace-notify-reset")).not.toBeNull();
  });
});
