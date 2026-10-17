import { describe, expect, it } from "vitest";
import {
  API_TOKEN_REASON,
  NEEDS_SIGN_IN_REASON,
  PINNED_REASON,
  SIGNING_IN_REASON,
  canSwitchTo,
  checkedAgoText,
  exhaustedWindows,
  failureKind,
  formatResetsIn,
  parseLlmTokensDoc,
  parseTokenUsage,
  percentUsed,
  pinnedToText,
  splitTool,
  switchBlockReason,
  tokenName,
  usageCheckedAtSecs,
  visibleTools,
} from "./llmTokensPure";
import { listBody, NOW_MS } from "../test/llmTokensFixture";

describe("parseLlmTokensDoc", () => {
  it("parses the daemon's list body: tools in desktop order, tokens, usage, note", () => {
    const doc = parseLlmTokensDoc(listBody());
    expect(doc.tools.map((t) => t.tool)).toEqual(["claude", "codex", "grok", "cursor"]);
    expect(doc.switchNote).toMatch(/server default token/);
    expect(doc.airgap).toBe(false);
    const claude = doc.tools[0];
    expect(claude.activeId).toBe("acc_work");
    expect(claude.switchedAt).toBe(1_760_000_000);
    expect(claude.accounts.map((a) => a.id)).toEqual(["acc_work", "acc_home", "acc_team", "acc_key"]);
    const work = claude.accounts[0];
    expect(work.active).toBe(true);
    expect(work.email).toBe("rosson@example.test");
    expect(work.usage?.windows).toEqual([
      { label: "Session", used: 0.42, resetsAt: "2026-10-17T15:00:00.000Z" },
      { label: "Weekly", used: 0.1, resetsAt: "" },
    ]);
    expect(claude.accounts[1].usage?.error).toBe("HTTP 429");
    expect(claude.accounts[2].pinnedTo).toEqual([{ scopeKind: "workspace", label: "K2" }]);
    expect(claude.accounts[3].kind).toBe("api_key");
  });

  it("tolerates junk: error envelopes, null, strings, bad rows and windows", () => {
    for (const raw of [null, undefined, "nope", 42, [], { error: { code: "x" } }, { tools: "x" }]) {
      expect(parseLlmTokensDoc(raw)).toEqual({ tools: [], signingInIds: [], airgap: false, switchNote: "" });
    }
    const doc = parseLlmTokensDoc({
      tools: [
        null,
        { tool: "" },
        {
          tool: "claude",
          supported: true,
          activeId: "a",
          accounts: [
            { id: "a", state: "signed_in", active: false, usage: { windows: [{ label: "S", used: "x" }, { label: "W", used: 0.5 }] } },
            { label: "no id" },
            "str",
          ],
        },
      ],
      logins: [{ accountId: "a", done: false }, { accountId: "b", done: true }, null],
    });
    expect(doc.tools).toHaveLength(1);
    const [a] = doc.tools[0].accounts;
    // activeId wins over the row flag.
    expect(a.active).toBe(true);
    expect(a.kind).toBe("subscription");
    expect(a.usage?.windows).toEqual([{ label: "W", used: 0.5, resetsAt: "" }]);
    expect(doc.tools[0].display).toBe("claude");
    expect(doc.tools[0].subscription).toBe(true);
    expect(doc.signingInIds).toEqual(["a"]);
  });

  it("no activeId: the row flag names the default", () => {
    const doc = parseLlmTokensDoc({
      tools: [{ tool: "codex", supported: true, accounts: [{ id: "x", active: true }, { id: "y" }] }],
    });
    expect(doc.tools[0].activeId).toBe("x");
  });

  it("parseTokenUsage: null when not an object", () => {
    expect(parseTokenUsage(null)).toBeNull();
    expect(parseTokenUsage("x")).toBeNull();
    expect(parseTokenUsage({ status: "Not signed in" })).toEqual({
      harness: "",
      plan: "",
      windows: [],
      checkedAt: "",
      status: "Not signed in",
    });
  });
});

