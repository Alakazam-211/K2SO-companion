import { beforeEach, describe, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({ known: true }));
const ios = vi.hoisted(() => ({ on: true }));
vi.mock("../../api/scope", async (orig) => ({
  ...(await orig<typeof import("../../api/scope")>()),
  bootInfoFor: () => (boot.known ? ({} as never) : null),
}));
vi.mock("../../lib/nativePicker", () => ({ isIosWebView: () => ios.on }));

import { gardensAvailable } from "./gardensApi";

const server = (has: boolean) => ({ id: "s1", supports: () => has });

describe("gardensAvailable", () => {
  beforeEach(() => {
    boot.known = true;
    ios.on = true;
  });

  it("assumes yes until the server has answered", () => {
    boot.known = false;
    expect(gardensAvailable(server(false))).toBe(true);
  });

  it("hides once the server says it has none; shows when it does", () => {
    expect(gardensAvailable(server(false))).toBe(false);
    expect(gardensAvailable(server(true))).toBe(true);
  });

  it("never without a server or off iOS", () => {
    boot.known = false;
    expect(gardensAvailable({ id: "", supports: () => true })).toBe(false);
    ios.on = false;
    expect(gardensAvailable(server(true))).toBe(false);
  });
});
