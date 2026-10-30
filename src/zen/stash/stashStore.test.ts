// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStashBackend } from "./stashBackend";
import { STASH_MAX } from "./stashModel";
import { __resetStashForTests, useStashStore } from "./stashStore";
import { __resetHomesSyncForTests } from "../homesSync";

const st = () => useStashStore.getState();

beforeEach(() => {
  localStorage.clear();
  __resetHomesSyncForTests({ deviceId: "phone-1" });
  __resetStashForTests(memoryStashBackend());
});

describe("stash store", () => {
  it("saves text and files to storage, then lists it", async () => {
    const b = memoryStashBackend();
    __resetStashForTests(b);
    const f = new File(["png!"], "shot.png", { type: "image/png" });
    expect(await st().save({ text: "do the thing", files: [f], source: { agent: "k2" } })).toBe("saved");
    const [saved] = await b.loadAll();
    expect(saved).toMatchObject({ text: "do the thing", source: { agent: "k2" } });
    expect(saved.attachments).toEqual([
      { id: expect.any(String), name: "shot.png", type: "image/png", size: 4, device_id: "phone-1", path: null },
    ]);
    const taken = await st().take(saved.id);
    expect(taken?.text).toBe("do the thing");
    expect(taken?.files.map((x) => x.name)).toEqual(["shot.png"]);
    expect(await taken!.files[0].text()).toBe("png!");
    // Default: it stays (a template).
    expect(st().items.filter((i) => !i.deleted_at)).toHaveLength(1);
  });

  it("nothing to stash: empty", async () => {
    expect(await st().save({ text: "  \n" })).toBe("empty");
  });

  it("a failed write is an error, never 'saved'", async () => {
    const b = memoryStashBackend();
    b.write = vi.fn(() => Promise.reject(new Error("disk full")));
    __resetStashForTests(b);
    expect(await st().save({ text: "keep me" })).toBe("error");
    expect(st().items).toHaveLength(0);
  });

  it("at the cap: asks (full), then replaces the oldest with a tombstone", async () => {
    for (let i = 0; i < STASH_MAX; i++) await st().save({ text: `n${i}` });
    const oldest = st().items[0];
    expect(await st().save({ text: "one more" })).toBe("full");
    expect(await st().save({ text: "one more" }, { replaceOldest: true })).toBe("saved");
    const live = st().items.filter((i) => !i.deleted_at);
    expect(live).toHaveLength(STASH_MAX);
    expect(st().items.find((i) => i.id === oldest.id)?.deleted_at).toEqual(expect.any(Number));
  });

  it("remove leaves a tombstone; 'remove after use' drops it on take", async () => {
    await st().save({ text: "a" });
    await st().save({ text: "b" });
    const [a, b] = st().items;
    await st().remove(a.id);
    expect(st().items.find((i) => i.id === a.id)).toMatchObject({ text: "", deleted_at: expect.any(Number) });
    expect(await st().take(a.id)).toBeNull();
    st().setRemoveAfterUse(true);
    expect(localStorage.getItem("k2.zen.stash.removeAfterUse")).toBe("1");
    expect((await st().take(b.id))?.text).toBe("b");
    expect(st().items.find((i) => i.id === b.id)?.deleted_at).toEqual(expect.any(Number));
  });

  it("hydrate loads what storage has (another launch)", async () => {
    const b = memoryStashBackend();
    __resetStashForTests(b);
    await st().save({ text: "survives" });
    __resetStashForTests(b);
    expect(st().items).toHaveLength(0);
    await st().hydrate();
    expect(st().items.map((i) => i.text)).toEqual(["survives"]);
  });

  it("no IndexedDB: saves fail (the draft stays), nothing pretends to be stored", async () => {
    __resetStashForTests(null);
    expect(await st().save({ text: "keep me" })).toBe("error");
    expect(st().unavailable).toBe(true);
    expect(st().items).toHaveLength(0);
  });

  it("a failed load is retried on the next hydrate, not swapped for memory", async () => {
    const b = memoryStashBackend();
    const real = b.loadAll;
    b.loadAll = vi.fn().mockRejectedValueOnce(new Error("Connection to Indexed Database server lost")).mockImplementation(real);
    __resetStashForTests(b);
    expect(await st().save({ text: "first" })).toBe("error");
    expect(st().unavailable).toBe(true);
    expect(await st().save({ text: "second" })).toBe("saved");
    expect(st().unavailable).toBe(false);
    expect((await b.loadAll()).map((i) => i.text)).toEqual(["second"]);
  });

  it("two saves at 49 never make 51: the second asks", async () => {
    for (let i = 0; i < STASH_MAX - 1; i++) await st().save({ text: `n${i}` });
    const [a, c] = await Promise.all([st().save({ text: "a" }), st().save({ text: "c" })]);
    expect([a, c]).toEqual(["saved", "full"]);
    expect(st().items.filter((i) => !i.deleted_at)).toHaveLength(STASH_MAX);
  });

  it("at the cap, the new item and the oldest's tombstone are one write", async () => {
    const b = memoryStashBackend();
    __resetStashForTests(b);
    for (let i = 0; i < STASH_MAX; i++) await st().save({ text: `n${i}` });
    const spy = vi.spyOn(b, "write");
    await st().save({ text: "one more" }, { replaceOldest: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].put?.map((i) => i.text)).toEqual(["one more", ""]);
  });

  it("take reports files it could not read back", async () => {
    const b = memoryStashBackend();
    __resetStashForTests(b);
    await st().save({ text: "with file", files: [new File(["x"], "a.txt")] });
    b.getBlobs = vi.fn(async () => []);
    const taken = await st().take(st().items[0].id);
    expect(taken).toMatchObject({ text: "with file", files: [], missing: [{ name: "a.txt", elsewhere: false }] });
  });

  it("a saved file records this phone as its device, with no path", async () => {
    await st().save({ text: "f", files: [new File(["x"], "a.txt", { type: "text/plain" })] });
    expect(st().items[0].attachments).toEqual([
      { id: expect.any(String), name: "a.txt", type: "text/plain", size: 1, device_id: "phone-1", path: null },
    ]);
  });

  it("take brings back this phone's files and reports another device's as elsewhere", async () => {
    const b = memoryStashBackend();
    __resetStashForTests(b);
    await st().save({ text: "mine", files: [new File(["x"], "mine.txt")] });
    const mine = st().items[0];
    const synced = {
      ...mine,
      id: "from-mac",
      attachments: [{ id: "m1", name: "desk.png", type: "image/png", size: 9, device_id: "mac-1", path: "/Users/r/desk.png" }],
    };
    // Even if bytes with that id happened to be here, they aren't this phone's.
    await b.write({ put: [synced], putBlobs: [{ id: "m1", name: "desk.png", type: "image/png", buf: new ArrayBuffer(1) }] });
    useStashStore.setState({ items: [...st().items, synced] });

    const a = await st().take(mine.id);
    expect(a?.files.map((f) => f.name)).toEqual(["mine.txt"]);
    expect(a?.missing).toEqual([]);
    const m = await st().take("from-mac");
    expect(m?.files).toEqual([]);
    expect(m?.missing).toMatchObject([{ name: "desk.png", device_id: "mac-1", path: "/Users/r/desk.png", elsewhere: true }]);
  });
});
