import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no tauri in tests");
  }),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("../stores/servers", () => ({
  useServersStore: { getState: () => ({ servers: [], tokens: {}, activeServerId: null }) },
}));

import {
  AVATAR_CHUNK,
  __pendingAvatarKeysForTests,
  __setAvatarCacheDepsForTests,
  avatarItemsFromProjects,
  avatarKey,
  flushAvatarCache,
  iconRevFallback,
  isCacheableIcon,
  missingAvatarSources,
  queueAvatar,
  queueServerAvatars,
  subdomainOfServerUrl,
  type AvatarItem,
} from "./avatarCache";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPG = "data:image/jpeg;base64,/9j/4AAQ";

const urls: Record<string, string> = {
  s1: "https://Rosson.k2.dev",
  s2: "https://baden.k2.dev:443/",
  lan: "http://192.168.1.50:60710",
  connect: "https://rosson.app.k2.dev",
};

function rows(...r: Record<string, unknown>[]) {
  return r.map((x, i) => ({ name: `w${i}`, handle: `w${i}`, path: `/w${i}`, ...x }));
}

let calls: AvatarItem[][];
let callImpl: (items: AvatarItem[]) => Promise<{ available: boolean; reason?: string }>;
let avail: { available: boolean; platform: string };

function install(over: Record<string, unknown> = {}) {
  __setAvatarCacheDepsForTests({
    enabled: () => true,
    availability: async () => avail,
    call: (items) => {
      calls.push(items);
      return callImpl(items);
    },
    serverUrl: (id) => urls[id] ?? null,
    flushMs: 10,
    download: async () => null,
    fillIn: () => {},
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  avail = { available: true, platform: "ios" };
  callImpl = async () => ({ available: true });
  install();
});

afterEach(() => {
  __setAvatarCacheDepsForTests(null);
  vi.useRealTimers();
});

async function tick() {
  await vi.advanceTimersByTimeAsync(20);
}

describe("keys and subdomains", () => {
  it("avatarKey is <subdomain>|<projectId>, lowercased and trimmed", () => {
    expect(avatarKey(" Rosson ", "Proj-ABC")).toBe("rosson|proj-abc");
  });

  it("subdomain is the first label of a <label>.k2.dev host only", () => {
    expect(subdomainOfServerUrl("https://Rosson.k2.dev")).toBe("rosson");
    expect(subdomainOfServerUrl("https://baden.k2.dev:443/")).toBe("baden");
    expect(subdomainOfServerUrl("https://rosson.app.k2.dev")).toBeNull();
    expect(subdomainOfServerUrl("http://192.168.1.50:60710")).toBeNull();
    expect(subdomainOfServerUrl("https://k2.dev")).toBeNull();
    expect(subdomainOfServerUrl("not a url")).toBeNull();
    expect(subdomainOfServerUrl(null)).toBeNull();
  });
});

describe("rev", () => {
  it("fallback hash is stable and changes with the icon", () => {
    expect(iconRevFallback(PNG)).toBe(iconRevFallback(`${PNG}`));
    expect(iconRevFallback(PNG)).not.toBe(iconRevFallback(JPG));
    expect(iconRevFallback(PNG)).not.toBe(iconRevFallback(`${PNG}A`));
    expect(iconRevFallback("")).toMatch(/^h0-[0-9a-f]{8}$/);
  });

  it("uses the row's iconRev when present, else the hash", () => {
    const items = avatarItemsFromProjects(
      "rosson",
      rows({ id: "p1", iconUrl: PNG, iconRev: "rev-9" }, { id: "p2", iconUrl: JPG })
    );
    expect(items).toEqual([
      { key: "rosson|p1", rev: "rev-9", dataUrl: PNG },
      { key: "rosson|p2", rev: iconRevFallback(JPG), dataUrl: JPG },
    ]);
  });

  it("skips rows without an id or without a raster data: icon", () => {
    const items = avatarItemsFromProjects(
      "rosson",
      rows(
        { iconUrl: PNG },
        { id: "p-http", iconUrl: "https://example.com/a.png" },
        { id: "p-svg", iconUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
        { id: "p-none" },
        { id: "p-ok", iconUrl: PNG }
      )
    );
    expect(items.map((i) => i.key)).toEqual(["rosson|p-ok"]);
    expect(isCacheableIcon("data:image/webp;base64,UklG")).toBe(true);
    expect(isCacheableIcon("data:text/plain,hi")).toBe(false);
  });

  it("an unrecognised projects/list body yields nothing", () => {
    expect(avatarItemsFromProjects("rosson", { ok: true, agents: [] })).toEqual([]);
    expect(avatarItemsFromProjects("rosson", null)).toEqual([]);
  });
});

describe("queue + flush", () => {
  it("coalesces several loads into one call, last icon per key wins", async () => {
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: JPG }, { id: "p2", iconUrl: PNG }));
    queueServerAvatars("s2", rows({ id: "p1", iconUrl: PNG }));
    expect(calls).toHaveLength(0);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].map((i) => [i.key, i.dataUrl])).toEqual([
      ["rosson|p1", JPG],
      ["rosson|p2", PNG],
      ["baden|p1", PNG],
    ]);
  });

  it("does not resend an unchanged rev; a changed icon goes again", async () => {
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    expect(calls).toHaveLength(1);
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: JPG }));
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1][0].dataUrl).toBe(JPG);
  });

  it("servers off <label>.k2.dev are skipped (no push subdomain to match)", async () => {
    queueServerAvatars("lan", rows({ id: "p1", iconUrl: PNG }));
    queueServerAvatars("connect", rows({ id: "p1", iconUrl: PNG }));
    queueServerAvatars("gone", rows({ id: "p1", iconUrl: PNG }));
    expect(__pendingAvatarKeysForTests()).toEqual([]);
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("splits big batches into chunks", async () => {
    const many = Array.from({ length: AVATAR_CHUNK + 3 }, (_, i) => ({ id: `p${i}`, iconUrl: PNG }));
    queueServerAvatars("s1", rows(...many));
    await tick();
    expect(calls.map((c) => c.length)).toEqual([AVATAR_CHUNK, 3]);
  });

  it("a get-icon fill-in is queued with a hashed rev", async () => {
    queueAvatar("s1", "P9", JPG);
    queueAvatar("s1", null, JPG);
    queueAvatar("s1", "p10", "https://x/y.png");
    await tick();
    expect(calls).toEqual([[{ key: "rosson|p9", rev: iconRevFallback(JPG), dataUrl: JPG }]]);
  });

  it("a plugin error keeps items unsent so the next load retries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    callImpl = async () => {
      throw new Error("boom");
    };
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    callImpl = async () => ({ available: true });
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    expect(calls).toHaveLength(2);
    warn.mockRestore();
  });
});

