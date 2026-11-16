// @vitest-environment jsdom
// "Most recent at the top": only the person's own sends stamp rows, at most
// once per target per 30 s plus one trailing stamp (desktop home-row-stamp).
import { beforeEach, describe, expect, it } from "vitest";
import { useServersStore } from "../../stores/servers";
import { useHomesStore } from "../homes";
import { STAMP_MIN_GAP_MS, createSendStamper, noteAgentSend, noteHomeChatSend, rowMatchesTarget, type SendTarget } from "./homeRowStamp";

beforeEach(() => {
  localStorage.clear();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "Studio", url: "https://studio.k2.dev", username: "r", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t" },
    hydrated: true,
  });
  useHomesStore.getState().reload();
  useHomesStore.getState().ensureSeeded();
});

describe("send stamps", () => {
  it("rate-limits per target: one stamp, then one trailing stamp after the gap", () => {
    let now = 1000;
    const stamps: [string, number][] = [];
    const timers: { at: number; fn: () => void }[] = [];
    const stamp = createSendStamper({
      stamp: (t, at) => stamps.push([t.kind === "agent" ? t.addr : "", at]),
      now: () => now,
      schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
    });
    const t: SendTarget = { kind: "agent", serverId: "s1", addr: "atlas" };
    stamp(t);
    now += 1000;
    stamp(t);
    now += 1000;
    stamp(t);
    expect(stamps).toEqual([["atlas", 1000]]);
    expect(timers).toHaveLength(1);
    expect(timers[0].at).toBe(1000 + STAMP_MIN_GAP_MS);
    now = timers[0].at;
    timers[0].fn();
    expect(stamps).toEqual([
      ["atlas", 1000],
      ["atlas", 3000],
    ]);
    // Another agent is its own target.
    stamp({ kind: "agent", serverId: "s1", addr: "forge" });
    expect(stamps).toHaveLength(3);
  });

  it("an agent send stamps that agent's rows on that server, in every group; sidecars count as their agent", () => {
    const s = useHomesStore.getState();
    const g1 = s.selectedId;
    const g2 = s.createGroup();
    s.addRow(g1, { address: "atlas::studio.k2.dev", workspaceId: null, label: "Atlas" });
    s.addRow(g2, { address: "atlas::studio.k2.dev", workspaceId: null, label: "Atlas" });
    s.addRow(g2, { address: "atlas::other.k2.dev", workspaceId: null, label: "Atlas elsewhere" });
    noteAgentSend("s1", "atlas/2");
    const rows = useHomesStore.getState().homes.flatMap((h) => h.rows);
    expect(rows.filter((r) => typeof r.lastMessagedAt === "number").map((r) => r.address)).toEqual([
      "atlas::studio.k2.dev",
      "atlas::studio.k2.dev",
    ]);
  });

  it("the Home chat hook stamps a person's or a channel's row, never an agent's with the same handle", () => {
    expect(
      rowMatchesTarget({ address: "42::studio.k2.dev", workspaceId: null, label: "" }, { kind: "channel", serverId: "s1", conv: "42" })
    ).toBe(false);
    const s = useHomesStore.getState();
    const g = s.selectedId;
    s.addRow(g, { kind: "person", address: "k2:connect:ab-1::studio.k2.dev", workspaceId: null, label: "Sam" });
    s.addRow(g, { kind: "channel", address: "42::studio.k2.dev", workspaceId: null, label: "general" });
    noteHomeChatSend("s1", { kind: "person", ext: "k2:connect:AB-1" });
    noteHomeChatSend("s1", { kind: "channel", conv: "42" });
    const rows = useHomesStore.getState().homes[0].rows;
    expect(rows.every((r) => typeof r.lastMessagedAt === "number")).toBe(true);
  });
});
