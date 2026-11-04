import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })) }));
vi.mock("@tauri-apps/api/core", () => core);

import { __resetSecureTokensForTests, syncSecureTokens } from "./secureTokens";

beforeEach(() => {
  vi.useFakeTimers();
  __resetSecureTokensForTests();
  core.invoke.mockClear();
  core.invoke.mockImplementation(async () => ({ ok: true }));
});
afterEach(() => vi.useRealTimers());

describe("the Keychain copy of login tokens", () => {
  it("sends the whole set once for a burst of changes", async () => {
    syncSecureTokens({ a: "1" }, true);
    syncSecureTokens({ a: "1", b: "2" }, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(core.invoke).toHaveBeenCalledWith("plugin:k2-push|token_op", { op: "sync", tokens: { a: "1", b: "2" } });
  });

  it("skips a set it already stored, and retries one the Keychain refused", async () => {
    syncSecureTokens({ a: "1" }, true);
    await vi.advanceTimersByTimeAsync(300);
    syncSecureTokens({ a: "1" }, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(core.invoke).toHaveBeenCalledTimes(1);

    core.invoke.mockImplementation(async () => ({ ok: false }));
    syncSecureTokens({}, true);
    await vi.advanceTimersByTimeAsync(300);
    syncSecureTokens({}, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(core.invoke).toHaveBeenCalledTimes(3);
  });

  it("does nothing off iOS", async () => {
    syncSecureTokens({ a: "1" }, false);
    await vi.advanceTimersByTimeAsync(300);
    expect(core.invoke).not.toHaveBeenCalled();
  });
});
