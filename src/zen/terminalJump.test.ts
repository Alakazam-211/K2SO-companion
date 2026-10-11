import { describe, expect, it } from "vitest";
import type { GlobalSession } from "../api/client";
import { terminalIdForAgent, zenThreadPath } from "./terminalJump";

function sess(partial: Partial<GlobalSession> & { terminalId: string }): GlobalSession {
  return {
    workspaceName: "w",
    workspaceId: "w",
    workspaceColor: "#000",
    agentName: "appa",
    label: "main",
    cwd: "/Users/Baden/Appa",
    ...partial,
  };
}

describe("terminalIdForAgent", () => {
  it("picks the main chat on the same path", () => {
    expect(
      terminalIdForAgent(
        { path: "/Users/Baden/Appa", addr: "appa" },
        [
          sess({ terminalId: "other", cwd: "/tmp", isMainChat: true }),
          sess({ terminalId: "main", cwd: "/Users/Baden/Appa", isMainChat: true }),
        ]
      )
    ).toBe("main");
  });

  it("picks a sidecar by agentName suffix", () => {
    expect(
      terminalIdForAgent(
        { path: "/Users/Baden/Appa", addr: "appa/1" },
        [
          sess({ terminalId: "main", cwd: "/Users/Baden/Appa", isMainChat: true, agentName: "appa" }),
          sess({ terminalId: "side", cwd: "/Users/Baden/Appa", isMainChat: false, agentName: "1" }),
        ]
      )
    ).toBe("side");
  });

  it("does not fall back to main chat when the sidecar host is gone", () => {
    expect(
      terminalIdForAgent(
        {
          path: "/Users/Baden/AI Projects/Skin Test A",
          addr: "skin-test-a/qa088",
        },
        [
          sess({
            terminalId: "main",
            cwd: "/Users/Baden/AI Projects/Skin Test A",
            isMainChat: true,
            agentName: "6fe8c8c6-a207-4612-930c-efa5c8051931",
            label: "main chat",
          }),
        ]
      )
    ).toBeNull();
  });

  it("a plain tab's ws/N Thread uses the row's own live PTY", () => {
    const sessions = [
      sess({ terminalId: "main", isMainChat: true }),
      sess({ terminalId: "t-77", agentName: "tab-77" }),
    ];
    expect(
      terminalIdForAgent({ path: "/Users/Baden/Appa", addr: "appa/3", terminalId: "t-77" }, sessions)
    ).toBe("t-77");
    // A stale id is not trusted.
    expect(
      terminalIdForAgent({ path: "/Users/Baden/Appa", addr: "appa/3", terminalId: "gone" }, sessions)
    ).toBeNull();
  });

  it("a History conversation addr never falls back to the main chat", () => {
    expect(
      terminalIdForAgent(
        { path: "/Users/Baden/Appa", addr: "f014e8d8-2140-4902-b0b7-a864af664f7e" },
        [sess({ terminalId: "main", isMainChat: true })]
      )
    ).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(
      terminalIdForAgent({ path: "/Users/Baden/Appa", addr: "appa" }, [
        sess({ terminalId: "x", cwd: "/tmp" }),
      ])
    ).toBeNull();
    expect(terminalIdForAgent(null, [])).toBeNull();
  });
});

describe("zenThreadPath", () => {
  it("encodes the overlay agent id", () => {
    expect(zenThreadPath("/Users/Baden/Appa")).toBe(
      "/zen?thread=%2FUsers%2FBaden%2FAppa"
    );
    expect(zenThreadPath("")).toBe("/zen");
  });
});
