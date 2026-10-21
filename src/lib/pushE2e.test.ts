// End-to-end encrypted pushes, app side (K2 0.46.3 `push-e2e-v1`): the
// direct-path rule, reply parsing, and the sealed registration flow.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "plugin:k2-push|is_available") return { available: true, platform: "apns" };
  if (cmd === "plugin:k2-push|request_permission") return { granted: true };
  if (cmd === "plugin:k2-push|get_token") return { token: "apns-tok", platform: "apns" };
  if (cmd === "aps_environment") return "production";
  if (cmd === "plugin:k2-push|e2e_op") {
    if (args?.op === "key") {
      return {
        available: true,
        deviceId: `dev-${args.server}`,
        publicKey: args.rotate ? "PUB2" : "PUB1",
        psk: "PSK",
        createdAt: 1760960000,
        keyId: "982d0dfe762a03f5",
      };
    }
    return { available: true };
  }
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));
const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));
const pushStore: Record<string, unknown> = {};
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

import { __resetScopesForTests, noteBootStatus } from "../api/scope";
import { useServersStore, type ServerEntry } from "../stores/servers";
import { useMultiServerPrefs } from "../zen/multi/prefs";
import { ensureRegistered, resetPushRegisterState, unregisterLeaving } from "./push";
import { scopeFor } from "../api/scope";
import { directLabel, e2eLabel, isLanUrl, parseE2eReply, rotationDue } from "./pushE2e";

const srv = (id: string, url: string): ServerEntry => ({ id, nickname: id, url, username: "u", rememberPassword: false });
const HOME = srv("s1", "https://rosson.k2.dev");
const OLD = srv("s2", "https://old.k2.dev");

type Post = { url: string; body: Record<string, unknown> };
const posts = (): Post[] =>
  tauriFetch.mock.calls
    .filter(([, init]) => (init as { method?: string })?.method === "POST")
    .map(([url, init]) => ({ url: url as string, body: JSON.parse((init as { body: string }).body) }));
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

function iPhone(on: boolean) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => (on ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" : "Mozilla/5.0 (X11; Linux)"),
  });
}

beforeEach(() => {
  for (const k of Object.keys(pushStore)) delete pushStore[k];
  Object.assign(pushStore, { enabled: true, deviceId: "shared-1" });
  tauriFetch.mockReset();
  tauriFetch.mockImplementation(async (url: string) => {
    const body = url.endsWith("/register-device")
      ? JSON.stringify({ ok: true, e2e: { active: true, enforce: false, keyId: "982d0dfe762a03f5", rotateAfter: 9_999_999_999 } })
      : "{}";
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  });
  invoke.mockClear();
  resetPushRegisterState();
  __resetScopesForTests();
  useMultiServerPrefs.setState({ multiServer: false });
  useServersStore.setState({ servers: [HOME, OLD], activeServerId: "s1", tokens: { s1: "t1", s2: "t2" }, recovery: {} });
  noteBootStatus("s1", { version: "0.46.3", features: ["thread-push-v1", "push-e2e-v1"] });
  noteBootStatus("s2", { version: "0.46.2", features: ["thread-push-v1"] });
  iPhone(true);
});

describe("direct path (prd §7.1)", () => {
  it("only https://<label>.k2.dev, or a LAN address with the box's label", () => {
    expect(directLabel("https://rosson.k2.dev")).toBe("rosson");
    expect(directLabel("https://rosson.app.k2.dev")).toBeNull();
    expect(directLabel("https://app.k2.dev")).toBeNull();
    expect(directLabel("http://rosson.k2.dev")).toBeNull();
    expect(directLabel("https://example.com")).toBeNull();
    expect(isLanUrl("http://192.168.1.5:7777")).toBe(true);
    expect(isLanUrl("http://172.20.0.2:1")).toBe(true);
    expect(isLanUrl("http://8.8.8.8")).toBe(false);
    expect(e2eLabel("http://192.168.1.5:7777", "rosson.k2.dev")).toBe("rosson");
    expect(e2eLabel("http://192.168.1.5:7777", null)).toBeNull();
    expect(e2eLabel("https://custom.example.com", "rosson.k2.dev")).toBeNull();
  });

  it("reply e2e and rotation", () => {
    expect(parseE2eReply(JSON.stringify({ e2e: { active: true, enforce: true, keyId: "k", rotateAfter: 10 } }))).toEqual({
      active: true,
      enforce: true,
      keyId: "k",
      rotateAfter: 10,
      expiresAt: null,
    });
    expect(parseE2eReply('{"e2e":null}')).toBeNull();
    expect(rotationDue({ active: true, enforce: false, keyId: null, rotateAfter: 10, expiresAt: null }, 11)).toBe(true);
    expect(rotationDue(null, 11)).toBe(false);
  });
});

describe("sealed registration", () => {
  it("a push-e2e-v1 server gets the per-server deviceId + e2e key; the shared row there goes once", async () => {
    await ensureRegistered(scopeFor("s1"));
    await flush();
    const p = posts();
    expect(p[0].url).toBe("https://rosson.k2.dev/cli/push/register-device");
    expect(p[0].body).toMatchObject({
      deviceId: "dev-s1",
      platform: "apns",
      token: "apns-tok",
      e2e: { v: 1, suite: "p256-sha256-aes256gcm-psk", publicKey: "PUB1", psk: "PSK", createdAt: 1760960000 },
    });
    expect(p[1]).toEqual({ url: "https://rosson.k2.dev/cli/push/unregister-device", body: { deviceId: "shared-1" } });
    expect(invoke).toHaveBeenCalledWith("plugin:k2-push|e2e_op", { op: "enforce", subdomain: "rosson", on: false });

    tauriFetch.mockClear();
    await ensureRegistered(scopeFor("s1"));
    await flush();
    expect(posts().map((x) => x.url)).toEqual(["https://rosson.k2.dev/cli/push/register-device"]);
  });

  it("a server without the feature, or not an iPhone: today's registration exactly", async () => {
    await ensureRegistered(scopeFor("s2"));
    iPhone(false);
    await ensureRegistered(scopeFor("s1"));
    await flush();
    for (const p of posts()) {
      expect(p.body.deviceId).toBe("shared-1");
      expect(p.body.e2e).toBeUndefined();
    }
    expect(posts().some((p) => p.url.endsWith("/unregister-device"))).toBe(false);
  });

  it("rotateAfter passed: the next registration sends a new key", async () => {
    tauriFetch.mockImplementation(async (url: string) => {
      const body = url.endsWith("/register-device") ? JSON.stringify({ e2e: { active: true, rotateAfter: 1 } }) : "{}";
      return { ok: true, status: 200, text: async () => body };
    });
    await ensureRegistered(scopeFor("s1"));
    await flush();
    tauriFetch.mockClear();
    await ensureRegistered(scopeFor("s1"));
    await flush();
    expect(posts()[0].body.e2e).toMatchObject({ publicKey: "PUB2" });
  });

  it("leaving a server unregisters both ids and forgets its keys", async () => {
    await ensureRegistered(scopeFor("s1"));
    await flush();
    tauriFetch.mockClear();
    await unregisterLeaving(HOME, "t1");
    expect(posts().map((p) => p.body.deviceId)).toEqual(["dev-s1", "shared-1"]);
    expect(invoke).toHaveBeenCalledWith("plugin:k2-push|e2e_op", { op: "forget", server: "s1" });
  });
});
