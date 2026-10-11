import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<string, (tap: unknown) => void> = {};
const invoke = vi.fn(async (cmd: string): Promise<unknown> => {
  if (cmd === "plugin:k2-push|is_available") return { available: true, platform: "apns" };
  if (cmd === "plugin:k2-push|get_launch_tap") return { tap: null };
  if (cmd === "plugin:k2-push|request_permission") return { granted: true };
  if (cmd === "plugin:k2-push|get_token") return { token: "apns-tok", platform: "apns" };
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
  addPluginListener: vi.fn(async (_p: string, event: string, cb: (tap: unknown) => void) => {
    listeners[event] = cb;
    return { unregister: vi.fn() };
  }),
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
import { connectServer } from "./revive";
import { signOutServer, useServersStore, type ServerEntry } from "../stores/servers";
import {
  attachPushNavigation,
  matchTapServer,
  registerAllSignedIn,
  routeTap,
  tapPath,
  watchPushRegistrations,
} from "./push";

const srv = (id: string, url: string, username = "u"): ServerEntry => ({
  id,
  nickname: id,
  url,
  username,
  rememberPassword: false,
});
const HOME = srv("s1", "https://rosson.k2.dev");
const WORK = srv("s2", "https://work.k2.dev");
const WORK2 = srv("s3", "https://work.k2.dev", "gina");
const LAN = srv("s4", "http://192.168.1.5:7777");
// Two accounts on one host and one daemon: the owner and a member.
const R_OWNER = srv("o1", "https://rosson.k2.dev", "rosson");
const R_MEMBER = srv("m1", "https://rosson.k2.dev", "baden");

const THREAD = {
  kind: "thread",
  subdomain: "work",
  instanceId: "inst-w",
  addr: "k2/reviewer",
  conversationId: "c1",
  seq: "418",
  projectId: "p1",
  agentName: "k2",
  msgKind: "text",
  count: "1",
};

const posts = () =>
  tauriFetch.mock.calls.map(([url, o]) => ({
    url: String(url),
    body: JSON.parse((o as { body: string }).body),
    auth: JSON.stringify((o as { headers: unknown }).headers),
  }));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  tauriFetch.mockReset();
  tauriFetch.mockResolvedValue({ ok: true, status: 200 });
  vi.mocked(connectServer).mockReset();
  vi.mocked(getBootStatus).mockReset();
  vi.mocked(serverHasFeature).mockReset();
  pushStore.enabled = true;
  useServersStore.setState({
    servers: [HOME, WORK, LAN],
    activeServerId: "s1",
    tokens: { s1: "t1", s2: "t2", s4: "t4" },
    recovery: {},
  });
});

