// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { harnessKey, recallHarness, rememberHarness } from "./harnessMemory";

describe("harnessMemory", () => {
  it("remembers the last LLM per server and chat", () => {
    localStorage.clear();
    const k = harnessKey("srv", { path: "/w/app" });
    expect(k).toBe("srv|/w/app");
    expect(recallHarness(k)).toBeNull();
    rememberHarness(k, "grok");
    expect(recallHarness(k)).toBe("grok");
    expect(recallHarness(harnessKey("other", { path: "/w/app" }))).toBeNull();
    expect(harnessKey("srv", {})).toBe("");
  });
});
