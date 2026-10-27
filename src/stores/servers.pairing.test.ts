// A paired server (K2 0.46.4 companion-pairing-v1): commitPairedSession
// never silently replaces a saved server, and the old login leaves (push
// unregister hook, then /cli/auth/logout) before the new token lands.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import { commitPairedSession, isPairedServer, onServerForget, onServerLeave, useServersStore, type ServerEntry } from "./servers";

const A: ServerEntry = { id: "a", nickname: "Home", url: "https://a.k2.dev", username: "rosson", rememberPassword: false };

describe("commitPairedSession", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    useServersStore.setState({ servers: [A], tokens: { a: "old" }, activeServerId: "a", recovery: { a: "connected" } });
  });

  it("adds a new paired server and makes it active", async () => {
    const steps: string[] = [];
    const r = await commitPairedSession({ url: "b.k2.dev", nickname: "", username: "ada", token: "dev-b", onStep: (s) => steps.push(s) });
    expect(r.ok).toBe(true);
    // Nothing to sign out on a new server.
    expect(steps).toEqual(["save"]);
    const id = r.ok ? r.id : "";
    const s = useServersStore.getState();
    const b = s.servers.find((x) => x.id === id)!;
    expect(b).toMatchObject({ url: "https://b.k2.dev", nickname: "b.k2.dev", username: "ada", auth: "paired" });
    expect(isPairedServer(b)).toBe(true);
    expect(s.tokens[id]).toBe("dev-b");
    expect(s.recovery[id]).toBe("connected");
    expect(s.activeServerId).toBe(id);
  });

  it("refuses a saved address unless the user confirmed replacing it", async () => {
    const r = await commitPairedSession({ url: "https://a.k2.dev/", nickname: "", username: "rosson", token: "dev-a" });
    expect(r).toEqual({ ok: false, error: "Already saved as Home." });
    expect(useServersStore.getState().tokens.a).toBe("old");
  });

  it("replacing: the old login leaves first (hooks see the old token), then the new token lands", async () => {
    const order: string[] = [];
    const off = onServerLeave(async (_s, token) => {
      order.push(`leave:${token}:${useServersStore.getState().tokens.a}`);
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/cli/auth/logout")) order.push("logout");
      return { ok: true, status: 200, text: async () => "" };
    });
    const r = await commitPairedSession({
      replaceId: "a",
      url: "a.k2.dev",
      nickname: "",
      username: "rosson",
      token: "dev-a",
      activate: false,
      onStep: (step) => order.push(`step:${step}`),
    });
    off();
    expect(r).toEqual({ ok: true, id: "a" });
    expect(order).toEqual(["step:leave", "leave:old:old", "logout", "step:save"]);
    const s = useServersStore.getState();
    expect(s.tokens.a).toBe("dev-a");
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]).toMatchObject({ id: "a", nickname: "Home", auth: "paired" });
    const logout = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/cli/auth/logout"))!;
    expect(logout[1].headers.Authorization).toBe("Bearer old");
  });

  it("a different login on the same server drops what the app held for it", async () => {
    const forgotten: string[] = [];
    const off = onServerForget((id, reason) => forgotten.push(`${id}:${reason}`));
    await commitPairedSession({ replaceId: "a", url: "a.k2.dev", nickname: "", username: "ada", token: "dev-a" });
    off();
    expect(forgotten).toEqual(["a:rekeyed"]);
  });
});
