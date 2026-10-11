// S0 guard rails (MS2, MS3 as amended by MA1–MA3): host key on every saved
// server, duplicate-key refusal on save, token holder wins on read,
// forget-on-rekey, and sign-in without switching the active server.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import {
  duplicateServer,
  loginAndSaveServer,
  onServerForget,
  serverForHostKey,
  serverHostKey,
  useServersStore,
  type ServerEntry,
} from "./servers";

function entry(over: Partial<ServerEntry>): ServerEntry {
  return {
    id: "a",
    nickname: "A",
    url: "https://a.k2.dev",
    username: "u",
    rememberPassword: false,
    ...over,
  };
}

function okLogin(token: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ token }),
    text: async () => JSON.stringify({ token }),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  useServersStore.setState({
    hydrated: true,
    servers: [],
    activeServerId: null,
    tokens: {},
    recovery: {},
  });
});

describe("hostKey on ServerEntry (MS2)", () => {
  it("is derived on save and survives a mixed-case, slash-y spelling", () => {
    expect(useServersStore.getState().upsertServer(entry({ url: "https://A.K2.dev" }))).toBe(true);
    const saved = useServersStore.getState().servers[0];
    expect(saved.hostKey).toBe("a.k2.dev");
    expect(serverHostKey({ url: "https://a.k2.dev:443" })).toBe("a.k2.dev");
  });
});

describe("duplicate refusal on save (MS2 / MA1)", () => {
  it("refuses a second entry for one server, however it is spelled", () => {
    const store = useServersStore.getState();
    expect(store.upsertServer(entry({ id: "a", url: "https://a.k2.dev" }))).toBe(true);
    expect(store.upsertServer(entry({ id: "b", url: "https://A.k2.dev:443" }))).toBe(false);
    expect(store.upsertServer(entry({ id: "c", url: "http://a.k2.dev" }))).toBe(true); // :80 is another server
    expect(useServersStore.getState().servers.map((s) => s.id)).toEqual(["a", "c"]);
    expect(duplicateServer(useServersStore.getState().servers, "a.k2.dev", null)?.id).toBe("a");
    expect(duplicateServer(useServersStore.getState().servers, "a.k2.dev", "a")).toBeNull();
  });

  it("refuses an edit onto another saved server's address", () => {
    const store = useServersStore.getState();
    store.upsertServer(entry({ id: "a", url: "https://a.k2.dev" }));
    store.upsertServer(entry({ id: "b", url: "https://b.k2.dev" }));
    expect(store.upsertServer(entry({ id: "b", url: "https://a.k2.dev/" }))).toBe(false);
    expect(useServersStore.getState().servers.find((s) => s.id === "b")?.url).toBe("https://b.k2.dev");
  });

  it("keeps saving entries that already shared a key before the rule", () => {
    useServersStore.setState({
      servers: [entry({ id: "a" }), entry({ id: "b", nickname: "B" })],
    });
    expect(useServersStore.getState().upsertServer(entry({ id: "b", nickname: "B2" }))).toBe(true);
  });

  it("loginAndSaveServer refuses a duplicate before minting a token", async () => {
    useServersStore.getState().upsertServer(entry({ id: "a", username: "rosson" }));
    const r = await loginAndSaveServer({
      nickname: "",
      url: "A.k2.dev",
      username: "baden",
      password: "pw",
      rememberPassword: false,
    });
    expect(r).toEqual({ ok: false, error: "Already saved as A." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loginAndSaveServer signs the same user in again instead of duplicating", async () => {
    useServersStore.getState().upsertServer(entry({ id: "a", username: "u" }));
    okLogin("fresh");
    const r = await loginAndSaveServer({
      nickname: "A",
      url: "https://a.k2.dev/",
      username: "u",
      password: "pw",
      rememberPassword: false,
    });
    expect(r).toEqual({ ok: true, id: "a" });
    expect(useServersStore.getState().servers).toHaveLength(1);
    expect(useServersStore.getState().tokens.a).toBe("fresh");
  });
});

describe("token holder wins on read (MS2)", () => {
  it("prefers the entry with a token among old duplicates", () => {
    const state = {
      servers: [entry({ id: "a" }), entry({ id: "b" })],
      tokens: { b: "tok-b" } as Record<string, string>,
    };
    expect(serverForHostKey(state, "a.k2.dev")?.id).toBe("b");
    expect(serverForHostKey({ ...state, tokens: {} }, "a.k2.dev")?.id).toBe("a");
    expect(serverForHostKey(state, "nope.k2.dev")).toBeNull();
  });
});

describe("address edits (MS3 / MA2)", () => {
  it("an edit that changes the host key fires forget for that id; a same-key edit does not", () => {
    const seen: Array<[string, string]> = [];
    const off = onServerForget((id, reason) => seen.push([id, reason]));
    const store = useServersStore.getState();
    store.upsertServer(entry({ id: "a", url: "https://a.k2.dev" }));
    store.upsertServer(entry({ id: "a", url: "https://A.k2.dev/", nickname: "renamed" }));
    expect(seen).toEqual([]);
    store.upsertServer(entry({ id: "a", url: "https://z.k2.dev" }));
    expect(seen).toEqual([["a", "rekeyed"]]);
    expect(useServersStore.getState().servers[0].hostKey).toBe("z.k2.dev");
    store.removeServer("a");
    expect(seen).toEqual([
      ["a", "rekeyed"],
      ["a", "removed"],
    ]);
    off();
  });
});

describe("sign in without switching (MA3)", () => {
  it("activate:false saves + signs in but keeps the active server", async () => {
    const store = useServersStore.getState();
    store.upsertServer(entry({ id: "a" }));
    store.setActive("a");
    okLogin("tok-b");
    const r = await loginAndSaveServer({
      nickname: "B",
      url: "b.k2.dev",
      username: "u",
      password: "pw",
      rememberPassword: false,
      activate: false,
    });
    expect(r.ok).toBe(true);
    const s = useServersStore.getState();
    expect(s.activeServerId).toBe("a");
    const b = s.servers.find((x) => x.hostKey === "b.k2.dev");
    expect(b && s.tokens[b.id]).toBe("tok-b");
  });

  it("defaults to switching (the classic Login page)", async () => {
    useServersStore.getState().upsertServer(entry({ id: "a" }));
    useServersStore.getState().setActive("a");
    okLogin("tok-b");
    const r = await loginAndSaveServer({
      nickname: "B",
      url: "b.k2.dev",
      username: "u",
      password: "pw",
      rememberPassword: false,
    });
    expect(r.ok && useServersStore.getState().activeServerId).toBe(r.ok ? r.id : null);
  });
});
