// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));
vi.mock("../api/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/client")>();
  return {
    ...real,
    checkDaemonUpdate: vi.fn(),
    startDaemonUpdate: vi.fn(),
    getDaemonUpdateStatus: vi.fn(),
    applyDaemonUpdate: vi.fn(),
  };
});
vi.mock("../lib/openExternal", () => ({ openExternal: vi.fn(async () => {}) }));

import {
  applyDaemonUpdate,
  checkDaemonUpdate,
  getDaemonUpdateStatus,
  startDaemonUpdate,
} from "../api/client";
import { __resetScopesForTests, scopeFor } from "../api/scope";
import { __resetEventsHoldForTests } from "../api/eventsHold";
import { openExternal } from "../lib/openExternal";
import { useServersStore } from "../stores/servers";
import { ServerUpdateSection } from "./ServerUpdateSection";
import { __resetServerUpdateForTests } from "./serverUpdateStore";

const ok = (body: unknown) => ({
  status: 200,
  ok: true,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let boot: Record<string, unknown> = { version: "0.46.0", phase: "ready", instanceId: "aaaa", features: [] };

function checkBody(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      current: "0.46.0",
      latest: "0.46.1",
      available: true,
      installKind: "standalone",
      platform: "linux-x86_64",
      ...over,
    },
  };
}

beforeEach(() => {
  __resetScopesForTests();
  __resetEventsHoldForTests();
  __resetServerUpdateForTests();
  boot = { version: "0.46.0", phase: "ready", instanceId: "aaaa", features: [] };
  tauriFetch.mockReset();
  tauriFetch.mockImplementation(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/boot-status") return ok(boot);
    throw new Error("offline");
  });
  vi.mocked(checkDaemonUpdate).mockReset();
  vi.mocked(checkDaemonUpdate).mockResolvedValue(checkBody());
  vi.mocked(startDaemonUpdate).mockReset();
  vi.mocked(startDaemonUpdate).mockResolvedValue({ ok: true, data: { job_id: "j1" } });
  vi.mocked(getDaemonUpdateStatus).mockReset();
  vi.mocked(getDaemonUpdateStatus).mockResolvedValue({
    ok: true,
    data: { job_id: "j1", phase: "downloading", progress: 0, bytes: null, error: null },
  });
  vi.mocked(applyDaemonUpdate).mockReset();
  vi.mocked(openExternal).mockClear();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Home", url: "https://home.k2.dev", username: "baden", rememberPassword: false }],
    activeServerId: "s1",
    hydrated: true,
    tokens: { s1: "t1" },
    recovery: { s1: "connected" },
  });
});

afterEach(() => {
  cleanup();
  __resetServerUpdateForTests();
});

function renderSection(role: string | null) {
  return render(<ServerUpdateSection serverId="s1" scope={scopeFor("s1")} role={role} />);
}

describe("ServerUpdateSection visibility", () => {
  it("a Member sees only the version: no controls, no check", async () => {
    renderSection("member");
    expect((await screen.findByText("K2 0.46.0")).getAttribute("data-testid")).toBe("server-version");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("server-update-check")).toBeNull();
    expect(screen.queryByTestId("server-update-result")).toBeNull();
    expect(checkDaemonUpdate).not.toHaveBeenCalled();
  });

  it("air-gap on /boot-status hides the controls (Owner)", async () => {
    boot = { ...boot, airgap: { enabled: true, baked: false } };
    renderSection("owner");
    expect(await screen.findByTestId("server-update-airgap")).toBeTruthy();
    expect(screen.queryByTestId("server-update-check")).toBeNull();
    expect(checkDaemonUpdate).not.toHaveBeenCalled();
  });

  it("an air-gap 403 from check hides the controls with a note", async () => {
    vi.mocked(checkDaemonUpdate).mockResolvedValue({
      ok: false,
      status: 403,
      error: "Air-gap is on (K2_AIRGAP=1). This daemon will not start a tunnel or phone Connect, cert, GitHub, or other hosted services.",
    });
    renderSection("admin");
    expect(await screen.findByTestId("server-update-airgap")).toBeTruthy();
    expect(screen.queryByTestId("server-update-check")).toBeNull();
  });
});

