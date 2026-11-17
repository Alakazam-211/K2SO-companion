// Push on by default (4.3.0): a never-set preference counts as on, but
// never brings up iOS's alert cold; it registers only once iOS already
// allows notifications. An explicit off is kept; an explicit on (Settings
// toggle, the onboarding prompt's yes) asks as before.
import { beforeEach, describe, expect, it, vi } from "vitest";

const os = vi.hoisted(() => ({ state: "notDetermined" as string | Error }));
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "plugin:k2-push|is_available") return { available: true, platform: "ios" };
  if (cmd === "plugin:k2-push|request_permission") return { granted: true };
  if (cmd === "plugin:k2-push|get_token") return { token: "apns-tok", platform: "apns" };
  if (cmd === "plugin:k2-push|notification_op") {
    if (args?.op === "state") {
      if (os.state instanceof Error) throw os.state;
      return { state: os.state };
    }
    if (args?.op === "openSettings") return { ok: true };
  }
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));
const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));
const pushStore: Record<string, unknown> = { deviceId: "dev-1" };
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => pushStore[k],
    set: async (k: string, v: unknown) => {
      pushStore[k] = v;
    },
    save: async () => {},
    delete: async () => {},
  })),
}));
vi.mock("./revive", () => ({ connectServer: vi.fn() }));
vi.mock("../zen/calls/dmCall", () => ({ routeCallTap: vi.fn() }));
vi.mock("../zen/approvals", () => ({ openApproval: vi.fn() }));
vi.mock("../api/client", () => ({
  FEATURE_THREAD_PUSH: "thread-push-v1",
  getBootStatus: vi.fn(async () => null),
}));

import { useMultiServerPrefs } from "../zen/multi/prefs";
import { useServersStore } from "../stores/servers";
import {
  getPushEnabled,
  getPushPref,
  notificationState,
  openNotificationSettings,
  registerAllSignedIn,
  requestPushPermission,
  resetPushRegisterState,
} from "./push";

const called = (cmd: string) => invoke.mock.calls.filter(([c]) => c === `plugin:k2-push|${cmd}`).length;
const posts = () => tauriFetch.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  useMultiServerPrefs.setState({ multiServer: false });
  invoke.mockClear();
  tauriFetch.mockReset();
  tauriFetch.mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
  resetPushRegisterState();
  delete pushStore.enabled;
  os.state = "notDetermined";
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "s1", url: "https://riley.k2.dev", username: "u", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t1" },
    recovery: {},
  });
});

describe("push preference default", () => {
  it("never set + iOS not asked yet: no cold alert, nothing registered, the switch shows off", async () => {
    await registerAllSignedIn();
    expect(called("request_permission")).toBe(0);
    expect(called("get_token")).toBe(0);
    expect(posts()).toEqual([]);
    expect(await getPushPref()).toBeNull();
    expect(await getPushEnabled()).toBe(false);
  });

  it("never set + iOS denied: nothing asked, nothing registered", async () => {
    os.state = "denied";
    await registerAllSignedIn();
    expect(called("request_permission")).toBe(0);
    expect(posts()).toEqual([]);
    expect(await getPushEnabled()).toBe(false);
  });

  it.each(["authorized", "provisional", "ephemeral"])("never set + iOS %s: on, and registers", async (state) => {
    os.state = state;
    await registerAllSignedIn();
    expect(posts()).toEqual(["https://riley.k2.dev/cli/push/register-device"]);
    expect(await getPushEnabled()).toBe(true);
  });

  it("an explicit off is kept, whatever iOS says", async () => {
    pushStore.enabled = false;
    os.state = "authorized";
    await registerAllSignedIn();
    expect(called("request_permission")).toBe(0);
    expect(posts()).toEqual([]);
    expect(await getPushEnabled()).toBe(false);
  });

  it("an explicit on asks iOS as before", async () => {
    pushStore.enabled = true;
    await registerAllSignedIn();
    expect(called("request_permission")).toBe(1);
    expect(called("notification_op")).toBe(0);
    expect(posts()).toEqual(["https://riley.k2.dev/cli/push/register-device"]);
    expect(await getPushEnabled()).toBe(true);
  });

  it("no permission state from native (Android, older build): never set stays quiet", async () => {
    os.state = new Error("No command notificationOp found");
    expect(await notificationState()).toBe("unknown");
    await registerAllSignedIn();
    expect(called("request_permission")).toBe(0);
    expect(await getPushEnabled()).toBe(false);
  });

  it("an unexpected native state reads as unknown", async () => {
    os.state = "somethingNew";
    expect(await notificationState()).toBe("unknown");
  });
});

describe("permission helpers", () => {
  it("requestPushPermission answers the grant", async () => {
    expect(await requestPushPermission()).toBe(true);
    expect(called("request_permission")).toBe(1);
  });

  it("openNotificationSettings sends the openSettings op", async () => {
    expect(await openNotificationSettings()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("plugin:k2-push|notification_op", { op: "openSettings" });
  });
});
