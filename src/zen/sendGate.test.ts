import { describe, expect, it } from "vitest";
import { isSendTestAddr, SEND_TEST_ADDRS } from "./sendGate";

describe("isSendTestAddr", () => {
  it("allows only the two named test rooms", () => {
    expect([...SEND_TEST_ADDRS]).toEqual(["skin-test-a", "k2so-companion-qa"]);
    expect(isSendTestAddr("skin-test-a")).toBe(true);
    expect(isSendTestAddr("k2so-companion-qa")).toBe(true);
    expect(isSendTestAddr("appa")).toBe(false);
    expect(isSendTestAddr("skin-test-b")).toBe(false);
    expect(isSendTestAddr("k2so-companion-qa/1")).toBe(false);
    expect(isSendTestAddr(null)).toBe(false);
    expect(isSendTestAddr("")).toBe(false);
  });
});
