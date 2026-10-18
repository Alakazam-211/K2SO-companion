// Sign-out / remove revokes this device's session on the daemon
// (`POST /cli/auth/logout`, K2 0.46.1).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import { signOutServer, useServersStore, type ServerEntry } from "./servers";

const A: ServerEntry = { id: "a", nickname: "A", url: "https://a.k2.dev/", username: "u", rememberPassword: false };

function logoutCalls() {
  return fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/cli/auth/logout"));
}

describe("revoking the session on leave", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" });
    useServersStore.setState({ servers: [A], tokens: { a: "tok-a" }, activeServerId: "a", recovery: {} });
  });

  it("sign-out posts /cli/auth/logout with the session token, then forgets it", () => {
    signOutServer("a");
    const calls = logoutCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("https://a.k2.dev/cli/auth/logout");
    expect(calls[0][1].method).toBe("POST");
    expect(calls[0][1].headers.Authorization).toBe("Bearer tok-a");
    expect(useServersStore.getState().tokens.a).toBeUndefined();
  });

  it("removing a server revokes too; a failed revoke never blocks the removal", () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    useServersStore.getState().removeServer("a");
    expect(logoutCalls()).toHaveLength(1);
    expect(useServersStore.getState().servers).toHaveLength(0);
  });

  it("no token, no call", () => {
    useServersStore.setState({ tokens: {} });
    signOutServer("a");
    expect(logoutCalls()).toHaveLength(0);
  });
});
