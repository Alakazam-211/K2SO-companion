import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("../api/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/client")>();
  return {
    ...real,
    serverHasFeature: vi.fn(),
    getNotifyPrefs: vi.fn(),
    setNotifyPrefs: vi.fn(),
  };
});

import { getNotifyPrefs, serverHasFeature, setNotifyPrefs, type NotifyPrefs } from "../api/client";
import {
  serverBellStatus,
  useNotifyPrefsStore,
  workspacePrefFor,
  workspaceSourceText,
} from "./notifyPrefs";

const PREFS = {
  ok: true,
  principal: "owner",
  server: { enabled: true, source: "fallback" },
  default: true,
  devices: 1,
  push: "ready",
  workspaces: [
    { projectId: "p1", name: "k2", handle: "k2", threadPush: true, source: "default" },
    { projectId: "p2", name: "web", handle: "web", threadPush: false, source: "user", updatedBy: "owner" },
  ],
};

beforeEach(() => {
  vi.mocked(serverHasFeature).mockReset();
  vi.mocked(getNotifyPrefs).mockReset();
  vi.mocked(setNotifyPrefs).mockReset();
  useNotifyPrefsStore.setState({ threadPush: {}, prefs: {}, errors: {} });
});

describe("feature gate", () => {
  it("without thread-push-v1 nothing is fetched", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(false);
    await useNotifyPrefsStore.getState().load("s1");
    expect(useNotifyPrefsStore.getState().threadPush.s1).toBe(false);
    expect(getNotifyPrefs).not.toHaveBeenCalled();
    expect(useNotifyPrefsStore.getState().prefs.s1).toBeUndefined();
    expect(await useNotifyPrefsStore.getState().setServerEnabled("s1", false)).toBe(false);
    expect(setNotifyPrefs).not.toHaveBeenCalled();
  });

  it("with the feature, prefs load for that server", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    vi.mocked(getNotifyPrefs).mockResolvedValue({ ok: true, data: PREFS });
    await useNotifyPrefsStore.getState().load("s2");
    expect(getNotifyPrefs).toHaveBeenCalledWith("s2");
    expect(useNotifyPrefsStore.getState().prefs.s2?.server.enabled).toBe(true);
  });
});

async function loaded(id = "s1") {
  vi.mocked(serverHasFeature).mockResolvedValue(true);
  vi.mocked(getNotifyPrefs).mockResolvedValue({ ok: true, data: PREFS });
  await useNotifyPrefsStore.getState().load(id);
}

describe("server bell", () => {
  it("toggles server.enabled optimistically, then takes the server's answer", async () => {
    await loaded("s2");
    let release!: (v: unknown) => void;
    vi.mocked(setNotifyPrefs).mockReturnValue(new Promise((r) => (release = r)) as never);
    const p = useNotifyPrefsStore.getState().setServerEnabled("s2", false);
    expect(useNotifyPrefsStore.getState().prefs.s2?.server.enabled).toBe(false);
    expect(setNotifyPrefs).toHaveBeenCalledWith({ server: { enabled: false } }, "s2");
    release({ ok: true, data: { ...PREFS, server: { enabled: false, source: "user" } } });
    expect(await p).toBe(true);
    expect(useNotifyPrefsStore.getState().prefs.s2?.server).toEqual({ enabled: false, source: "user" });
  });

  it("rolls back and keeps the error when the write fails", async () => {
    await loaded();
    vi.mocked(setNotifyPrefs).mockResolvedValue({ ok: false, error: "HTTP 500", status: 500 });
    expect(await useNotifyPrefsStore.getState().setServerEnabled("s1", false)).toBe(false);
    expect(useNotifyPrefsStore.getState().prefs.s1?.server.enabled).toBe(true);
    expect(useNotifyPrefsStore.getState().errors.s1).toBe("HTTP 500");
  });
});

describe("workspace bell", () => {
  it("Reset sends threadPush null and shows the default meanwhile", async () => {
    await loaded();
    vi.mocked(setNotifyPrefs).mockResolvedValue({ ok: true, data: PREFS });
    const p = useNotifyPrefsStore.getState().setWorkspacePush("s1", "p2", null);
    const ws = useNotifyPrefsStore.getState().prefs.s1!.workspaces[1];
    expect(ws).toMatchObject({ source: "default", threadPush: true });
    expect(setNotifyPrefs).toHaveBeenCalledWith({ workspace: { projectId: "p2", threadPush: null } }, "s1");
    await p;
  });

  it("a workspace write rolls back on error", async () => {
    await loaded();
    vi.mocked(setNotifyPrefs).mockRejectedValue(new Error("offline"));
    await useNotifyPrefsStore.getState().setWorkspacePush("s1", "p1", false);
    expect(useNotifyPrefsStore.getState().prefs.s1!.workspaces[0]).toMatchObject({ threadPush: true, source: "default" });
  });
});

describe("copy", () => {
  const base = { principal: "owner", server: { enabled: true, source: "user" }, default: true, devices: 1, workspaces: [] } as Omit<NotifyPrefs, "push">;
  it("server status for ready / dormant / airgap / off", () => {
    expect(serverBellStatus({ ...base, push: "ready" })).toBe("Notifications on");
    expect(serverBellStatus({ ...base, push: "dormant" })).toBe("Can't send pushes yet");
    expect(serverBellStatus({ ...base, push: "airgap" })).toBe("Off: air-gap");
    expect(serverBellStatus({ ...base, push: "ready", server: { enabled: false, source: "user" } })).toBe(
      "Notifications off"
    );
    // Air-gap wins over the user's own switch.
    expect(serverBellStatus({ ...base, push: "airgap", server: { enabled: false, source: "user" } })).toBe(
      "Off: air-gap"
    );
  });

  it("workspace source text", () => {
    const w = { projectId: "p", name: "k2", handle: "k2" };
    expect(workspaceSourceText({ ...w, threadPush: true, source: "default" }, "owner")).toBe("Default (on)");
    expect(workspaceSourceText({ ...w, threadPush: false, source: "fallback" }, "owner")).toBe("Default (off)");
    expect(workspaceSourceText({ ...w, threadPush: false, source: "user", updatedBy: "owner" }, "owner")).toBe(
      "Set by you"
    );
    expect(workspaceSourceText({ ...w, threadPush: false, source: "user", updatedBy: "gina" }, "owner")).toBe(
      "Set by gina"
    );
  });

  it("finds a chat's workspace by handle (sidecars share it), then project id", async () => {
    await loaded();
    const p = useNotifyPrefsStore.getState().prefs.s1;
    expect(workspacePrefFor(p, { handle: "k2/reviewer" })?.projectId).toBe("p1");
    expect(workspacePrefFor(p, { handle: "nope", projectId: "p2" })?.projectId).toBe("p2");
    expect(workspacePrefFor(p, { handle: "nope" })).toBeNull();
  });
});
