// MS26 / MA26: at most 4 HTTP requests in flight per server; a slow B
// queues behind B only.

import { beforeEach, describe, expect, it } from "vitest";
import {
  HTTP_MAX_INFLIGHT_PER_SERVER,
  __resetHttpCapForTests,
  httpInFlight,
  withHttpSlot,
} from "./httpCap";

beforeEach(() => __resetHttpCapForTests());

function gate() {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

describe("HTTP cap per server", () => {
  it("runs 4 at once on one server; the 5th waits for a slot", async () => {
    const gates = Array.from({ length: 5 }, gate);
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      withHttpSlot("b", async () => {
        started.push(i);
        await g.p;
        return i;
      })
    );
    expect(started).toEqual([0, 1, 2, 3]);
    expect(httpInFlight("b")).toBe(HTTP_MAX_INFLIGHT_PER_SERVER);
    gates[0].open();
    await runs[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    for (const g of gates) g.open();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
    expect(httpInFlight("b")).toBe(0);
  });

  it("a full B never blocks A", async () => {
    const g = gate();
    for (let i = 0; i < 4; i++) void withHttpSlot("b", () => g.p);
    let ranOnA = false;
    await withHttpSlot("a", async () => {
      ranOnA = true;
    });
    expect(ranOnA).toBe(true);
    g.open();
  });

  it("a failure frees its slot", async () => {
    await expect(
      withHttpSlot("b", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(httpInFlight("b")).toBe(0);
  });
});
