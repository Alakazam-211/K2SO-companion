// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// badgeKey (K2 0.46.1): learned from register-device and the device
// read-back; picks between two logins on one host when a tap carries it.

const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "plugin:k2-push|is_available") return { available: true, platform: "ios" };
  if (cmd === "plugin:k2-push|request_permission") return { granted: true };
  if (cmd === "plugin:k2-push|get_token") return { token: "tok", platform: "apns" };
  if (cmd === "aps_environment") return "production";
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

import { getBootStatus, serverHasFeature } from "../api/client";
import { useServersStore, type ServerEntry } from "../stores/servers";
import { connectServer } from "./revive";
import { __resetBadgeKeysForTests, badgeKeyOf, learnBadgeKey, readBadgeKeys } from "./badgeKeys";
import {
  matchTapServer,
  readBackPreviews,
  registerAllSignedIn,
  resetPushRegisterState,
  routeTap,
} from "./push";

const srv = (id: string, url: string, username = "u"): ServerEntry => ({
  id,
  nickname: id,
  url,
  username,
  rememberPassword: false,
});
// Two logins on one host and one daemon: the owner and a member.
const R_OWNER = srv("o1", "https://rosson.k2.dev", "rosson");
const R_MEMBER = srv("m1", "https://rosson.k2.dev", "baden");
const WORK = srv("s2", "https://work.k2.dev");

const THREAD = {
  kind: "thread",
  subdomain: "rosson",
  instanceId: "inst-r",
  addr: "k2/reviewer",
  seq: "9",
};

const reply = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 502,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  localStorage.clear();
  __resetBadgeKeysForTests();
  tauriFetch.mockReset();
  tauriFetch.mockResolvedValue(reply({ ok: true }));
  vi.mocked(getBootStatus).mockReset();
  vi.mocked(getBootStatus).mockResolvedValue({ features: ["thread-push-v1"] } as never);
  vi.mocked(connectServer).mockReset();
  resetPushRegisterState();
  pushStore.enabled = true;
  useServersStore.setState({
    servers: [R_OWNER, R_MEMBER, WORK],
    activeServerId: "o1",
    tokens: { o1: "to", m1: "tm", s2: "tw" },
    recovery: {},
  });
});

describe("matchTapServer with badgeKey", () => {
  const badgeKeys = { o1: "bkO", m1: "bkM", s2: "bkW" };

  it("picks the login whose badgeKey matches, between two logins on one host", () => {
    const servers = [R_OWNER, R_MEMBER, WORK];
    expect(matchTapServer({ ...THREAD, badgeKey: "bkM" }, servers, { badgeKeys, activeServerId: "o1" })?.id).toBe(
      "m1"
    );
    expect(matchTapServer({ ...THREAD, badgeKey: "bkO" }, servers, { badgeKeys, activeServerId: "m1" })?.id).toBe(
      "o1"
    );
  });

  it("wins over a conflicting principal (badgeKey comes first)", () => {
    const tap = { ...THREAD, badgeKey: "bkM", principal: "rosson" };
    expect(matchTapServer(tap, [R_OWNER, R_MEMBER], { badgeKeys })?.id).toBe("m1");
  });

  it("an unknown key falls back to instanceId / principal / active", () => {
    const tap = { ...THREAD, badgeKey: "bkNew", principal: "baden" };
    expect(matchTapServer(tap, [R_OWNER, R_MEMBER], { badgeKeys, activeServerId: "o1" })?.id).toBe("m1");
    expect(
      matchTapServer({ ...THREAD, badgeKey: "bkNew" }, [R_OWNER, R_MEMBER], { activeServerId: "m1" })?.id
    ).toBe("m1");
    expect(matchTapServer({ ...THREAD, badgeKey: "bkNew" }, [R_OWNER, R_MEMBER], { activeServerId: null })).toBeNull();
  });

  it("never routes by badgeKey across hosts: the subdomain stays the anchor", () => {
    // The key belongs to the work login, but the push says rosson.
    const tap = { ...THREAD, badgeKey: "bkW" };
    expect(matchTapServer(tap, [R_OWNER, R_MEMBER, WORK], { badgeKeys, activeServerId: "o1" })?.id).toBe("o1");
    expect(matchTapServer({ ...tap, subdomain: "" }, [WORK], { badgeKeys })).toBeNull();
    expect(matchTapServer({ ...tap, subdomain: "stranger" }, [WORK], { badgeKeys })).toBeNull();
  });

  it("a shared key (owner token + owner-linked login) narrows, then the usual tiebreaks", () => {
    const dup = srv("o2", "https://rosson.k2.dev", "rosson");
    const keys = { o1: "bkO", o2: "bkO", m1: "bkM" };
    expect(
      matchTapServer({ ...THREAD, badgeKey: "bkO" }, [R_OWNER, dup, R_MEMBER], { badgeKeys: keys, activeServerId: "o2" })
        ?.id
    ).toBe("o2");
    // Active is the member: not among the two key holders → ignored.
    expect(
      matchTapServer({ ...THREAD, badgeKey: "bkO" }, [R_OWNER, dup, R_MEMBER], { badgeKeys: keys, activeServerId: "m1" })
    ).toBeNull();
  });
});

