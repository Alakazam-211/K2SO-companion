// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStashBackend } from "./stashBackend";
import { STASH_MAX } from "./stashModel";
import { __resetStashForTests, useStashStore } from "./stashStore";

const st = () => useStashStore.getState();

beforeEach(() => {
  localStorage.clear();
  __resetStashForTests();
});

describe("stash store", () => {
  it("saves text and files to storage, then lists it", async () => {
    const b = memoryStashBackend();
    __resetStashForTests(b);
    const f = new File(["png!"], "shot.png", { type: "image/png" });
    expect(await st().save({ text: "do the thing", files: [f], source: { agent: "k2" } })).toBe("saved");
    const [saved] = await b.loadAll();
    expect(saved).toMatchObject({ text: "do the thing", source: { agent: "k2" } });
    expect(saved.attachments).toEqual([{ id: expect.any(String), name: "shot.png", type: "image/png", size: 4 }]);
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
    b.put = vi.fn(() => Promise.reject(new Error("disk full")));
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
});
