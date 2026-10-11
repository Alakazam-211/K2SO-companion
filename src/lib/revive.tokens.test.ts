// MA22 / MS33: what may delete a token.
//   - whoami 401, or 403 with the token-gate body, seen TWICE ≥ 1 s apart;
//   - any other 403 (an edge page, role_required) is not proof;
//   - a background caller (socket, pool) never deletes — it only says
//     signin-required;
//   - MS29: an accepted server clears its recovery state and backoff.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("no tauri");
  }),
}));

import {
  __resetReviveForTests,
  __setDeadRecheckMsForTests,
  noteServerAccepted,
  revive,
  reviveBackoffPending,
} from "./revive";
import { useServersStore } from "../stores/servers";

const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const GATE = { error: "Invalid or missing auth token" };

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  __resetReviveForTests();
  __setDeadRecheckMsForTests(1000);
  useServersStore.setState({
    hydrated: true,
    servers: [
      { id: "a", nickname: "A", url: "https://a.k2.dev", username: "u", rememberPassword: false },
      { id: "b", nickname: "B", url: "https://b.k2.dev", username: "u", rememberPassword: false },
    ],
    activeServerId: "a",
    tokens: { a: "tok-a", b: "tok-b" },
    recovery: { a: "connected", b: "connected" },
  });
});
afterEach(() => {
  __setDeadRecheckMsForTests(null);
  vi.useRealTimers();
});

describe("token deletion (MA22)", () => {
  it("one dead whoami is not enough: a live second look keeps the token", async () => {
    fetchMock.mockResolvedValueOnce(res(403, GATE)).mockResolvedValueOnce(res(200, {}));
    const p = revive({ id: "b" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe("still-valid");
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
  });

  it("dead twice, at least 1 s apart, deletes it (foreground)", async () => {
    fetchMock.mockResolvedValue(res(401, {}));
    const p = revive({ id: "b" });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe("signin-required");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useServersStore.getState().tokens.b).toBeUndefined();
    expect(useServersStore.getState().tokens.a).toBe("tok-a");
    expect(useServersStore.getState().recovery.b).toBe("signin-required");
  });

  it("a background caller never deletes, even when dead twice", async () => {
    fetchMock.mockResolvedValue(res(403, GATE));
    const p = revive({ id: "b" }, { background: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe("signin-required");
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
    expect(useServersStore.getState().recovery.b).toBe("signin-required");
  });

  it("a 403 that is not the daemon's token gate is a blip, never dead", async () => {
    fetchMock.mockResolvedValue(res(403, "<html>Forbidden by the edge</html>"));
    expect(await revive({ id: "b" })).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
  });

  it("password_change_required is a live token (rotate, never dead)", async () => {
    fetchMock.mockResolvedValue(res(403, { error: { code: "password_change_required" } }));
    expect(await revive({ id: "b" })).toBe("still-valid");
    expect(useServersStore.getState().tokens.b).toBe("tok-b");
  });

  it("a sign-in that lands between the two looks wins", async () => {
    fetchMock.mockResolvedValue(res(401, {}));
    const p = revive({ id: "b" });
    useServersStore.getState().setToken("b", "fresh");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe("still-valid");
    expect(useServersStore.getState().tokens.b).toBe("fresh");
  });
});

describe("MS29: clear recovery on accept", () => {
  it("resets that server's recovery and revive backoff only", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await revive({ id: "b" })).toBe("unreachable");
    expect(useServersStore.getState().recovery.b).toBe("reconnecting");
    expect(reviveBackoffPending("b")).toBe(true);
    useServersStore.getState().setRecovery("a", "reconnecting");
    noteServerAccepted("b");
    expect(useServersStore.getState().recovery.b).toBe("connected");
    expect(reviveBackoffPending("b")).toBe(false);
    expect(useServersStore.getState().recovery.a).toBe("reconnecting");
  });
});
