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

  it("pull reply (final contract): integer cursor, full, redirects, person, serverId, servers, device.syncing", () => {
    const r = parsePullReply({
      ok: true,
      person: "owner",
      serverId: "3f9a0c1d2e4b5a67",
      cursor: 6,
      full: false,
      changes: [
        { kind: "home", id: "h1", name: "Home", order: "V", updatedAt: 1760, deviceId: "desk-1" },
        { kind: "row", homeId: "h1", address: "atlas::3f9a0c1d2e4b5a67", label: "Atlas", workspaceId: null, order: "V", updatedAt: 1761, deviceId: "desk-1", deleted: true },
        { kind: "home", id: "h-old", name: "", order: "", updatedAt: 1762, deviceId: "desk-1", deleted: true, mergedInto: "h1" },
      ],
      redirects: { "h-old": "h1", bad: 3 },
      device: { deviceId: "phone-1", syncing: true },
      servers: { "rosson.k2.dev": "3f9a0c1d2e4b5a67" },
    });
    expect(r).toEqual({
      changes: [
        { kind: "home", id: "h1", name: "Home", order: "V", updatedAt: 1760, by: "desk-1" },
        { kind: "row", homeId: "h1", address: "atlas::3f9a0c1d2e4b5a67", label: "Atlas", workspaceId: null, order: "V", updatedAt: 1761, by: "desk-1", deleted: true },
        { kind: "home", id: "h-old", name: "", order: "", updatedAt: 1762, by: "desk-1", deleted: true, mergedInto: "h1" },
      ],
      cursor: 6,
      full: false,
      redirects: { "h-old": "h1" },
      servers: { "rosson.k2.dev": "3f9a0c1d2e4b5a67" },
      person: "owner",
      serverId: "3f9a0c1d2e4b5a67",
      syncing: true,
    });
    expect(typeof r.cursor).toBe("number");
    expect(parsePullReply({ full: true, cursor: 0, changes: [] })).toMatchObject({ full: true, cursor: 0 });
    // Older shapes: `homes`, a numeric-string cursor; junk cursor → null.
    expect(parsePullReply({ homes: [{ kind: "home", id: "x", name: "", order: "", updatedAt: 0 }], cursor: "42" })).toMatchObject({ cursor: 42 });
    expect(parsePullReply({ cursor: "abc" }).cursor).toBeNull();
    expect(parsePullReply({ cursor: 1.5 }).cursor).toBeNull();
    expect(parsePullReply(null)).toEqual({ changes: [], cursor: null, full: false, redirects: {}, servers: {}, person: null, serverId: null, syncing: null });
    expect(parsePullReply({ device: { deviceId: "p", syncing: false } }).syncing).toBe(false);
  });

  it("push reply: integer cursor, applied / superseded counts, rejected [{item, reason}]", () => {
    const r = parsePushReply({
      ok: true,
      cursor: 9,
      applied: 2,
      superseded: 1,
      rejected: [{ item: { kind: "home", id: "h", name: "", order: "", updatedAt: 1 }, reason: "invalid_name" }],
    });
    expect(r.cursor).toBe(9);
    expect(r.applied).toBe(2);
    expect(r.superseded).toBe(1);
    expect(r.rejected).toEqual([{ item: expect.objectContaining({ id: "h" }), reason: "invalid_name" }]);
    expect(parsePushReply({ cursor: 1, applied: 0 }).superseded).toBe(0);
  });

  it("a mergedInto tombstone goes out as one; a live Home never carries it", () => {
    expect(toWireChange({ kind: "home", id: "a", name: "", order: "", updatedAt: 1, deleted: true, mergedInto: "b" })).toMatchObject({ deleted: true, mergedInto: "b" });
    expect(toWireChange({ kind: "home", id: "a", name: "A", order: "V", updatedAt: 1, mergedInto: "b" })).not.toHaveProperty("mergedInto");
    expect(parseChangeItem({ kind: "home", id: "a", name: "A", order: "V", updatedAt: 1, mergedInto: "b" })).not.toHaveProperty("mergedInto");
  });

  it("devices: the final `{ok, devices}` envelope", () => {
    expect(
      parseDevices({
        ok: true,
        devices: [{ deviceId: "phone-1", name: "iPhone", platform: "ios", registeredAt: 1, lastSyncAt: 1_760_000_000_000, current: true }],
      })
    ).toEqual([{ deviceId: "phone-1", name: "iPhone", platform: "ios", lastSyncAt: 1_760_000_000_000, current: true }]);
    expect(parseDevices({ ok: true, devices: [] })).toEqual([]);
  });

  it("devices: a bare array is still read, seconds or ms or ISO", () => {
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
    expect(parseHomesFrame({ kind: "homes_changed", cursor: 7 })).toEqual({ type: "changed", cursor: 7 });
    expect(parseHomesFrame({ kind: "homes_changed" })).toEqual({ type: "changed", cursor: null });
    expect(parseHomesFrame({ type: "homes_changed", data: { cursor: "8" } })).toEqual({ type: "changed", cursor: 8 });
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
    tauriFetch.mockResolvedValue(res(200, { ok: true, changes: [], cursor: 3, full: false, device: { syncing: true } }));
    const r = await pullHomes(scope, "dev", 2);
    expect(r.ok && r.data.cursor).toBe(3);
    const [url, init] = tauriFetch.mock.calls[0];
    expect(url).toBe("https://home.k2.dev/cli/me/homes?deviceId=dev&since=2");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
    await pullHomes(scope, "dev", null);
    expect(tauriFetch.mock.calls[1][0]).toBe("https://home.k2.dev/cli/me/homes?deviceId=dev");
    // Cursor 0 is a cursor (sent), not "none".
    await pullHomes(scope, "dev", 0);
    expect(tauriFetch.mock.calls[2][0]).toBe("https://home.k2.dev/cli/me/homes?deviceId=dev&since=0");
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

  it("409 device_not_registered → not_registered (any other 409 stays http)", async () => {
    tauriFetch.mockResolvedValueOnce(res(409, { ok: false, error: "device_not_registered" }));
    expect(await pushHomes(scope, "d", [])).toMatchObject({ ok: false, kind: "not_registered", status: 409 });
    tauriFetch.mockResolvedValueOnce(res(409, { ok: false, error: "conflict" }));
    expect(await pushHomes(scope, "d", [])).toMatchObject({ ok: false, kind: "http", status: 409 });
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
