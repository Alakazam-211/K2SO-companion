import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetNetStatsForTests,
  frameKind,
  netSummary,
  noteBackground,
  noteForeground,
  noteFrame,
  noteRequest,
  noteSocketOpen,
  routeOf,
} from "./netStats";
import { returnLine, summaryLines } from "../zen/NetDiagnostics";

beforeEach(() => __resetNetStatsForTests());

describe("network counters", () => {
  it("groups routes with ids collapsed, per host", () => {
    expect(routeOf("/cli/thread/3f2a9c1e-77aa-4b1c-9e0f-001122334455/read")).toBe("/cli/thread/:id/read");
    noteRequest("https://z3thon.k2.dev/cli/thread/messages?after_seq=4", 1000);
    noteRequest("https://z3thon.k2.dev/cli/thread/messages", 2000);
    noteRequest("https://other.k2.dev/boot-status", 2000);
    const s = netSummary("Z3THON.k2.dev", 3000)!;
    expect(s.total).toBe(2);
    expect(s.topRoutes).toEqual([{ route: "/cli/thread/messages", count: 2 }]);
  });

  it("counts what a return to the app costs in its first 10 s", () => {
    noteBackground(0);
    noteForeground(42_000);
    noteRequest("https://a.k2.dev/boot-status", 42_100);
    noteRequest("https://a.k2.dev/cli/thread/messages", 42_200);
    noteRequest("https://a.k2.dev/cli/thread/messages", 43_000);
    noteSocketOpen("hub", "wss://a.k2.dev/cli/sessions/events", 42_300);
    noteRequest("https://a.k2.dev/cli/pins", 60_000); // after the window
    const r = netSummary("a.k2.dev", 61_000)!.returns[0];
    expect(r).toMatchObject({ awayMs: 42_000, requests: 3, opens: 1 });
    expect(returnLine(r)).toBe("3 requests, 1 socket after 42 s away (thread/messages ×2, /boot-status ×1)");
  });

  it("reads frame kinds cheaply and counts them per socket kind", () => {
    expect(frameKind('{"kind":"activity_changed","row":{}}')).toBe("activity_changed");
    expect(frameKind('{"t":"thread_message"}')).toBe("thread_message");
    expect(frameKind(new ArrayBuffer(2))).toBe("binary");
    noteFrame("hub", "wss://a.k2.dev/x", '{"kind":"activity_changed"}', 1000);
    noteFrame("hub", "wss://a.k2.dev/x", '{"kind":"activity_changed"}', 2000);
    const s = netSummary("a.k2.dev", 3000)!;
    expect(s.topFrames).toEqual([{ kind: "hub:activity_changed", count: 2 }]);
    expect(summaryLines(s)[1]).toContain("frames/min");
  });
});
