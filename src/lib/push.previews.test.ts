// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

let platform = "apns";
let apsEnv: unknown = "production";
const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "plugin:k2-push|is_available") return { available: true, platform: "ios" };
  if (cmd === "plugin:k2-push|request_permission") return { granted: true };
  if (cmd === "plugin:k2-push|get_token") return { token: "tok", platform };
  if (cmd === "aps_environment") {
    if (apsEnv instanceof Error) throw apsEnv;
    return apsEnv;
  }
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));
const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));
const pushStore: Record<string, unknown> = { enabled: true, deviceId: "dev-1" };
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
vi.mock("../api/client", () => ({
  FEATURE_THREAD_PUSH: "thread-push-v1",
  getBootStatus: vi.fn(),
  serverHasFeature: vi.fn(),
}));

import { getBootStatus } from "../api/client";
import { useServersStore, type ServerEntry } from "../stores/servers";
import { PUSH_PREVIEWS_KEY, usePushPreviewsStore } from "../stores/pushPreviews";
import { readBackPreviews, registerAllSignedIn, resetPushRegisterState, setServerPreviews } from "./push";

const srv = (id: string, url: string): ServerEntry => ({
  id,
  nickname: id,
  url,
  username: "u",
  rememberPassword: false,
});
const HOME = srv("s1", "https://rosson.k2.dev");
const WORK = srv("s2", "https://work.k2.dev");

const posts = () =>
  tauriFetch.mock.calls.map(([url, o]) => ({
    url: String(url),
    body: JSON.parse((o as { body: string }).body) as Record<string, unknown>,
  }));
const bodyFor = (host: string) => posts().find((p) => p.url.includes(host))?.body;

const boot = (byId: Record<string, string[] | null>) =>
  vi.mocked(getBootStatus).mockImplementation(async (scope) => {
    const f = byId[scope.id];
    return f ? ({ features: f } as never) : null;
  });

const reply = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 502,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  platform = "apns";
  apsEnv = "production";
  tauriFetch.mockReset();
  tauriFetch.mockResolvedValue(reply({ ok: true }));
  vi.mocked(getBootStatus).mockReset();
  resetPushRegisterState();
  pushStore.enabled = true;
  localStorage.clear();
  usePushPreviewsStore.setState({ previews: {}, allowed: {}, feature: {}, errors: {} });
  useServersStore.setState({
    servers: [HOME, WORK],
    activeServerId: "s1",
    tokens: { s1: "t1", s2: "t2" },
    recovery: {},
  });
});

describe("register-device previews field", () => {
  it("is never sent without push-previews-v1", async () => {
    boot({ s1: ["thread-push-v1"], s2: ["thread-push-v1"] });
    usePushPreviewsStore.getState().setPref("s1", false);
    await registerAllSignedIn();
    expect(posts()).toHaveLength(2);
    for (const p of posts()) {
      expect(p.body).toEqual({ deviceId: "dev-1", platform: "apns", token: "tok" });
    }
  });

  it("is never sent when the boot-status cannot be read", async () => {
    boot({ s1: null, s2: ["thread-push-v1"] });
    await registerAllSignedIn();
    expect(bodyFor("rosson")).not.toHaveProperty("previews");
  });

  it("is sent with the key: the pref, default true", async () => {
    boot({
      s1: ["thread-push-v1", "push-previews-v1"],
      s2: ["thread-push-v1", "push-previews-v1"],
    });
    usePushPreviewsStore.getState().setPref("s2", false);
    await registerAllSignedIn();
    expect(bodyFor("rosson")).toEqual({
      deviceId: "dev-1",
      platform: "apns",
      token: "tok",
      previews: true,
    });
    expect(bodyFor("work")?.previews).toBe(false);
  });
});

describe("register-device reply", () => {
  it("records previewsAllowed per server and persists it", async () => {
    boot({ s1: ["push-previews-v1"], s2: ["thread-push-v1"] });
    tauriFetch.mockImplementation(async (url: string) =>
      url.includes("rosson")
        ? reply({ ok: true, previews: true, previewsAllowed: false })
        : reply({ ok: true })
    );
    await registerAllSignedIn();
    expect(usePushPreviewsStore.getState().allowed).toEqual({ s1: false });
    expect(JSON.parse(localStorage.getItem(PUSH_PREVIEWS_KEY)!).allowed).toEqual({ s1: false });
  });

  it("trusts the reply's previews over what was just sent", async () => {
    boot({ s1: ["push-previews-v1"] });
    tauriFetch.mockResolvedValue(reply({ previews: false, previewsAllowed: true }));
    await registerAllSignedIn();
    expect(bodyFor("rosson")?.previews).toBe(true);
    expect(usePushPreviewsStore.getState().previews.s1).toBe(false);
    expect(usePushPreviewsStore.getState().allowed.s1).toBe(true);
  });

  it("ignores reply previews when none were sent", async () => {
    boot({ s1: ["thread-push-v1"] });
    tauriFetch.mockResolvedValue(reply({ previews: false }));
    await registerAllSignedIn();
    expect(usePushPreviewsStore.getState().previews).toEqual({});
  });
});

