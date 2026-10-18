// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const getChatList = vi.fn();
vi.mock("../api/client", () => ({ getChatList: (...a: unknown[]) => getChatList(...a) }));

import { resetThreadHarness, useThreadHarness } from "./threadHarness";
import type { ServerScope } from "../api/scope";

const scope = { id: "srv" } as unknown as ServerScope;

describe("useThreadHarness", () => {
  beforeEach(() => {
    localStorage.clear();
    resetThreadHarness();
    getChatList.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("names the provider of the Thread's own conversation, read once per workspace", async () => {
    getChatList.mockResolvedValue({
      ok: true,
      data: [
        { sessionId: "c-claude", provider: "claude" },
        { sessionId: "c-grok", provider: "grok" },
      ],
    });
    const a = renderHook(() => useThreadHarness(scope, "/w", "c-grok"));
    await waitFor(() => expect(a.result.current).toBe("grok"));
    const b = renderHook(() => useThreadHarness(scope, "/w", "c-claude"));
    await waitFor(() => expect(b.result.current).toBe("claude"));
    expect(getChatList).toHaveBeenCalledTimes(1);
  });

  it("is null without a conversation or when the read fails; remembers what it found", async () => {
    expect(renderHook(() => useThreadHarness(scope, "/w", null)).result.current).toBeNull();
    getChatList.mockResolvedValueOnce({ ok: true, data: [{ sessionId: "c1", provider: "codex" }] });
    const a = renderHook(() => useThreadHarness(scope, "/w", "c1"));
    await waitFor(() => expect(a.result.current).toBe("codex"));
    resetThreadHarness();
    getChatList.mockResolvedValueOnce({ ok: false, error: "down" });
    // Offline later: the remembered provider for that conversation.
    const b = renderHook(() => useThreadHarness(scope, "/w", "c1"));
    expect(b.result.current).toBe("codex");
  });

  it("switching to a session the last read did not list re-reads, and shows that session's LLM", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getChatList.mockResolvedValueOnce({ ok: true, data: [{ sessionId: "c-claude", provider: "claude" }] });
    const h = renderHook(({ conv }) => useThreadHarness(scope, "/w", conv), {
      initialProps: { conv: "c-claude" },
    });
    await waitFor(() => expect(h.result.current).toBe("claude"));
    vi.advanceTimersByTime(11_000);
    getChatList.mockResolvedValueOnce({
      ok: true,
      data: [
        { sessionId: "c-claude", provider: "claude" },
        { sessionId: "c-grok", provider: "grok" },
      ],
    });
    h.rerender({ conv: "c-grok" });
    await waitFor(() => expect(h.result.current).toBe("grok"));
    expect(getChatList).toHaveBeenCalledTimes(2);
  });
});