describe("ServerUpdateSection check", () => {
  it("auto-checks once on open and shows an available update with release notes", async () => {
    renderSection("admin");
    const result = await screen.findByTestId("server-update-result");
    expect(result.textContent).toBe("Update available: 0.46.0 → 0.46.1");
    expect(checkDaemonUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("server-update-notes"));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/Alakazam-211/K2/releases/tag/v0.46.1");

    // Reopen the page: the stored result shows, no second request.
    cleanup();
    renderSection("admin");
    expect((await screen.findByTestId("server-update-result")).textContent).toBe(
      "Update available: 0.46.0 → 0.46.1"
    );
    expect(checkDaemonUpdate).toHaveBeenCalledTimes(1);
  });

  it("up to date", async () => {
    vi.mocked(checkDaemonUpdate).mockResolvedValue(checkBody({ available: false, latest: "0.46.0" }));
    renderSection("owner");
    expect((await screen.findByTestId("server-update-result")).textContent).toBe("K2 is up to date (0.46.0)");
  });

  it("newer version without a build for the platform", async () => {
    vi.mocked(checkDaemonUpdate).mockResolvedValue(checkBody({ available: false, newerNoArtifact: true }));
    renderSection("owner");
    expect((await screen.findByTestId("server-update-result")).textContent).toBe(
      "A newer version (v0.46.1) exists, but there's no build for Home's platform (linux-x86_64). Nothing to install yet."
    );
  });

  it("403 role_required shows the desktop's permission text", async () => {
    vi.mocked(checkDaemonUpdate).mockResolvedValue({ ok: false, status: 403, error: "role_required" });
    renderSection("admin");
    expect((await screen.findByTestId("server-update-result")).textContent).toBe(
      "You don't have permission to update Home. Only the host owner or an admin can update it."
    );
  });

  it("network error shows inline with Retry", async () => {
    vi.mocked(checkDaemonUpdate).mockResolvedValueOnce({ ok: false, error: "Could not reach server: offline" });
    renderSection("admin");
    expect((await screen.findByTestId("server-update-error")).textContent).toContain("Could not reach server");
    vi.mocked(checkDaemonUpdate).mockResolvedValueOnce(checkBody({ available: false, latest: "0.46.0" }));
    fireEvent.click(screen.getByTestId("server-update-retry"));
    expect((await screen.findByTestId("server-update-result")).textContent).toBe("K2 is up to date (0.46.0)");
    expect(checkDaemonUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("ServerUpdateSection confirm + run", () => {
  it("standalone: agents warning first, Download & install, Cancel closes", async () => {
    renderSection("admin");
    fireEvent.click(await screen.findByTestId("server-update-update"));
    const sheet = screen.getByTestId("server-update-confirm");
    expect(within(sheet).getByTestId("server-update-confirm-title").textContent).toBe("Update Home to 0.46.1?");
    const warning = within(sheet).getByTestId("server-update-confirm-warning");
    expect(warning.textContent).toBe(
      "Running agents on this server will be stopped and restarted. Anything they're in the middle of will be interrupted."
    );
    // First thing under the title.
    expect(within(sheet).getByTestId("server-update-confirm-title").nextElementSibling).toBe(warning);
    expect(within(sheet).getByTestId("server-update-confirm-body").textContent).toContain(
      "the REMOTE machine you're connected to, not this phone"
    );
    expect(within(sheet).getByTestId("server-update-confirm-go").textContent).toBe("Download & install");
    fireEvent.click(within(sheet).getByTestId("server-update-confirm-cancel"));
    expect(screen.queryByTestId("server-update-confirm")).toBeNull();
    expect(startDaemonUpdate).not.toHaveBeenCalled();
  });

  it("bundled-app: Update Host", async () => {
    vi.mocked(checkDaemonUpdate).mockResolvedValue(checkBody({ installKind: "bundled-app" }));
    renderSection("owner");
    fireEvent.click(await screen.findByTestId("server-update-update"));
    expect(screen.getByTestId("server-update-confirm-go").textContent).toBe("Update Host");
  });

  it("Update runs start and shows progress", async () => {
    renderSection("admin");
    fireEvent.click(await screen.findByTestId("server-update-update"));
    fireEvent.click(screen.getByTestId("server-update-confirm-go"));
    await waitFor(() => expect(startDaemonUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("server-update-confirm")).toBeNull();
    expect(await screen.findByTestId("server-update-bar")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("server-update-detail").textContent).toBe("Downloading update for Home…")
    );
    expect(screen.getByTestId("server-update-headline").textContent).toBe("Updating…");
    expect(applyDaemonUpdate).not.toHaveBeenCalled();
  });

  it("a failed job shows the error and Still on {current}", async () => {
    vi.mocked(getDaemonUpdateStatus).mockResolvedValue({
      ok: true,
      data: { job_id: "j1", phase: "failed", progress: 0, bytes: null, error: "minisign verify failed" },
    });
    renderSection("admin");
    fireEvent.click(await screen.findByTestId("server-update-update"));
    fireEvent.click(screen.getByTestId("server-update-confirm-go"));
    expect((await screen.findByTestId("server-update-still-on")).textContent).toBe("Still on 0.46.0");
    expect(screen.getByTestId("server-update-headline").textContent).toBe("minisign verify failed");
  });
});
