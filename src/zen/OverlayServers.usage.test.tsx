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

beforeEach(() => {
  __resetScopesForTests();
  tauriFetch.mockReset();
  tauriFetch.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/cli/llm/accounts/list") return ok(listBody());
    if (path === "/cli/llm/accounts/refresh") return ok({ accounts: [], usageChecked: true });
    throw new Error("offline");
  });
  vi.mocked(serverHasFeature).mockReset();
  vi.mocked(getNotifyPrefs).mockReset();
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

describe("Servers sheet usage button", () => {
  it("sits immediately right of the bell on the active server's card only", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue({
      ok: true,
      data: {
        ok: true,
        principal: "owner",
        server: { enabled: true, source: "fallback" },
        default: true,
        devices: 1,
        push: "ready",
        workspaces: [],
      },
    } as never);
    render(<OverlayServers onClose={() => {}} />);
    const pinned = screen.getByTestId("servers-pinned");
    const bell = await within(pinned).findByTestId("server-bell");
    const usage = within(pinned).getByTestId("server-usage");
    expect(bell.nextElementSibling).toBe(usage);
    expect(usage.getAttribute("aria-label")).toBe("Usage on Home");
    expect(usage.querySelector("svg")?.getAttribute("data-k2-icon")).toBe("gauge");
    expect(within(screen.getByTestId("overlay-servers-list")).queryByTestId("server-usage")).toBeNull();
  });

  it("shows without the bell (no thread-push-v1) and opens the Usage page; back returns to Servers", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(false);
    const onClose = vi.fn();
    render(<OverlayServers onClose={onClose} />);
    expect(screen.queryByTestId("server-bell")).toBeNull();
    fireEvent.click(screen.getByTestId("server-usage"));
    const page = await screen.findByTestId("usage-page");
    expect(within(page).getByTestId("usage-server").textContent).toBe("Home");
    expect(await within(page).findByTestId("usage-tool-claude")).toBeTruthy();
    expect(new URL(tauriFetch.mock.calls[0][0] as string).host).toBe("home.k2.dev");

    // Android Back closes the page, not the Servers sheet.
    expect(handleAndroidBack()).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("usage-page")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("overlay-servers")).toBeTruthy();

    fireEvent.click(screen.getByTestId("server-usage"));
    fireEvent.click(await screen.findByTestId("usage-back"));
    await waitFor(() => expect(screen.queryByTestId("usage-page")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hidden while the active server has no session token", () => {
    vi.mocked(serverHasFeature).mockResolvedValue(false);
    useServersStore.setState({ tokens: { s2: "t2" } });
    render(<OverlayServers onClose={() => {}} />);
    expect(screen.queryByTestId("server-usage")).toBeNull();
  });
});
