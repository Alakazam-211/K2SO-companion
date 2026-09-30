import { describe, expect, it } from "vitest";
import { isMine, mountainTime, normaliseThreadItem } from "./threadModel";

describe("threadModel", () => {
  it("treats owner and matching username as mine", () => {
    expect(isMine("owner", "bob")).toBe(true);
    expect(isMine("bob", "bob")).toBe(true);
    expect(isMine("k2so-Skin-Test-A", "bob")).toBe(false);
  });

  it("formats Mountain Time from unix seconds", () => {
    // 2026-09-29 20:15:21 MDT = 2026-09-30 02:15:21 UTC
    const s = mountainTime(1759198521);
    expect(s).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i);
  });

  it("normalises Skin-shaped items", () => {
    const m = normaliseThreadItem(
      {
        id: "m1",
        seq: 3,
        doc: { from: "k2so-Skin-Test-A", body: "hello", created_at: 1759198521 },
      },
      "bob"
    );
    expect(m?.text).toBe("hello");
    expect(m?.mine).toBe(false);
    expect(m?.from).toBe("k2so-Skin-Test-A");
  });
});