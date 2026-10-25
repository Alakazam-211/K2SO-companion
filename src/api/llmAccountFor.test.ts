import { describe, expect, it, vi } from "vitest";

const scoped = vi.fn();
vi.mock("./scopedFetch", () => ({ scopedFetch: (...a: unknown[]) => scoped(...a) }));

import { fetchAccountUsage, parseAccountUsage } from "./llmAccountFor";

const scope = { id: "s1" } as never;
const body = { tool: "claude", accountId: "a1", label: "Max", source: "pinned", windows: [], maxPercent: 42.4, updatedAt: 1761300000 };

describe("account usage for a chat (llm-account-for-v1)", () => {
  it("parses the desktop chip's percent, whole and clamped", () => {
    expect(parseAccountUsage(body)).toEqual({ tool: "claude", accountId: "a1", label: "Max", source: "pinned", maxPercent: 42, updatedAt: 1761300000 });
    expect(parseAccountUsage({ ...body, maxPercent: 140 })?.maxPercent).toBe(100);
    expect(parseAccountUsage({ ...body, maxPercent: null })).toBeNull();
    expect(parseAccountUsage(null)).toBeNull();
  });

  it("nudges a refresh for the chat's own addr; falls back to the plain read where the nudge is missing", async () => {
    scoped.mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify({ ...body, refreshed: false }) });
    expect((await fetchAccountUsage(scope, "billing/2"))?.maxPercent).toBe(42);
    expect(scoped.mock.calls[0][1]).toBe("/cli/llm/accounts/for/refresh");
    expect(JSON.parse(scoped.mock.calls[0][2].body)).toEqual({ addr: "billing/2" });

    scoped.mockReset();
    scoped
      .mockResolvedValueOnce({ ok: false, status: 404, text: "" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: JSON.stringify(body) });
    expect((await fetchAccountUsage(scope, "billing"))?.label).toBe("Max");
    expect(scoped.mock.calls[1][2]).toMatchObject({ query: { addr: "billing" } });
  });

  it("any other failure: nothing shown", async () => {
    scoped.mockReset();
    scoped.mockResolvedValueOnce({ ok: false, status: 403, text: "{}" });
    expect(await fetchAccountUsage(scope, "billing")).toBeNull();
    scoped.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchAccountUsage(scope, "billing")).toBeNull();
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
