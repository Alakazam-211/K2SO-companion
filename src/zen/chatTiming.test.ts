import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TIMING_RING_MAX,
  approxBytes,
  beginChatOpen,
  chatOpenTimings,
  noteCachedPaint,
  notePaintAfterResponse,
  noteResponse,
  resetChatTimings,
} from "./chatTiming";
import { timingLine } from "./ChatTimingDiagnostics";

beforeEach(() => resetChatTimings());

describe("chat open timing", () => {
  it("records cached paint, server answer and the paint after it", async () => {
    const id = beginChatOpen("s1", "s1|t:appa", "thread");
    noteCachedPaint(id, "memory", 12);
    noteResponse(id, { ok: true, items: 50, bytes: 2048 });
    notePaintAfterResponse(id);
    await new Promise((r) => setTimeout(r, 5));
    const [t] = chatOpenTimings("s1");
    expect(t.room).toBe("t:appa");
    expect(t.cachedFrom).toBe("memory");
    expect(t.cachedCount).toBe(12);
    expect(t.cachedMs).not.toBeNull();
    expect(t.responseMs).not.toBeNull();
    expect(t.paintMs).not.toBeNull();
    expect(t.items).toBe(50);
    expect(t.bytes).toBe(2048);
    expect(timingLine(t)).toMatch(/cache .* \(memory, 12\) · server .* · 50 items · 2\.0 KB/);
  });

  it("a resumed open hands over to the chat's own read (one record)", () => {
    const a = beginChatOpen("s1", "s1|t:x", "thread");
    const b = beginChatOpen("s1", "s1|t:x", "thread");
    expect(b).toBe(a);
    noteResponse(a, { ok: false, error: "HTTP 500" });
    const c = beginChatOpen("s1", "s1|t:x", "thread");
    expect(c).not.toBe(a);
    expect(timingLine(chatOpenTimings()[1])).toMatch(/no cache · failed/);
  });

  it("is a bounded ring, filtered per server", () => {
    for (let i = 0; i < TIMING_RING_MAX + 10; i++) beginChatOpen(i % 2 ? "s1" : "s2", `s|t:${i}`, "thread");
    expect(chatOpenTimings()).toHaveLength(TIMING_RING_MAX);
    expect(chatOpenTimings("s1").every((t) => t.serverId === "s1")).toBe(true);
  });

  it("logs to console.debug in dev builds only", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const id = beginChatOpen("s1", "s1|t:y", "thread");
    noteCachedPaint(id, "device", 3);
    expect(spy).toHaveBeenCalledTimes(import.meta.env.DEV ? 1 : 0);
    spy.mockRestore();
  });

  it("approxBytes is the JSON length", () => {
    expect(approxBytes({ a: 1 })).toBe(7);
  });
});
