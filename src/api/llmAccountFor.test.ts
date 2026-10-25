import { describe, expect, it, vi } from "vitest";

const scoped = vi.fn();
vi.mock("./scopedFetch", () => ({ scopedFetch: (...a: unknown[]) => scoped(...a) }));

import { parseAccountUsage, readAccountUsage, refreshAccountUsage } from "./llmAccountFor";

const scope = { id: "s1" } as never;
const body = { tool: "claude", accountId: "a1", label: "Max", source: "pinned", windows: [], maxPercent: 42.4, updatedAt: 1761300000 };

describe("account usage for a chat (llm-account-for-v1)", () => {
  it("parses the desktop chip's percent, whole and clamped", () => {
    expect(parseAccountUsage(body)).toEqual({ tool: "claude", accountId: "a1", label: "Max", source: "pinned", maxPercent: 42, updatedAt: 1761300000 });
    expect(parseAccountUsage({ ...body, maxPercent: 140 })?.maxPercent).toBe(100);
    expect(parseAccountUsage({ ...body, maxPercent: null })).toBeNull();
    expect(parseAccountUsage(null)).toBeNull();
  });

  // K2's sample (m_HOsaW2gC1X): a sidecar on its workspace's token, a pin
  // changed while it ran.
  const k2Sample = {
    tool: "claude", accountId: "acct_9f2", label: "Second", kind: "subscription", source: "pinned", pinScope: "workspace",
    windows: [{ label: "Session", used: 0.73, usedPercent: 73.0, resetsAt: "2026-10-24T17:00:00Z", resetPassed: false, chip: true,
      id: "five_hour", kind: "session", windowSecs: 18000, windowStart: "2026-10-24T12:00:00+00:00" }],
    maxPercent: 73, updatedAt: "2026-10-24T11:00:00Z", state: "ok", usageFrom: "token", address: "forws/1", workspaceId: "w",
    sessionKey: "tab-side1", sidecar: true, conversationId: "conv-s1", live: true, airgap: false,
    nextStart: { accountId: "acct_key", source: "pinned" },
  };

  it("reads K2's sample; hides a chat that isn't an LLM session or has no reading", () => {
    expect(parseAccountUsage(k2Sample)).toEqual({
      tool: "claude", accountId: "acct_9f2", label: "Second", source: "pinned", maxPercent: 73, updatedAt: Date.parse("2026-10-24T11:00:00Z") / 1000,
    });
    expect(parseAccountUsage({ ...k2Sample, tool: null, maxPercent: null, windows: [] })).toBeNull();
    expect(parseAccountUsage({ ...k2Sample, windows: [], maxPercent: null })).toBeNull();
  });

  it("the cached read is a GET with the chat's own addr; the refresh a POST with the same addr", async () => {
    scoped.mockReset();
    scoped.mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify(k2Sample) });
    expect((await readAccountUsage(scope, "forws/1"))?.maxPercent).toBe(73);
    expect(scoped.mock.calls[0][1]).toBe("/cli/llm/accounts/for");
    expect(scoped.mock.calls[0][2]).toMatchObject({ query: { addr: "forws/1" } });

    scoped.mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify({ ...k2Sample, maxPercent: 80, refreshed: false, reason: "rate_limited", retryAfterSecs: 40 }) });
    expect((await refreshAccountUsage(scope, "forws/1"))?.maxPercent).toBe(80);
    expect(scoped.mock.calls[1][1]).toBe("/cli/llm/accounts/for/refresh");
    expect(scoped.mock.calls[1][2].method).toBe("POST");
    expect(JSON.parse(scoped.mock.calls[1][2].body)).toEqual({ addr: "forws/1" });
  });

  it("any failure: nothing", async () => {
    scoped.mockReset();
    scoped.mockResolvedValueOnce({ ok: false, status: 404, text: "{}" });
    expect(await readAccountUsage(scope, "nope")).toBeNull();
    scoped.mockResolvedValueOnce({ ok: false, status: 403, text: '{"error":"owner_only"}' });
    expect(await refreshAccountUsage(scope, "billing")).toBeNull();
    scoped.mockRejectedValueOnce(new Error("offline"));
    expect(await readAccountUsage(scope, "billing")).toBeNull();
  });
});

import { usageColor } from "../zen/useAgentUsage";

describe("usage colour", () => {
  it("white below 75, yellow 75–89, red from 90", () => {
    expect(usageColor(74)).toBe("rgba(255, 255, 255, 0.9)");
    expect(usageColor(75)).toBe("#ffd60a");
    expect(usageColor(89)).toBe("#ffd60a");
    expect(usageColor(90)).toBe("#ff6961");
  });
});
