import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { fakeScope } from "../test/fakeScope";
import {
  emitHomesFrame,
  onHomesFrame,
  parseChangeItem,
  parseDevices,
  parseHomesFrame,
  parsePullReply,
  parsePushReply,
  pullHomes,
  pushHomes,
  removeHomesDevice,
  toWireChange,
} from "./homesSync";

const res = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
});

beforeEach(() => tauriFetch.mockReset());

describe("wire ↔ model (the only place that knows the wire)", () => {
  it("reads home and row items, tolerating snake_case and a deletedAt tombstone", () => {
    expect(parseChangeItem({ kind: "home", id: "h", name: "Home", order: "a0", updatedAt: 5, deviceId: "d" })).toEqual({
      kind: "home",
      id: "h",
      name: "Home",
      order: "a0",
      updatedAt: 5,
      by: "d",
    });
    expect(
      parseChangeItem({ type: "row", home_id: "h", address: "Docs::ABC", label: "Docs", workspace_id: "w", order: "a1", updated_at: "7", deleted_at: 9 })
    ).toEqual({ kind: "row", homeId: "h", address: "docs::abc", label: "Docs", workspaceId: "w", order: "a1", updatedAt: 7, deleted: true });
    expect(parseChangeItem({ kind: "row", address: "x::y" })).toBeNull();
    expect(parseChangeItem("nope")).toBeNull();
  });

  it("writes the contract's field names and leaves `by` to the push's deviceId", () => {
    expect(toWireChange({ kind: "row", homeId: "h", address: "a::b", label: "a", workspaceId: null, order: "a0", updatedAt: 1, by: "me", deleted: true })).toEqual({
      kind: "row",
      homeId: "h",
      address: "a::b",
      label: "a",
      workspaceId: null,
      order: "a0",
      updatedAt: 1,
      deleted: true,
    });
  });

  it("pull reply: `homes` is the change list (`changes` also read), cursor, device.syncing", () => {
    const r = parsePullReply({ homes: [{ kind: "home", id: "h", name: "H", order: "a0", updatedAt: 1 }], cursor: 42, device: { syncing: true } });
    expect(r).toEqual({ changes: [expect.objectContaining({ id: "h" })], cursor: "42", syncing: true });
    expect(parsePullReply({ changes: [{ kind: "home", id: "x", name: "", order: "", updatedAt: 0 }] }).changes).toHaveLength(1);
    expect(parsePullReply(null)).toEqual({ changes: [], cursor: null, syncing: null });
  });

  it("push reply: cursor, applied, rejected [{item, reason}]", () => {
    const r = parsePushReply({ cursor: "9", applied: 2, rejected: [{ item: { kind: "home", id: "h", name: "", order: "", updatedAt: 1 }, reason: "too_long" }] });
    expect(r.cursor).toBe("9");
    expect(r.applied).toBe(2);
    expect(r.rejected).toEqual([{ item: expect.objectContaining({ id: "h" }), reason: "too_long" }]);
  });

  it("devices: array or {devices}, seconds or ms or ISO", () => {
    const list = parseDevices([
      { deviceId: "d1", name: "iPhone", platform: "ios", lastSyncAt: 1_700_000_000, current: true },
      { device_id: "d2", name: "MacBook", platform: "macos", last_sync_at: "2026-10-01T00:00:00Z" },
      { name: "no id" },
    ]);
    expect(list).toEqual([
      { deviceId: "d1", name: "iPhone", platform: "ios", lastSyncAt: 1_700_000_000_000, current: true },
      { deviceId: "d2", name: "MacBook", platform: "macos", lastSyncAt: Date.parse("2026-10-01T00:00:00Z"), current: false },
    ]);
    expect(parseDevices({ devices: [{ deviceId: "x" }] })).toHaveLength(1);
  });

  it("frames: homes_changed and homes_device_removed in any spelling; others ignored", () => {
    expect(parseHomesFrame({ kind: "homes_changed" })).toEqual({ type: "changed" });
    expect(parseHomesFrame({ t: "homes_device_removed", deviceId: "d" })).toEqual({ type: "device_removed", deviceId: "d" });
    expect(parseHomesFrame({ event: "homes_device_removed", data: { device_id: "e" } })).toEqual({ type: "device_removed", deviceId: "e" });
    expect(parseHomesFrame({ kind: "projects_changed" })).toBeNull();
    const seen: string[] = [];
    const stop = onHomesFrame((sid, f) => seen.push(`${sid}:${f.type}`));
    expect(emitHomesFrame("s1", { kind: "homes_changed" })).toBe(true);
    expect(emitHomesFrame("s1", { kind: "ticket_changed" })).toBe(false);
    stop();
    expect(seen).toEqual(["s1:changed"]);
  });
});

describe("calls", () => {
  const scope = fakeScope({ base: "https://home.k2.dev", token: "tok" });

  it("pull sends since + deviceId with the Bearer token", async () => {
    tauriFetch.mockResolvedValue(res(200, { homes: [], cursor: "3", device: { syncing: true } }));
    const r = await pullHomes(scope, "dev", "2");
    expect(r.ok && r.data.cursor).toBe("3");
    const [url, init] = tauriFetch.mock.calls[0];
    expect(url).toBe("https://home.k2.dev/cli/me/homes?deviceId=dev&since=2");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
    await pullHomes(scope, "dev", null);
    expect(tauriFetch.mock.calls[1][0]).toBe("https://home.k2.dev/cli/me/homes?deviceId=dev");
  });

  it("writes are POST with a JSON body", async () => {
    tauriFetch.mockResolvedValue(res(200, { cursor: "1", applied: 1, rejected: [] }));
    await pushHomes(scope, "dev", [{ kind: "home", id: "h", name: "H", order: "a0", updatedAt: 1, by: "dev" }]);
    await removeHomesDevice(scope, "other");
    expect(tauriFetch.mock.calls.map((c) => [c[1].method, new URL(c[0]).pathname, JSON.parse(c[1].body)])).toEqual([
      ["POST", "/cli/me/homes/push", { deviceId: "dev", changes: [{ kind: "home", id: "h", name: "H", order: "a0", updatedAt: 1 }] }],
      ["POST", "/cli/me/homes/devices/remove", { deviceId: "other" }],
    ]);
  });

  it("410 → removed; network / 502 → offline; 500 → http", async () => {
    tauriFetch.mockResolvedValueOnce(res(410, { error: "device_removed" }));
    expect(await pullHomes(scope, "d", null)).toEqual({ ok: false, kind: "removed", error: "device_removed" });
    tauriFetch.mockRejectedValueOnce(new Error("Load failed"));
    expect((await pullHomes(scope, "d", null)) as { kind: string }).toMatchObject({ ok: false, kind: "offline" });
    tauriFetch.mockResolvedValueOnce(res(502, {}));
    expect((await pullHomes(scope, "d", null)) as { kind: string }).toMatchObject({ kind: "offline" });
    tauriFetch.mockResolvedValueOnce(res(500, { error: "boom" }));
    expect(await pullHomes(scope, "d", null)).toEqual({ ok: false, kind: "http", status: 500, error: "boom" });
  });
});
