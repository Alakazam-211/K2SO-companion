// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.fn();
const refresh = vi.fn();
vi.mock("../api/llmAccountFor", async (orig) => ({
  ...(await orig<typeof import("../api/llmAccountFor")>()),
  readAccountUsage: (...a: unknown[]) => read(...a),
  refreshAccountUsage: (...a: unknown[]) => refresh(...a),
}));
vi.mock("./ThreadFiles", () => ({ useThreadFilesOn: () => true }));
vi.mock("../lib/foreground", () => ({ onForegroundLater: () => () => {} }));

type Sub = { match: (f: unknown) => boolean; onChange: () => void; stop: ReturnType<typeof vi.fn> };
const subs: Sub[] = [];
vi.mock("./ticketEvents", () => ({
  subscribeAppEvents: (_s: unknown, match: Sub["match"], onChange: Sub["onChange"]) => {
    const stop = vi.fn();
    subs.push({ match, onChange, stop });
    return { stop };
  },
}));

import { useAgentUsage, useUsageAgeMinutes } from "./useAgentUsage";
import type { AccountUsage } from "../api/llmAccountFor";

const scope = { id: "s1" } as never;
const reading = (maxPercent: number): AccountUsage => ({
  tool: "claude",
  accountId: "a1",
  label: "Max",
  source: "default",
  maxPercent,
  updatedAt: 1000,
});
const frame = (extra: object) => ({ kind: "subscription_usage_changed", source: "probe", ...extra });

async function opened(addr = "agent") {
  read.mockResolvedValueOnce(reading(10));
  refresh.mockResolvedValueOnce(reading(11));
  const hook = renderHook(({ a }) => useAgentUsage(scope, a), { initialProps: { a: addr as string | null } });
  await waitFor(() => expect(hook.result.current?.maxPercent).toBe(11));
  read.mockClear();
  refresh.mockClear();
  return hook;
}

describe("useAgentUsage live changes", () => {
  beforeEach(() => {
    read.mockReset();
    refresh.mockReset();
    subs.length = 0;
  });

  it("ignores another token's event", async () => {
    await opened();
    expect(subs[0].match(frame({ tool: "claude", account_id: "other" }))).toBe(false);
    expect(subs[0].match(frame({ tool: "claude", account_id: "a1" }))).toBe(true);
    expect(subs[0].match({ kind: "projects_changed" })).toBe(false);
  });

  it("re-reads on a null account_id with the same tool, not another tool", async () => {
    await opened();
    expect(subs[0].match(frame({ tool: "claude", account_id: null }))).toBe(true);
    expect(subs[0].match(frame({ tool: "codex", account_id: null }))).toBe(false);
  });

  it("an event GETs and never POSTs the refresh", async () => {
    const hook = await opened();
    read.mockResolvedValueOnce(reading(42));
    await act(async () => subs[0].onChange());
    expect(read).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(hook.result.current?.maxPercent).toBe(42);
  });

  it("keeps the current value when the event's GET returns null", async () => {
    const hook = await opened();
    read.mockResolvedValueOnce(null);
    await act(async () => subs[0].onChange());
    expect(hook.result.current?.maxPercent).toBe(11);
  });

  it("ignores an answer that lands after a newer one", async () => {
    const hook = await opened();
    let older!: (u: AccountUsage) => void;
    read.mockReturnValueOnce(new Promise((r) => (older = r)));
    read.mockResolvedValueOnce(reading(50));
    await act(async () => {
      subs[0].onChange();
      subs[0].onChange();
    });
    expect(hook.result.current?.maxPercent).toBe(50);
    await act(async () => older(reading(20)));
    expect(hook.result.current?.maxPercent).toBe(50);
  });

  it("stops when the chat closes or the address changes", async () => {
    const hook = await opened();
    read.mockResolvedValue(reading(12));
    refresh.mockResolvedValue(reading(13));
    await act(async () => hook.rerender({ a: "other" }));
    expect(subs[0].stop).toHaveBeenCalledTimes(1);
    expect(subs).toHaveLength(2);
    await act(async () => hook.rerender({ a: null }));
    expect(subs[1].stop).toHaveBeenCalledTimes(1);
    expect(subs).toHaveLength(2);
  });
});

describe("useUsageAgeMinutes", () => {
  it("appears once the reading passes 20 minutes, checked each minute", () => {
    vi.useFakeTimers();
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const hook = renderHook(() => useUsageAgeMinutes(nowSec - 19 * 60));
      expect(hook.result.current).toBeNull();
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(hook.result.current).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });
});
