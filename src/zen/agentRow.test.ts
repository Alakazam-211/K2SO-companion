import { describe, expect, it } from "vitest";
import {
  JOIN_DUP_PATH,
  JOIN_NO_AGENT,
  JOIN_NO_HANDLE,
  JOIN_NO_PATH,
  JOIN_NO_PROJECT,
  cliProjectOf,
  iconRevOf,
  joinAgentsWithProjects,
  ownerAgentOf,
  parseCliProjects,
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
  it("reads {ok,agents} from /cli/agent/list; names include aspen and Skin Test; no invented addr", () => {
    const data = {
      ok: true,
      agents: [
        { enabled: true, live: false, mode: "local", name: "aspen", path: "/Users/Bob/Aspen" },
        { enabled: true, live: false, mode: "local", name: "Skin Test A", path: "/Users/Bob/AI Projects/Skin Test A" },
        { enabled: false, live: false, mode: "local", name: "k2so-agent", path: "/Users/Bob/AI Projects/K2SO Agent" },
      ],
    };
    const rows = parseOwnerAgents(data);
    expect(rows).not.toBeNull();
    const mapped = rows!.map(ownerAgentOf);
    expect(mapped.map((a) => a && a.name)).toEqual(["aspen", "Skin Test A", "k2so-agent"]);
    expect(mapped[0]).toEqual({
      id: "aspen",
      name: "aspen",
      path: "/Users/Bob/Aspen",
      addr: null,
      mode: "local",
      enabled: true,
      live: false,
    });
    expect(mapped[1]?.addr).toBeNull();
  });

  it("rejects a bare array — that is /cli/agents/list (skills)", () => {
    expect(parseOwnerAgents([{ name: "k2-cli", agentType: "skill" }])).toBeNull();
  });

  it("uses handle as addr only when the wire actually sends it", () => {
    expect(
      ownerAgentOf({ name: "aspen", path: "/ws", handle: "aspen" })?.addr
    ).toBe("aspen");
  });
});

describe("parseCliProjects / cliProjectOf", () => {
  it("reads a bare array; handle and path come from the wire", () => {
    const data = [
      { name: "aspen", handle: "aspen", path: "/Users/Bob/Aspen" },
      { name: "Skin Test A", handle: "skin-test-a", path: "/Users/Bob/AI Projects/Skin Test A" },
      { name: "K2 Companion QA", handle: "k2so-companion-qa", path: "/Users/Bob/AI Projects/K2SO Companion QA" },
      { name: "Orbit", handle: "manager-2", path: "/Users/Bob/AI Projects/Orbit" },
    ];
    const rows = parseCliProjects(data);
    expect(rows).not.toBeNull();
    const mapped = rows!.map(cliProjectOf);
    expect(mapped.map((a) => a && a.handle)).toEqual([
      "aspen",
      "skin-test-a",
      "k2so-companion-qa",
      "manager-2",
    ]);
    expect(mapped[2]).toEqual({
      name: "K2 Companion QA",
      path: "/Users/Bob/AI Projects/K2SO Companion QA",
      handle: "k2so-companion-qa",
      color: null,
      iconUrl: null,
      iconRev: null,
    });
    expect(mapped[3]?.handle).toBe("manager-2");
  });

  it("rejects {ok,agents} — that is /cli/agent/list, not the address book", () => {
    expect(
      parseCliProjects({ ok: true, agents: [{ name: "aspen", path: "/Users/Bob/Aspen" }] })
    ).toBeNull();
  });

  it("rejects a skills enumerator — no handle+path on the rows", () => {
    expect(parseCliProjects([{ name: "k2-cli", agentType: "skill" }])).toBeNull();
  });

  it("reads iconRev when K2 sends it (string or number), else null", () => {
    const rows = parseCliProjects([
      { name: "a", handle: "a", path: "/a", iconUrl: "data:image/png;base64,AA==", iconRev: " r7 " },
      { name: "b", handle: "b", path: "/b", iconRev: 42 },
      { name: "c", handle: "c", path: "/c", iconRev: "" },
      { name: "d", handle: "d", path: "/d" },
    ])!;
    expect(rows.map((r) => cliProjectOf(r)?.iconRev)).toEqual(["r7", "42", null, null]);
    expect(iconRevOf(Number.NaN)).toBeNull();
    expect(iconRevOf({})).toBeNull();
  });
});

