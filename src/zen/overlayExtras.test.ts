import { describe, expect, it } from "vitest";
import { isOverlayExtraAddr, threadHeaderTitle, visibleOverlayAgents } from "./overlayExtras";

describe("threadHeaderTitle", () => {
  it("uses the workspace name on main chat", () => {
    expect(threadHeaderTitle({ name: "Skin Test A", addr: "skin-test-a", chatTitle: "1" })).toBe(
      "Skin Test A",
    );
  });

  it("uses the chat title on an extra chat", () => {
    expect(
      threadHeaderTitle({ name: "Skin Test A", addr: "skin-test-a/qa088", chatTitle: "review" }),
    ).toBe("review");
  });

  it("falls back to the suffix when the extra has no title", () => {
    expect(threadHeaderTitle({ name: "Skin Test A", addr: "skin-test-a/qa088", chatTitle: "" })).toBe(
      "qa088",
    );
  });
});

describe("visibleOverlayAgents", () => {
  const rows = [
    { name: "Skin Test A", addr: "skin-test-a", chatTitle: null, kind: "agent" },
    { name: "Skin Test A", addr: "skin-test-a/qa088", chatTitle: "qa088", kind: "agent" },
    { name: "K2", addr: null, chatTitle: null, kind: "group" },
  ];

  it("hides archived extras until you search", () => {
    expect(visibleOverlayAgents(rows, "", ["skin-test-a/qa088"]).map((r) => r.addr)).toEqual([
      "skin-test-a",
      null,
    ]);
    expect(visibleOverlayAgents(rows, "qa088", ["skin-test-a/qa088"]).map((r) => r.addr)).toEqual([
      "skin-test-a/qa088",
    ]);
  });

  it("never hides main chat or project chat", () => {
    expect(visibleOverlayAgents(rows, "", ["skin-test-a"]).map((r) => r.kind)).toContain("group");
    expect(visibleOverlayAgents(rows, "", ["skin-test-a"]).some((r) => r.addr === "skin-test-a")).toBe(
      true,
    );
  });
});

describe("isOverlayExtraAddr", () => {
  it("is true only with a sidecar suffix", () => {
    expect(isOverlayExtraAddr("skin-test-a")).toBe(false);
    expect(isOverlayExtraAddr("skin-test-a/1")).toBe(true);
  });
});
