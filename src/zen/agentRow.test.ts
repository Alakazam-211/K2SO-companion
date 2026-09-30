import { describe, expect, it } from "vitest";
import {
  ownerAgentOf,
  parseOwnerAgents,
  parseSkinAgents,
  skinInitials,
  skinRoomOf,
} from "./agentRow";

describe("skinRoomOf", () => {
  it("uses handle as addr and displayName as the label; no handle is dropped", () => {
    expect(
      skinRoomOf({
        handle: "skin-test-a",
        displayName: "Skin Test A",
        projectId: "uuid",
      })
    ).toEqual({ handle: "skin-test-a", name: "Skin Test A" });
    expect(skinRoomOf({ handle: "teton" })).toEqual({
      handle: "teton",
      name: "teton",
    });
    expect(skinRoomOf({ displayName: "Denali" })).toBeNull();
    expect(skinRoomOf({})).toBeNull();
  });

  it("blank handle is dropped; leftover roomHandle is not read", () => {
    const raw = { handle: "", displayName: "Teton", roomHandle: "teton" };
    expect(skinRoomOf(raw)).toBeNull();
  });
});

describe("parseSkinAgents", () => {
  it("accepts {agents:[]} only — live 200 is an object, not a bare array", () => {
    expect(parseSkinAgents({ agents: [{ handle: "b" }] })).toEqual([{ handle: "b" }]);
    expect(parseSkinAgents({ agents: [] })).toEqual([]);
    expect(parseSkinAgents([{ handle: "a" }])).toBeNull();
    expect(parseSkinAgents(null)).toBeNull();
    expect(parseSkinAgents({ ok: true })).toBeNull();
  });
});

describe("parseOwnerAgents / ownerAgentOf", () => {
  it("reads {ok,agents} from /cli/agent/list; names include appa and Skin Test; no invented addr", () => {
    const data = {
      ok: true,
      agents: [
        { enabled: true, live: false, mode: "local", name: "appa", path: "/Users/Baden/Appa" },
        { enabled: true, live: false, mode: "local", name: "Skin Test A", path: "/Users/Baden/AI Projects/Skin Test A" },
        { enabled: false, live: false, mode: "local", name: "k2so-agent", path: "/Users/Baden/AI Projects/K2SO Agent" },
      ],
    };
    const rows = parseOwnerAgents(data);
    expect(rows).not.toBeNull();
    const mapped = rows!.map(ownerAgentOf);
    expect(mapped.map((a) => a && a.name)).toEqual(["appa", "Skin Test A", "k2so-agent"]);
    expect(mapped[0]).toEqual({
      id: "appa",
      name: "appa",
      path: "/Users/Baden/Appa",
      addr: null,
    });
    expect(mapped[1]?.addr).toBeNull();
  });

  it("rejects a bare array — that is /cli/agents/list (skills)", () => {
    expect(parseOwnerAgents([{ name: "k2-cli", agentType: "skill" }])).toBeNull();
  });

  it("uses handle as addr only when the wire actually sends it", () => {
    expect(
      ownerAgentOf({ name: "appa", path: "/ws", handle: "appa" })?.addr
    ).toBe("appa");
  });
});

describe("skinInitials", () => {
  it("takes up to two letters from the display name", () => {
    expect(skinInitials("Skin Test A")).toBe("ST");
    expect(skinInitials("appa")).toBe("A");
  });
});