describe("register-device environment field", () => {
  it("is not sent without push-environment-v1", async () => {
    boot({ s1: ["push-previews-v1"] });
    await registerAllSignedIn();
    expect(bodyFor("rosson")).not.toHaveProperty("environment");
    expect(invoke).not.toHaveBeenCalledWith("aps_environment");
  });

  it("is the build's APNs environment with the key", async () => {
    boot({ s1: ["push-environment-v1"], s2: ["thread-push-v1", "push-environment-v1"] });
    apsEnv = "development";
    await registerAllSignedIn();
    expect(bodyFor("rosson")).toEqual({
      deviceId: "dev-1",
      platform: "apns",
      token: "tok",
      environment: "development",
    });
    expect(bodyFor("work")?.environment).toBe("development");
  });

  it("is skipped when the build cannot say, and for FCM", async () => {
    boot({ s1: ["push-environment-v1"] });
    apsEnv = new Error("no such command");
    await registerAllSignedIn();
    expect(bodyFor("rosson")).not.toHaveProperty("environment");

    tauriFetch.mockClear();
    resetPushRegisterState();
    apsEnv = "production";
    platform = "fcm";
    await registerAllSignedIn();
    expect(bodyFor("rosson")).not.toHaveProperty("environment");
  });
});

describe("setServerPreviews (the Server settings toggle)", () => {
  it("re-registers with that server only, carrying the new value", async () => {
    boot({ s1: ["push-previews-v1"], s2: ["push-previews-v1"] });
    await expect(setServerPreviews("s2", false)).resolves.toBe(true);
    expect(posts().map((p) => p.url)).toEqual(["https://work.k2.dev/cli/push/register-device"]);
    expect(posts()[0].body.previews).toBe(false);
    expect(usePushPreviewsStore.getState().previews.s2).toBe(false);
    expect(JSON.parse(localStorage.getItem(PUSH_PREVIEWS_KEY)!).previews).toEqual({ s2: false });
    expect(usePushPreviewsStore.getState().errors.s2).toBeNull();
  });

  it("is optimistic, then reverts with an error when the server refuses", async () => {
    boot({ s2: ["push-previews-v1"] });
    let release: (v: unknown) => void = () => {};
    tauriFetch.mockImplementation(
      () => new Promise((r) => (release = () => r(reply({ error: "nope" }, false))))
    );
    const run = setServerPreviews("s2", false);
    expect(usePushPreviewsStore.getState().previews.s2).toBe(false);
    await vi.waitFor(() => expect(tauriFetch).toHaveBeenCalled());
    release(null);
    await expect(run).resolves.toBe(false);
    expect(usePushPreviewsStore.getState().previews.s2).toBe(true);
    expect(usePushPreviewsStore.getState().errors.s2).toBe("Could not save. Try again.");
  });

  it("a later success clears the error", async () => {
    boot({ s2: ["push-previews-v1"] });
    tauriFetch.mockResolvedValueOnce(reply({}, false));
    await setServerPreviews("s2", false);
    expect(usePushPreviewsStore.getState().errors.s2).toBeTruthy();
    await setServerPreviews("s2", false);
    expect(usePushPreviewsStore.getState().errors.s2).toBeNull();
    expect(usePushPreviewsStore.getState().previews.s2).toBe(false);
  });

  it("with push off on this phone, just saves the pref", async () => {
    pushStore.enabled = false;
    boot({ s2: ["push-previews-v1"] });
    await expect(setServerPreviews("s2", false)).resolves.toBe(true);
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(usePushPreviewsStore.getState().previews.s2).toBe(false);
  });
});

describe("read-back (GET /cli/push/device)", () => {
  it("takes the server's stored choice and the owner switch", async () => {
    vi.mocked((await import("../api/client")).serverHasFeature).mockResolvedValue(true);
    tauriFetch.mockResolvedValue(reply({ ok: true, previews: false, previewsAllowed: false }));
    await readBackPreviews("s2");
    const [url, o] = tauriFetch.mock.calls[0] as [string, { method: string }];
    expect(url).toBe("https://work.k2.dev/cli/push/device?deviceId=dev-1");
    expect(o.method).toBe("GET");
    expect(usePushPreviewsStore.getState().previews.s2).toBe(false);
    expect(usePushPreviewsStore.getState().allowed.s2).toBe(false);
  });

  it("does nothing without the feature or on a 404", async () => {
    const client = await import("../api/client");
    vi.mocked(client.serverHasFeature).mockResolvedValue(false);
    await readBackPreviews("s2");
    expect(tauriFetch).not.toHaveBeenCalled();
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    tauriFetch.mockResolvedValue({ ok: false, status: 404, text: async () => "{}" });
    await readBackPreviews("s2");
    expect(usePushPreviewsStore.getState().previews.s2).toBeUndefined();
  });
});