describe("joinAgentsWithProjects", () => {
  it("joins on path and takes handle from the project row, including handles that do not resemble the name", () => {
    const joined = joinAgentsWithProjects(
      [
        { name: "aspen", path: "/Users/Bob/Aspen" },
        { name: "Skin Test A", path: "/Users/Bob/AI Projects/Skin Test A" },
        { name: "K2 Companion QA", path: "/Users/Bob/AI Projects/K2SO Companion QA" },
        { name: "Orbit", path: "/Users/Bob/AI Projects/Orbit" },
      ],
      [
        { name: "aspen", path: "/Users/Bob/Aspen", handle: "aspen" },
        { name: "Skin Test A", path: "/Users/Bob/AI Projects/Skin Test A", handle: "skin-test-a" },
        { name: "K2 Companion QA", path: "/Users/Bob/AI Projects/K2SO Companion QA", handle: "k2so-companion-qa" },
        { name: "Orbit", path: "/Users/Bob/AI Projects/Orbit", handle: "manager-2" },
      ]
    );
    expect(joined.map((r) => [r.name, r.addr, r.joinMiss])).toEqual([
      ["aspen", "aspen", null],
      ["Skin Test A", "skin-test-a", null],
      ["K2 Companion QA", "k2so-companion-qa", null],
      ["Orbit", "manager-2", null],
    ]);
  });

  it("carries desktop color and iconUrl from the project row onto the overlay row", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "aspen", path: "/Users/Bob/Aspen" }],
      [
        {
          name: "aspen",
          path: "/Users/Bob/Aspen",
          handle: "aspen",
          color: "#22c55e",
          iconUrl: "https://example.k2.dev/aspen.png",
        },
      ]
    );
    expect(joined[0].color).toBe("#22c55e");
    expect(joined[0].iconUrl).toBe("https://example.k2.dev/aspen.png");
  });

  it("carries mode, enabled, and live from the fleet row", () => {
    const joined = joinAgentsWithProjects(
      [
        {
          name: "aspen",
          path: "/Users/Bob/Aspen",
          mode: "custom",
          enabled: true,
          live: true,
        },
      ],
      [{ name: "aspen", path: "/Users/Bob/Aspen", handle: "aspen" }]
    );
    expect(joined[0]).toMatchObject({
      addr: "aspen",
      mode: "custom",
      enabled: true,
      live: true,
    });
  });

  it("does not join on display name when paths differ", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "Orbit", path: "/Users/Bob/AI Projects/Orbit" }],
      [{ name: "Orbit", path: "/somewhere/else", handle: "manager-2" }]
    );
    expect(joined).toHaveLength(2);
    expect(joined[0]).toMatchObject({
      name: "Orbit",
      path: "/Users/Bob/AI Projects/Orbit",
      addr: null,
      joinMiss: JOIN_NO_PROJECT,
    });
    expect(joined[1]).toMatchObject({
      name: "Orbit",
      path: "/somewhere/else",
      addr: null,
      joinMiss: JOIN_NO_AGENT,
    });
    expect(joined.some((r) => r.addr === "manager-2")).toBe(false);
  });

  it("keeps an agent-only path visible and not chattable", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "aspen", path: "/Users/Bob/Aspen" }],
      []
    );
    expect(joined).toEqual([
      {
        id: "/Users/Bob/Aspen",
        name: "aspen",
        path: "/Users/Bob/Aspen",
        addr: null,
        joinMiss: JOIN_NO_PROJECT,
        mode: null,
        enabled: null,
        live: null,
        chatTitle: null,
        color: null,
        iconUrl: null,
      },
    ]);
  });

  it("keeps a project-only path visible and not chattable — does not use its handle", () => {
    const joined = joinAgentsWithProjects(
      [],
      [{ name: "Skin Test A", path: "/Users/Bob/AI Projects/Skin Test A", handle: "skin-test-a" }]
    );
    expect(joined).toEqual([
      {
        id: "/Users/Bob/AI Projects/Skin Test A",
        name: "Skin Test A",
        path: "/Users/Bob/AI Projects/Skin Test A",
        addr: null,
        joinMiss: JOIN_NO_AGENT,
        mode: null,
        enabled: null,
        live: null,
        chatTitle: null,
        color: null,
        iconUrl: null,
      },
    ]);
  });

  it("a joined path with an empty handle is not chattable", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "aspen", path: "/Users/Bob/Aspen" }],
      [{ name: "aspen", path: "/Users/Bob/Aspen", handle: null }]
    );
    expect(joined[0]).toMatchObject({
      addr: null,
      joinMiss: JOIN_NO_HANDLE,
    });
  });

  it("joins paths that differ only by a trailing slash", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "aspen", path: "/Users/Bob/Aspen/" }],
      [{ name: "aspen", path: "/Users/Bob/Aspen", handle: "aspen" }]
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      addr: "aspen",
      joinMiss: null,
      path: "/Users/Bob/Aspen",
    });
  });

  it("an empty path cannot join", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "orphan", path: "" }],
      [{ name: "book", path: "", handle: "book" }]
    );
    expect(joined.every((r) => r.addr === null)).toBe(true);
    expect(joined.every((r) => r.joinMiss === JOIN_NO_PATH)).toBe(true);
    expect(joined).toHaveLength(2);
  });

  it("slash handles on the same path become sidecar rows, not JOIN_DUP_PATH", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "aspen", path: "/Users/Bob/Aspen", mode: "custom", enabled: true, live: true }],
      [
        { name: "aspen", path: "/Users/Bob/Aspen", handle: "aspen" },
        { name: "1", path: "/Users/Bob/Aspen", handle: "aspen/1" },
      ]
    );
    expect(joined.map((r) => [r.name, r.addr, r.chatTitle, r.joinMiss])).toEqual([
      ["aspen", "aspen", null, null],
      ["aspen", "aspen/1", "1", null],
    ]);
    expect(joined[1].id).toBe("/Users/Bob/Aspen#aspen/1");
  });

  it("two non-slash handles on one path are still JOIN_DUP_PATH", () => {
    const joined = joinAgentsWithProjects(
      [{ name: "aspen", path: "/Users/Bob/Aspen" }],
      [
        { name: "aspen", path: "/Users/Bob/Aspen", handle: "aspen" },
        { name: "other", path: "/Users/Bob/Aspen", handle: "other" },
      ]
    );
    expect(joined).toHaveLength(1);
    expect(joined[0].joinMiss).toBe(JOIN_DUP_PATH);
    expect(joined[0].addr).toBeNull();
  });
});

describe("skinInitials", () => {
  it("takes up to two letters from the display name", () => {
    expect(skinInitials("Skin Test A")).toBe("ST");
    expect(skinInitials("aspen")).toBe("A");
  });
});