describe("what the page shows", () => {
  const doc = parseLlmTokensDoc(listBody());
  const claude = doc.tools[0];
  const byId = (id: string) => doc.tools.flatMap((t) => t.accounts).find((a) => a.id === id)!;

  it("visible tools: supported with at least one token", () => {
    expect(visibleTools(doc).map((t) => t.tool)).toEqual(["claude", "codex"]);
    expect(visibleTools(null)).toEqual([]);
  });

  it("splitTool: the server default first, the rest in order", () => {
    const { active, others } = splitTool(claude);
    expect(active?.id).toBe("acc_work");
    expect(others.map((a) => a.id)).toEqual(["acc_home", "acc_team", "acc_key"]);
    expect(splitTool(doc.tools[1]).active).toBeNull();
  });

  it("tokenName mirrors desktop", () => {
    expect(tokenName("Claude", byId("acc_work"))).toBe("Claude · Max · work");
    expect(tokenName("Claude", byId("acc_key"))).toBe("API token · metered · billed per token");
    expect(tokenName("Codex", byId("acc_cx"))).toBe("Codex · Default");
  });

  it("switch rules: only a signed-in, free subscription that isn't the default", () => {
    expect(canSwitchTo(doc, byId("acc_home"))).toBe(true);
    expect(switchBlockReason(doc, byId("acc_home"))).toBeNull();
    expect(canSwitchTo(doc, byId("acc_work"))).toBe(false);
    expect(switchBlockReason(doc, byId("acc_work"))).toBeNull();
    expect(switchBlockReason(doc, byId("acc_team"))).toBe(PINNED_REASON);
    expect(switchBlockReason(doc, byId("acc_key"))).toBe(API_TOKEN_REASON);
    expect(switchBlockReason(doc, byId("acc_cx"))).toBe(NEEDS_SIGN_IN_REASON);
    const signing = { ...doc, signingInIds: ["acc_home"] };
    expect(switchBlockReason(signing, byId("acc_home"))).toBe(SIGNING_IN_REASON);
  });

  it("pinnedToText", () => {
    expect(pinnedToText(byId("acc_team"))).toBe("K2");
    expect(pinnedToText({ pinnedTo: [{ scopeKind: "session", label: "a1b2" }] })).toBe("chat a1b2");
  });
});

describe("usage text", () => {
  it("percentUsed clamps and rounds", () => {
    expect(percentUsed(0.424)).toBe(42);
    expect(percentUsed(1.3)).toBe(100);
    expect(percentUsed(-1)).toBe(0);
  });

  it("formatResetsIn: m / h / d, now once past, empty when unknown", () => {
    expect(formatResetsIn("", NOW_MS)).toBe("");
    expect(formatResetsIn("garbage", NOW_MS)).toBe("");
    expect(formatResetsIn(new Date(NOW_MS - 1).toISOString(), NOW_MS)).toBe("now");
    expect(formatResetsIn(new Date(NOW_MS + 45 * 60_000).toISOString(), NOW_MS)).toBe("45m");
    expect(formatResetsIn(new Date(NOW_MS + 3 * 3_600_000).toISOString(), NOW_MS)).toBe("3h");
    expect(formatResetsIn(new Date(NOW_MS + 4 * 86_400_000).toISOString(), NOW_MS)).toBe("4d");
  });

  it("checked-ago text and its source", () => {
    expect(checkedAgoText(null, NOW_MS)).toBe("never checked");
    expect(checkedAgoText(NOW_MS / 1000 - 10, NOW_MS)).toBe("checked just now");
    expect(checkedAgoText(NOW_MS / 1000 - 600, NOW_MS)).toBe("checked 10 min ago");
    expect(checkedAgoText(NOW_MS / 1000 - 3 * 3600, NOW_MS)).toBe("checked 3 h ago");
    expect(checkedAgoText(NOW_MS / 1000 - 2 * 86400, NOW_MS)).toBe("checked 2 d ago");
    expect(usageCheckedAtSecs({ usageCheckedAt: 5, usage: null })).toBe(5);
    expect(
      usageCheckedAtSecs({
        usageCheckedAt: null,
        usage: { harness: "", plan: "", windows: [], checkedAt: "2026-10-17T12:00:00Z", status: "" },
      })
    ).toBe(NOW_MS / 1000);
    expect(usageCheckedAtSecs({ usageCheckedAt: null, usage: null })).toBeNull();
  });

  it("exhaustedWindows: used up and not reset yet", () => {
    const home = parseLlmTokensDoc(listBody()).tools[0].accounts[1];
    expect(exhaustedWindows(home, NOW_MS)).toEqual(["Session is used up (resets in 45m)"]);
    expect(exhaustedWindows(home, NOW_MS + 3_600_000)).toEqual([]);
  });
});

describe("failureKind", () => {
  it("404 / route_unclassified → unsupported; 403 → forbidden; else error", () => {
    expect(failureKind(404, "route_unclassified")).toBe("unsupported");
    expect(failureKind(undefined, "route not found")).toBe("unsupported");
    expect(failureKind(403, "role_required")).toBe("forbidden");
    expect(failureKind(403, "owner_only")).toBe("forbidden");
    expect(failureKind(409, "this token is signing in")).toBe("error");
    expect(failureKind(undefined, "Could not reach server")).toBe("error");
  });
});