describe("routeTap with badgeKey", () => {
  it("a learned key settles a tie without probing boot-status or whoami", async () => {
    learnBadgeKey("o1", "bkO");
    learnBadgeKey("m1", "bkM");
    vi.mocked(connectServer).mockResolvedValue("still-valid");
    const navigate = vi.fn();
    await routeTap({ ...THREAD, badgeKey: "bkM", principal: "baden" }, navigate);
    expect(getBootStatus).not.toHaveBeenCalled();
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(useServersStore.getState().activeServerId).toBe("m1");
    expect(navigate).toHaveBeenCalledWith("/zen?addr=k2%2Freviewer&seq=9");
  });

  it("an unknown key still probes (instanceId)", async () => {
    vi.mocked(getBootStatus).mockImplementation(async (scope) => ({
      instanceId: scope.id === "m1" ? "inst-r" : "old",
      features: [],
      version: null,
    }) as never);
    vi.mocked(connectServer).mockResolvedValue("still-valid");
    await routeTap({ ...THREAD, badgeKey: "bkUnknown" }, vi.fn());
    expect(getBootStatus).toHaveBeenCalled();
    expect(useServersStore.getState().activeServerId).toBe("m1");
  });
});

describe("learning the badgeKey", () => {
  it("from the register-device reply, per server", async () => {
    tauriFetch.mockImplementation(async (url: string) =>
      reply(
        url.includes("work")
          ? { ok: true, badgeKey: "bkW" }
          : { ok: true, badgeKey: url.includes("rosson") ? "bkR" : undefined }
      )
    );
    await registerAllSignedIn();
    expect(badgeKeyOf("s2")).toBe("bkW");
    expect(badgeKeyOf("o1")).toBe("bkR");
  });

  it("an older daemon (no badgeKey) leaves what was learned", async () => {
    learnBadgeKey("s2", "bkW");
    tauriFetch.mockResolvedValue(reply({ ok: true }));
    await registerAllSignedIn();
    expect(badgeKeyOf("s2")).toBe("bkW");
  });

  it("from the device read-back (GET /cli/push/device)", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    tauriFetch.mockResolvedValue(reply({ ok: true, previews: true, badgeKey: "bkW2" }));
    await readBackPreviews("s2");
    expect(badgeKeyOf("s2")).toBe("bkW2");
  });

  it("is dropped when the server is removed", async () => {
    learnBadgeKey("s2", "bkW");
    useServersStore.getState().removeServer("s2");
    expect(readBadgeKeys()).toEqual({});
  });
});