describe("thread tap server match", () => {
  it("matches on the relay-stamped subdomain", () => {
    expect(matchTapServer(THREAD, [HOME, WORK])?.id).toBe("s2");
    expect(matchTapServer({ ...THREAD, subdomain: "ROSSON" }, [HOME, WORK])?.id).toBe("s1");
  });

  it("instanceId only breaks a tie between servers on the same host", () => {
    const ids = { s2: "other", s3: "inst-w" };
    expect(matchTapServer(THREAD, [WORK, WORK2], { instanceIds: ids })?.id).toBe("s3");
    // No instanceId winner: the active server, then a signed-in one.
    expect(
      matchTapServer({ ...THREAD, instanceId: "zzz" }, [WORK, WORK2], { instanceIds: ids, activeServerId: "s3" })?.id
    ).toBe("s3");
  });

  it("principal picks the account when host and instance tie", () => {
    const ids = { o1: "inst-r", m1: "inst-r" };
    const tap = { ...THREAD, subdomain: "rosson", instanceId: "inst-r" };
    const ctx = { instanceIds: ids, activeServerId: "o1" };
    expect(matchTapServer({ ...tap, principal: "baden" }, [R_OWNER, R_MEMBER], ctx)?.id).toBe("m1");
    expect(matchTapServer({ ...tap, principal: "BADEN" }, [R_OWNER, R_MEMBER], ctx)?.id).toBe("m1");
    expect(
      matchTapServer({ ...tap, principal: "rosson" }, [R_OWNER, R_MEMBER], { ...ctx, activeServerId: "m1" })?.id
    ).toBe("o1");
  });

  it("an `owner` principal maps to the account whose whoami says owner", () => {
    const tap = { ...THREAD, subdomain: "rosson", instanceId: "", principal: "owner" };
    const identities = {
      o1: { username: "rosson", owner: false, role: "owner" },
      m1: { username: "baden", owner: false, role: "member" },
    };
    expect(matchTapServer(tap, [R_OWNER, R_MEMBER], { identities, activeServerId: "m1" })?.id).toBe("o1");
    // The `owner` bit counts too.
    expect(
      matchTapServer(tap, [R_OWNER, R_MEMBER], {
        identities: { o1: { username: "rosson", owner: true }, m1: { username: "baden" } },
        activeServerId: "m1",
      })?.id
    ).toBe("o1");
    // A member whoami never claims `owner`.
    expect(
      matchTapServer(tap, [R_OWNER, R_MEMBER], {
        identities: { m1: { username: "baden", role: "member" } },
        activeServerId: "m1",
      })?.id
    ).toBe("m1"); // unresolved → active fallback, not a principal match
  });

  it("still ambiguous: the active one if it is a candidate, else ignored", () => {
    const tap = { ...THREAD, subdomain: "rosson", instanceId: "", principal: "owner" };
    // whoami unknown for both: `owner` cannot pick.
    expect(matchTapServer(tap, [R_OWNER, R_MEMBER], { activeServerId: "m1" })?.id).toBe("m1");
    expect(matchTapServer(tap, [R_OWNER, R_MEMBER], { activeServerId: "s2" })).toBeNull();
    // No principal at all (older server) and nothing active among them.
    expect(matchTapServer({ ...tap, principal: "" }, [R_OWNER, R_MEMBER], { activeServerId: null })).toBeNull();
    // The principal narrows to two; the active one must be among those two.
    const dup = srv("m2", "https://rosson.k2.dev", "baden");
    const p = { ...tap, principal: "baden" };
    expect(matchTapServer(p, [R_OWNER, R_MEMBER, dup], { activeServerId: "m2" })?.id).toBe("m2");
    expect(matchTapServer(p, [R_OWNER, R_MEMBER, dup], { activeServerId: "o1" })).toBeNull();
  });

  it("an instanceId-only match (no subdomain match) is ignored", () => {
    const ids = { s1: "inst-w", s4: "inst-w" };
    expect(matchTapServer({ ...THREAD, subdomain: "" }, [HOME, LAN], { instanceIds: ids })).toBeNull();
    expect(matchTapServer({ ...THREAD, subdomain: "nobody" }, [HOME, LAN], { instanceIds: ids })).toBeNull();
  });

  it("never matches on projectId", () => {
    const tap = { kind: "thread", addr: "k2", projectId: "s1" };
    expect(matchTapServer(tap, [HOME, WORK])).toBeNull();
  });

  it("the deep link is /zen?addr=&seq=", () => {
    expect(tapPath(THREAD)).toBe("/zen?addr=k2%2Freviewer&seq=418");
    expect(tapPath({ ...THREAD, seq: "" })).toBe("/zen?addr=k2%2Freviewer");
    expect(tapPath({ ...THREAD, addr: "" })).toBeNull();
  });
});

