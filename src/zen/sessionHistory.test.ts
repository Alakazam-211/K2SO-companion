import { describe, expect, it } from "vitest";
import {
  buildHistory,
  historyCandidates,
  latestBatches,
  launchForHarness,
  parseChatList,
  parseThreadLatest,
  parseWorkspaceLive,
  threadAddrOfLive,
} from "./sessionHistory";
import type { ActiveLlm } from "./llmPresets";

describe("threadAddrOfLive", () => {
  const live = parseWorkspaceLive([
    { sessionId: "t-main", kind: "canonical", handle: "k2", conversationId: "c-main" },
    { sessionId: "t-tab", kind: "sidecar", handle: "k2/3", conversationId: "c-tab" },
    { sessionId: "t-api", kind: "other", handle: "", conversationId: "c-api" },
    { sessionId: "t-zsh", kind: "other", handle: "" },
  ]);
  const by = new Map(live.map((l) => [l.sessionId, l]));

  it("prefers the ws/N handle, else the conversation id, else nothing", () => {
    expect(threadAddrOfLive(by.get("t-tab"))).toBe("k2/3");
    expect(threadAddrOfLive(by.get("t-api"))).toBe("c-api");
    expect(threadAddrOfLive(by.get("t-zsh"))).toBeNull();
    expect(threadAddrOfLive(undefined)).toBeNull();
  });
});

describe("buildHistory", () => {
  const chats = parseChatList([
    { sessionId: "a", provider: "claude", title: "alpha\nsecond line", timestamp: 1_700_000_900_000 },
    { sessionId: "b", provider: "codex", title: "beta", timestamp: 1_700_000_100_000 },
    { sessionId: "c", provider: "grok", title: "gamma", timestamp: 1_700_000_000_000, archived: true },
    { sessionId: "live", provider: "claude", title: "open", timestamp: 1_700_000_500_000 },
    { sessionId: "x", provider: "claude", title: "no thread", timestamp: 1_700_000_400_000 },
    { sessionId: "r", provider: "cursor-agent", title: "remembered chat", timestamp: 1_700_000_200_000 },
  ]);
  const latest = parseThreadLatest({
    items: [
      { addr: "a", conversationId: "a", at: 1_700_000_050 },
      { addr: "b", conversationId: "b", at: null },
      { addr: "x", error: { code: "not_found" } },
      { addr: "k2/side", conversationId: "r", at: 1_700_000_300 },
    ],
  });

  it("candidates drop archived and open conversations, newest first", () => {
    expect(historyCandidates(chats, new Set(["live"])).map((c) => c.id)).toEqual(["a", "x", "r", "b"]);
  });

  it("merges a remembered sidecar with its chat, skips K2-less chats, sorts newest first", () => {
    const rows = buildHistory({
      chats,
      names: { "claude:a": "Named alpha" },
      remembered: [{ addr: "k2/side", chatTitle: "Side chat" }],
      latest,
      activeAddrs: new Set(["k2"]),
      activeConversations: new Set(["live"]),
    });
    expect(rows.map((r) => [r.addr, r.title, r.label, r.harness])).toEqual([
      ["a", "Named alpha", null, "claude"],
      ["k2/side", "k2/side", "Side chat", "cursor"],
      ["b", "beta", null, "codex"],
    ]);
    expect(rows[1].at).toBe(1_700_000_300);
  });

  it("an active addr or conversation never shows in History", () => {
    const rows = buildHistory({
      chats,
      remembered: [{ addr: "k2/side", chatTitle: "Side chat" }],
      latest,
      activeAddrs: new Set(["k2/side"]),
      activeConversations: new Set(["a", "r"]),
    });
    expect(rows.map((r) => r.addr)).toEqual(["b"]);
  });
});

describe("latestBatches", () => {
  it("splits into 50-addr batches without duplicates", () => {
    const addrs = Array.from({ length: 120 }, (_, i) => `c${i}`);
    const batches = latestBatches([...addrs, "c1", " "]);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
  });
});

describe("launchForHarness", () => {
  const llms = [
    { id: "p", name: "Codex", commandLine: "codex --yolo", command: "codex", args: ["--yolo"], harness: "codex", emoji: null },
  ] as ActiveLlm[];

  it("uses the enabled preset for that harness", () => {
    expect(launchForHarness("codex", llms)).toEqual({ command: "codex", args: ["--yolo"] });
  });

  it("falls back to the harness binary; Claude and unknown keep the default", () => {
    expect(launchForHarness("grok", llms)).toEqual({ command: "grok", args: [] });
    expect(launchForHarness("cursor", [])).toEqual({ command: "cursor-agent", args: [] });
    expect(launchForHarness("claude", llms)).toBeNull();
    expect(launchForHarness(null, llms)).toBeNull();
  });
});
