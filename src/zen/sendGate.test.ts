import { describe, expect, it } from "vitest";
import { isSendableAddr } from "./sendGate";

/** e976d27 sendGate: only two test rooms. */
function oldIsSendTestAddr(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return addr === "skin-test-a" || addr === "k2so-companion-qa";
}

describe("isSendableAddr", () => {
  it("a thread that is neither test address is sendable", () => {
    expect(oldIsSendTestAddr("appa")).toBe(false);
    expect(oldIsSendTestAddr("skin-test-b")).toBe(false);
    expect(oldIsSendTestAddr("k2so-companion-qa/1")).toBe(false);
    expect(isSendableAddr("appa")).toBe(true);
    expect(isSendableAddr("skin-test-b")).toBe(true);
    expect(isSendableAddr("k2so-companion-qa/1")).toBe(true);
    expect(isSendableAddr("skin-test-a")).toBe(true);
    expect(isSendableAddr("k2so-companion-qa")).toBe(true);
    expect(isSendableAddr(null)).toBe(false);
    expect(isSendableAddr("")).toBe(false);
  });
});
