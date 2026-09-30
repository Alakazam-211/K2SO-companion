import { describe, expect, it } from "vitest";
import { overlayRowPreview } from "./rowPreview";
import { JOIN_NO_PROJECT } from "./agentRow";

describe("overlayRowPreview", () => {
  it("uses the baseline group wording with the live member count", () => {
    expect(
      overlayRowPreview({ kind: "group", memberCount: 6 })
    ).toBe("6 members · this server");
    expect(
      overlayRowPreview({ kind: "group", memberCount: 1 })
    ).toBe("1 member · this server");
  });

  it("keeps a join miss as the descriptor", () => {
    expect(overlayRowPreview({ joinMiss: JOIN_NO_PROJECT })).toBe(JOIN_NO_PROJECT);
  });

  it("names a sidecar from the handle, not from the display name", () => {
    expect(
      overlayRowPreview({ addr: "k2so-companion/1", mode: "custom", live: true })
    ).toBe("Sidecar · same workspace, extra chat");
  });

  it("words mode, live, and off the way the examples read", () => {
    expect(
      overlayRowPreview({ addr: "aspen", mode: "custom", enabled: true, live: true })
    ).toBe("Live · custom");
    expect(
      overlayRowPreview({ addr: "aspen", mode: "manager", enabled: true, live: false })
    ).toBe("manager");
    expect(
      overlayRowPreview({ addr: "aspen", mode: "off", enabled: false, live: false })
    ).toBe("Off");
    expect(
      overlayRowPreview({ addr: "aspen", mode: "custom", enabled: false, live: false })
    ).toBe("Off");
    expect(
      overlayRowPreview({ addr: "k2", mode: "k2", enabled: true, live: true })
    ).toBe("Live · K2");
    expect(overlayRowPreview({ addr: "aspen" })).toBe("canonical");
  });
});
