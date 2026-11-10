import { describe, expect, it } from "vitest";
import { agentPermissionRows, agentSettingRows, projectRowOf } from "./agentSettings";

const value = (rows: { label: string; value: string }[], label: string) => rows.find((r) => r.label === label)?.value;

describe("agent settings rows", () => {
  it("finds the workspace's row", () => {
    expect(projectRowOf([{ id: "a" }, { id: "b", name: "B" }], "b")).toEqual({ id: "b", name: "B" });
    expect(projectRowOf([{ id: "a" }], "z")).toBeNull();
    expect(projectRowOf({ nope: 1 }, "a")).toBeNull();
  });

  it("settings fall back to what inheriting means", () => {
    const rows = agentSettingRows({ handle: "sew", defaultAgent: "", defaultModel: null, forceModelOnResume: 1, completionSoundEnabled: 0 });
    expect(value(rows, "Handle")).toBe("sew");
    expect(value(rows, "Default agent")).toBe("Server default");
    expect(value(rows, "Default model")).toBe("Agent's default");
    expect(value(rows, "Use this model on resume")).toBe("On");
    expect(value(rows, "Completion sound")).toBe("Off");
  });

  it("permissions read 0/1, and a field an older server doesn't send has no row", () => {
    const rows = agentPermissionRows({ allowRemoteInstruct: 1, dnsManageEnabled: 0, dbAgentAccess: "read", agentsCanManageVault: 1 }, false);
    expect(value(rows, "Let agents on other servers message this agent")).toBe("On");
    expect(value(rows, "Manage DNS")).toBe("Off");
    expect(value(rows, "Create databases")).toBe("Read only");
    expect(value(rows, "Server-wide secrets")).toBe("On");
    expect(value(rows, "Manage compute")).toBeUndefined();
  });

  it("a Member doesn't see Operate compute", () => {
    expect(value(agentPermissionRows({ agentsCanOperateCompute: 1 }, false), "Operate compute")).toBe("On");
    expect(value(agentPermissionRows({ agentsCanOperateCompute: 1 }, true), "Operate compute")).toBeUndefined();
  });
});
