import { describe, expect, it } from "vitest";
import { mainHandleOf, nextDrawerOrigin, workspaceSessions } from "./sessionDrawer";

const base = { workspaceName: "K2", workspaceId: "k2", workspaceColor: "#000" };

describe("workspaceSessions", () => {
  const sessions = [
    { ...base, cwd: "/ws", agentName: "k2", terminalId: "t-main", label: "main", isMainChat: true },
    { ...base, cwd: "/ws", agentName: "reviewer", terminalId: "t-rev", label: "Code review" },
    { ...base, cwd: "/ws/", agentName: "1", terminalId: "t-1", label: "" },
    { ...base, cwd: "/other", agentName: "x", terminalId: "t-x", label: "elsewhere" },
    { ...base, cwd: "/ws", agentName: "tab-6b1c", terminalId: "t-zsh", label: "zsh" },
    { ...base, cwd: "/ws", agentName: "k2:hb:nightly", terminalId: "t-hb", label: "hb" },
  ];

  it("lists this workspace's sidecars as agent/sidecar, then plain terminals", () => {
    const r = workspaceSessions(sessions, { path: "/ws", name: "K2", addr: "k2/reviewer" });
    expect(r.mainTerminalId).toBe("t-main");
    expect(r.sidecars.map((s) => [s.addr, s.chatTitle, s.terminalId])).toEqual([
      ["k2/reviewer", "Code review", "t-rev"],
      ["k2/1", "1", "t-1"],
    ]);
    expect(r.terminals).toEqual([{ terminalId: "t-zsh", title: "zsh" }]);
  });

  it("is empty without a path or handle", () => {
    expect(workspaceSessions(sessions, { path: "", name: "K2", addr: "k2" }).sidecars).toEqual([]);
    expect(workspaceSessions(sessions, { path: "/ws", name: "K2", addr: "" }).terminals).toEqual([]);
  });
});

describe("drawer origin", () => {
  it("mainHandleOf drops the sidecar suffix", () => {
    expect(mainHandleOf("k2/reviewer")).toBe("k2");
    expect(mainHandleOf("k2")).toBe("k2");
    expect(mainHandleOf(null)).toBe("");
  });

  it("first pick records the origin; later picks keep it; picking it clears", () => {
    expect(nextDrawerOrigin(null, "main", "side-a")).toBe("main");
    expect(nextDrawerOrigin("main", "side-a", "side-b")).toBe("main");
    expect(nextDrawerOrigin("main", "side-b", "main")).toBeNull();
    expect(nextDrawerOrigin(null, "main", "main")).toBeNull();
  });
});
