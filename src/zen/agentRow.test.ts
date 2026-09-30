import { describe, expect, it } from "vitest";
import { displayNameOf, isChattableAgentType, overlayAddrOf } from "./agentRow";

describe("isChattableAgentType", () => {
  it("rejects skill packs and leftover templates", () => {
    const skillish = ["skill", "agent-template", "k2so", "SKILL", "", undefined, null];
    expect(skillish.length).toBeGreaterThan(0);
    for (const t of skillish) {
      expect(isChattableAgentType(t as string), String(t)).toBe(false);
    }
  });

  it("keeps a row the daemon marks as an agent", () => {
    expect(isChattableAgentType("agent")).toBe(true);
    expect(isChattableAgentType("custom")).toBe(true);
  });
});

describe("overlayAddrOf", () => {
  it("uses handle, then addr, then roomHandle — never name", () => {
    expect(
      overlayAddrOf({ handle: "skin-test-a", addr: "x", roomHandle: "y" })
    ).toBe("skin-test-a");
    expect(overlayAddrOf({ handle: "", addr: "denali", roomHandle: "" })).toBe("denali");
    expect(overlayAddrOf({ handle: "  ", addr: "", roomHandle: "teton" })).toBe("teton");
    expect(overlayAddrOf({ handle: "", addr: "", roomHandle: "" })).toBeNull();
    expect(overlayAddrOf({})).toBeNull();
  });
});

describe("displayNameOf", () => {
  it("prefers displayName and leaves name untransformed", () => {
    expect(displayNameOf({ displayName: "Skin Test A", name: "k2so-Skin-Test-A" })).toBe(
      "Skin Test A"
    );
    expect(displayNameOf({ name: "k2so-Denali" })).toBe("k2so-Denali");
  });
});
