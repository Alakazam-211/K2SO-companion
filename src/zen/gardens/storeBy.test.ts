import { describe, expect, it, vi } from "vitest";
import { namedStoreAnswer, storeBy, viewerNameCache, VIEWER_NAME_MS } from "./storeBy";

describe("store `by` in the person's words", () => {
  it("renames you and you via, leaves agents alone", () => {
    expect(storeBy("you", "Rosson")).toBe("Rosson");
    expect(storeBy("you via fleet-canvas", "Rosson")).toBe("Rosson via fleet-canvas");
    expect(storeBy("agent:ops", "Rosson")).toBe("agent:ops");
    expect(storeBy(null, "Rosson")).toBeNull();
  });

  it("renames store.get and the list verbs' items; asks the name only when needed", async () => {
    const name = vi.fn(async () => "Rosson");
    expect(await namedStoreAnswer("store.get", { value: 1, by: "you" }, name)).toEqual({ value: 1, by: "Rosson" });
    const page = { items: [{ key: "a", by: "you via w" }, { key: "b", by: "agent:x" }], next: null };
    expect(await namedStoreAnswer("store.changes", page, name)).toEqual({
      items: [{ key: "a", by: "Rosson via w" }, { key: "b", by: "agent:x" }],
      next: null,
    });
    name.mockClear();
    const agents = { items: [{ key: "b", by: "agent:x" }] };
    expect(await namedStoreAnswer("store.list", agents, name)).toBe(agents);
    expect(await namedStoreAnswer("save.get", { by: "you" }, name)).toEqual({ by: "you" });
    expect(name).not.toHaveBeenCalled();
  });

  it("keeps the name for 30 s, and says You when viewer.get fails", async () => {
    let t = 0;
    const read = vi.fn(async () => ({ name: "Rosson" }));
    const name = viewerNameCache(read, () => t);
    expect(await name()).toBe("Rosson");
    t = VIEWER_NAME_MS - 1;
    expect(await name()).toBe("Rosson");
    expect(read).toHaveBeenCalledTimes(1);
    t = VIEWER_NAME_MS;
    await name();
    expect(read).toHaveBeenCalledTimes(2);
    expect(await viewerNameCache(async () => { throw new Error("x"); })()).toBe("You");
    expect(await viewerNameCache(async () => null)()).toBe("You");
  });
});