describe("routeTap", () => {
  it("switches to the matched server, then opens the thread", async () => {
    vi.mocked(connectServer).mockResolvedValue("still-valid");
    const navigate = vi.fn();
    await routeTap(THREAD, navigate);
    expect(connectServer).toHaveBeenCalledWith("s2");
    expect(useServersStore.getState().activeServerId).toBe("s2");
    expect(navigate).toHaveBeenCalledWith("/zen?addr=k2%2Freviewer&seq=418");
  });

  it("the active server: no switch", async () => {
    const navigate = vi.fn();
    await routeTap({ ...THREAD, subdomain: "rosson" }, navigate);
    expect(connectServer).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/zen?addr=k2%2Freviewer&seq=418");
  });

  it("a tie reads instanceId fresh from boot-status", async () => {
    useServersStore.setState({ servers: [HOME, WORK, WORK2], tokens: { s1: "t1", s2: "t2", s3: "t3" } });
    vi.mocked(getBootStatus).mockImplementation(async (id?: string) => ({
      instanceId: id === "s3" ? "inst-w" : "old",
      features: [],
      version: null,
    }));
    vi.mocked(connectServer).mockResolvedValue("still-valid");
    await routeTap(THREAD, vi.fn());
    expect(getBootStatus).toHaveBeenCalledWith("s2", expect.objectContaining({ fresh: true }));
    expect(useServersStore.getState().activeServerId).toBe("s3");
  });

  it("an `owner` principal reads whoami for each tied account", async () => {
    useServersStore.setState({
      servers: [R_OWNER, R_MEMBER],
      activeServerId: "m1",
      tokens: { o1: "to", m1: "tm" },
    });
    tauriFetch.mockImplementation(async (_url: string, o: { headers: unknown }) => {
      const owner = JSON.stringify(o.headers).includes("Bearer to\"");
      return {
        ok: true,
        status: 200,
        json: async () =>
          owner ? { username: "rosson", owner: false, role: "owner" } : { username: "baden", role: "member" },
      };
    });
    vi.mocked(connectServer).mockResolvedValue("still-valid");
    const navigate = vi.fn();
    await routeTap({ ...THREAD, subdomain: "rosson", instanceId: "", principal: "owner" }, navigate);
    expect(tauriFetch).toHaveBeenCalledWith("https://rosson.k2.dev/cli/auth/whoami", expect.anything());
    expect(getBootStatus).not.toHaveBeenCalled();
    expect(useServersStore.getState().activeServerId).toBe("o1");
    expect(navigate).toHaveBeenCalledWith("/zen?addr=k2%2Freviewer&seq=418");
  });

  it("no subdomain match: ignored, no switch, no navigation", async () => {
    const navigate = vi.fn();
    await routeTap({ ...THREAD, subdomain: "stranger" }, navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(getBootStatus).not.toHaveBeenCalled();
    expect(useServersStore.getState().activeServerId).toBe("s1");
  });

  it("a server that needs sign-in: stays put", async () => {
    vi.mocked(connectServer).mockResolvedValue("signin-required");
    const navigate = vi.fn();
    await routeTap(THREAD, navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(useServersStore.getState().activeServerId).toBe("s1");
  });

  it("a warm thread tap through the plugin listener", async () => {
    vi.mocked(connectServer).mockResolvedValue("revived");
    const navigate = vi.fn();
    await attachPushNavigation(navigate, { pathname: () => "/zen" });
    listeners.tap(THREAD);
    await flush();
    expect(navigate).toHaveBeenCalledWith("/zen?addr=k2%2Freviewer&seq=418");
  });

  it("ticket taps are unchanged", async () => {
    const navigate = vi.fn();
    await routeTap({ kind: "ticket", feedbackId: "f1", subdomain: "work" }, navigate, { zen: true });
    expect(navigate).toHaveBeenCalledWith("/zen?ticket=f1");
    expect(connectServer).not.toHaveBeenCalled();
  });
});

describe("registration", () => {
  it("registers on the active server and every signed-in server with thread-push-v1", async () => {
    vi.mocked(serverHasFeature).mockImplementation(async (_k: string, id?: string) => id === "s2");
    await registerAllSignedIn();
    const urls = posts().map((p) => p.url).sort();
    expect(urls).toEqual([
      "https://rosson.k2.dev/cli/push/register-device",
      "https://work.k2.dev/cli/push/register-device",
    ]);
    expect(posts()[0].body).toEqual({ deviceId: "dev-1", platform: "apns", token: "apns-tok" });
    // A signed-out server is never asked.
    expect(serverHasFeature).not.toHaveBeenCalledWith("thread-push-v1", "s3");
  });

  it("push off: nothing registers", async () => {
    pushStore.enabled = false;
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    await registerAllSignedIn();
    expect(tauriFetch).not.toHaveBeenCalled();
  });

  it("a login (new token) registers on that server", async () => {
    vi.mocked(serverHasFeature).mockResolvedValue(true);
    const stop = watchPushRegistrations();
    await flush();
    tauriFetch.mockClear();
    useServersStore.setState({
      servers: [HOME, WORK, LAN, WORK2],
      tokens: { ...useServersStore.getState().tokens, s3: "fresh" },
    });
    await flush();
    stop();
    expect(posts().map((p) => p.url)).toEqual(["https://work.k2.dev/cli/push/register-device"]);
    expect(posts()[0].auth).toContain("fresh");
  });

  it("remove unregisters first, with the token it is about to drop", async () => {
    useServersStore.getState().removeServer("s2");
    await flush();
    expect(posts()).toEqual([
      expect.objectContaining({
        url: "https://work.k2.dev/cli/push/unregister-device",
        body: { deviceId: "dev-1" },
      }),
    ]);
    expect(posts()[0].auth).toContain("t2");
    expect(useServersStore.getState().tokens.s2).toBeUndefined();
  });

  it("sign-out unregisters too; a server with no token is not called", async () => {
    signOutServer("s1");
    await flush();
    expect(posts().map((p) => p.url)).toEqual(["https://rosson.k2.dev/cli/push/unregister-device"]);
    expect(posts()[0].auth).toContain("t1");
    tauriFetch.mockClear();
    signOutServer("s1");
    await flush();
    expect(tauriFetch).not.toHaveBeenCalled();
  });
});
