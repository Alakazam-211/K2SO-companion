import { describe, expect, it } from "vitest";
import {
  isOverlayExtraAddr,
  threadHeaderTitle,
  threadSessionHeaderTitle,
  threadSidecarTitle,
  visibleOverlayAgents,
} from "./overlayExtras";

describe("threadHeaderTitle", () => {
  it("uses the workspace name on main chat", () => {
    expect(threadHeaderTitle({ name: "Skin Test A", addr: "skin-test-a", chatTitle: "1" })).toBe(
      "Skin Test A",
    );
  });

  it("uses the workspace name on an extra chat", () => {
    expect(
      threadHeaderTitle({ name: "Skin Test A", addr: "skin-test-a/qa088", chatTitle: "review" }),
    ).toBe("Skin Test A");
  });
});

describe("threadSessionHeaderTitle", () => {
  it("is just <Agent> on the main chat", () => {
    expect(threadSessionHeaderTitle({ name: "K2", addr: "k2", chatTitle: null })).toBe("K2");
  });

  it("is <Agent>/<addr suffix> on a sidecar, not the renamed title", () => {
    expect(
      threadSessionHeaderTitle({ name: "K2", addr: "k2/reviewer", chatTitle: "Code review" }),
    ).toBe("K2/reviewer");
    expect(threadSessionHeaderTitle({ name: "K2", addr: "k2/3" }, true)).toBe("K2/3");
  });

  it("a Done-mode conversation id falls back to its title, then a short id", () => {
    const id = "0a0b0c0d-0000-4000-8000-0000000000c1";
    expect(threadSessionHeaderTitle({ name: "K2", addr: id, chatTitle: "Convo" }, true)).toBe(
      "K2/Convo",
    );
    expect(threadSessionHeaderTitle({ name: "K2", addr: id }, true)).toBe("K2/0a0b0c0d");
    expect(threadSessionHeaderTitle({ name: "K2", addr: id, chatTitle: "Convo" })).toBe("K2");
  });

  it("keeps the em dash when there is no name", () => {
    expect(threadSessionHeaderTitle({ name: "", addr: "k2/reviewer" })).toBe("—");
  });
});

describe("threadSidecarTitle", () => {
  it("is null on main chat", () => {
    expect(threadSidecarTitle({ addr: "skin-test-a", chatTitle: "1" })).toBeNull();
  });

  it("is the sidecar title on an extra chat", () => {
    expect(
      threadSidecarTitle({ addr: "skin-test-a/qa088", chatTitle: "Example Sidecar" }),
    ).toBe("Example Sidecar");
  });

  it("falls back to the suffix when the extra has no title", () => {
    expect(threadSidecarTitle({ addr: "skin-test-a/qa088", chatTitle: "" })).toBe("qa088");
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

  it("hides Mac-closed extras until you search", () => {
    const closed = [
      ...rows,
      {
        name: "Skin Test A",
        addr: "skin-test-a/review",
        chatTitle: "review",
        kind: "agent",
        hostLive: false,
      },
    ];
    expect(visibleOverlayAgents(closed, "", []).map((r) => r.addr)).toEqual([
      "skin-test-a",
      "skin-test-a/qa088",
      null,
    ]);
    expect(visibleOverlayAgents(closed, "review", []).map((r) => r.addr)).toEqual([
      "skin-test-a/review",
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
