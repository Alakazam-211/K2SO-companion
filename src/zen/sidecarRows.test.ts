import { describe, expect, it } from "vitest";
import {
  nextSidecarAddr,
  parseCompanionSessions,
  sidecarSuffix,
  sidecarsFromSessions,
} from "./sidecarRows";

/** d9ba096 openSidecar always minted handle/1. */
function oldOpenSidecarAddr(addr: string): string {
  return `${addr.split("/")[0]}/1`;
}

describe("nextSidecarAddr", () => {
  it("the next unused sidecar is not always /1", () => {
    expect(oldOpenSidecarAddr("aspen")).toBe("aspen/1");
    expect(oldOpenSidecarAddr("ai-trading-platform")).toBe("ai-trading-platform/1");
    expect(nextSidecarAddr("aspen", [])).toBe("aspen/1");
    expect(nextSidecarAddr("aspen", ["aspen/1"])).toBe("aspen/2");
    expect(nextSidecarAddr("aspen", ["aspen/1"])).not.toBe(oldOpenSidecarAddr("aspen"));
    expect(nextSidecarAddr("aspen", ["aspen/1", "aspen/2"])).toBe("aspen/3");
    expect(nextSidecarAddr("aspen", ["aspen/reviewer"])).toBe("aspen/1");
    expect(nextSidecarAddr("ai-trading-platform", ["ai-trading-platform/1"])).toBe(
      "ai-trading-platform/2"
    );
  });
});

describe("sidecarsFromSessions", () => {
  const aspen = { path: "/Users/Bob/Aspen", name: "aspen", addr: "aspen" };
  const trading = {
    path: "/Users/Bob/AI Projects/Trading",
    name: "AI Trading Platform",
    addr: "ai-trading-platform",
  };

  it("lists real server sidecars with the workspace name and the session title", () => {
    const rows = sidecarsFromSessions(
      [
        {
          cwd: "/Users/Bob/Aspen",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: "/Users/Bob/AI Projects/Trading",
          agentName: "1",
          label: "1",
          isMainChat: false,
        },
        {
          cwd: "/Users/Bob/Aspen",
          agentName: "aspen",
          label: "main chat tab",
          isMainChat: true,
        },
      ],
      [aspen, trading]
    );
    expect(rows).toEqual([
      { addr: "aspen/1", path: aspen.path, name: "aspen", chatTitle: "1" },
      {
        addr: "ai-trading-platform/1",
        path: trading.path,
        name: "AI Trading Platform",
        chatTitle: "1",
      },
    ]);
    expect(rows[0].name).not.toBe("aspen / 1");
    expect(rows[0].chatTitle).not.toBe(rows[0].name);
  });

  it("does not invent a sidecar when the session list is empty", () => {
    expect(sidecarsFromSessions([], [aspen])).toEqual([]);
  });

  it("skips a session with no agentName rather than guessing /1", () => {
    expect(
      sidecarsFromSessions(
        [{ cwd: aspen.path, label: "mystery", isMainChat: false }],
        [aspen]
      )
    ).toEqual([]);
  });
});

describe("parseCompanionSessions", () => {
  it("accepts a bare array or {sessions:[]}", () => {
    expect(parseCompanionSessions([{ agentName: "1" }])).toEqual([{ agentName: "1" }]);
    expect(parseCompanionSessions({ sessions: [{ agentName: "2" }] })).toEqual([
      { agentName: "2" },
    ]);
    expect(parseCompanionSessions({ ok: true })).toBeNull();
    expect(parseCompanionSessions(null)).toBeNull();
  });
});

describe("sidecarSuffix", () => {
  it("takes the part after the workspace handle", () => {
    expect(sidecarSuffix("aspen/1")).toBe("1");
    expect(sidecarSuffix("sales/reviewer")).toBe("reviewer");
    expect(sidecarSuffix("aspen")).toBe("");
  });
});
