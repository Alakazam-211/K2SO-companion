import { describe, expect, it } from "vitest";
import type { GlobalSession } from "../api/client";
import { terminalIdForAgent, zenThreadPath } from "./terminalJump";

function sess(partial: Partial<GlobalSession> & { terminalId: string }): GlobalSession {
  return {
    workspaceName: "w",
    workspaceId: "w",
    workspaceColor: "#000",
    agentName: "aspen",
    label: "main",
    cwd: "/Users/Bob/Aspen",
    ...partial,
  };
}

describe("terminalIdForAgent", () => {
  it("picks the main chat on the same path", () => {
    expect(
      terminalIdForAgent(
        { path: "/Users/Bob/Aspen", addr: "aspen" },
        [
          sess({ terminalId: "other", cwd: "/tmp", isMainChat: true }),
          sess({ terminalId: "main", cwd: "/Users/Bob/Aspen", isMainChat: true }),
        ]
      )
    ).toBe("main");
  });

  it("picks a sidecar by agentName suffix", () => {
    expect(
      terminalIdForAgent(
        { path: "/Users/Bob/Aspen", addr: "aspen/1" },
        [
          sess({ terminalId: "main", cwd: "/Users/Bob/Aspen", isMainChat: true, agentName: "aspen" }),
          sess({ terminalId: "side", cwd: "/Users/Bob/Aspen", isMainChat: false, agentName: "1" }),
        ]
      )
    ).toBe("side");
  });

  it("returns null when nothing matches", () => {
    expect(
      terminalIdForAgent({ path: "/Users/Bob/Aspen", addr: "aspen" }, [
        sess({ terminalId: "x", cwd: "/tmp" }),
      ])
    ).toBeNull();
    expect(terminalIdForAgent(null, [])).toBeNull();
  });
});

describe("zenThreadPath", () => {
  it("encodes the overlay agent id", () => {
    expect(zenThreadPath("/Users/Bob/Aspen")).toBe(
      "/zen?thread=%2FUsers%2FBob%2FAspen"
    );
    expect(zenThreadPath("")).toBe("/zen");
  });
});