describe("no-op when unavailable", () => {
  it("nothing is queued when the gate is closed (not Tauri)", async () => {
    install({ enabled: () => false });
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    queueAvatar("s1", "p2", PNG);
    expect(__pendingAvatarKeysForTests()).toEqual([]);
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("push unavailable or not iOS: no plugin call, and it stays off", async () => {
    avail = { available: true, platform: "android" };
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    expect(calls).toHaveLength(0);
    avail = { available: true, platform: "ios" };
    queueServerAvatars("s1", rows({ id: "p2", iconUrl: PNG }));
    await tick();
    expect(calls).toHaveLength(0);

    install();
    avail = { available: false, platform: "ios" };
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("native says unavailable (no App Group): stops for the session", async () => {
    callImpl = async () => ({ available: false, reason: "no App Group container" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await tick();
    queueServerAvatars("s1", rows({ id: "p2", iconUrl: PNG }));
    await tick();
    expect(calls).toHaveLength(1);
    info.mockRestore();
  });

  it("never throws into callers", async () => {
    install({
      serverUrl: () => {
        throw new Error("store exploded");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }))).not.toThrow();
    expect(() => queueAvatar("s1", "p1", PNG)).not.toThrow();
    install({
      availability: async () => {
        throw new Error("probe exploded");
      },
    });
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    await expect(flushAvatarCache()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("default gate: outside Tauri, nothing happens", async () => {
    __setAvatarCacheDepsForTests(null);
    queueServerAvatars("s1", rows({ id: "p1", iconUrl: PNG }));
    expect(__pendingAvatarKeysForTests()).toEqual([]);
  });
});

describe("pictures that are not data: URLs", () => {
  it("lists http(s) icons to download and empty icons to ask get-icon", () => {
    const data = rows(
      { id: "a", iconUrl: PNG },
      { id: "b", iconUrl: "https://cdn.example.com/b.png", iconRev: "r9" },
      { id: "c", iconUrl: "" },
      { id: "d" },
      { id: "e", iconUrl: "data:image/svg+xml;base64,PHN2Zz4=" }
    );
    expect(missingAvatarSources(data)).toEqual([
      { projectId: "b", path: "/w1", url: "https://cdn.example.com/b.png", iconRev: "r9" },
      { projectId: "c", path: "/w2", url: null, iconRev: null },
      { projectId: "d", path: "/w3", url: null, iconRev: null },
    ]);
  });

  it("asks get-icon for an empty icon and caches a downloaded one, once a day per URL", async () => {
    const fillIn = vi.fn();
    const download = vi.fn(async () => JPG);
    install({ fillIn, download });
    const data = rows({ id: "b", iconUrl: "https://cdn.example.com/b.png" }, { id: "c" });
    let t = 1000;
    queueServerAvatars("s1", data, () => t);
    expect(fillIn).toHaveBeenCalledWith("s1", "c", "/w1");
    expect(download).toHaveBeenCalledWith("https://cdn.example.com/b.png");
    await vi.waitFor(() => expect(__pendingAvatarKeysForTests()).toContain(avatarKey("rosson", "b")));
    t += 60_000;
    queueServerAvatars("s1", data, () => t);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a server off k2.dev", () => {
    const fillIn = vi.fn();
    install({ fillIn });
    queueServerAvatars("lan", rows({ id: "c" }));
    expect(fillIn).not.toHaveBeenCalled();
  });
});
