// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../api/scopedFetch", () => ({ scopedFetch: fetchMock }));

import type { ServerScope } from "../api/scope";
import { ChatterPane } from "./ThreadViewPanes";
import { ThreadViewSwitch } from "./ThreadViewSwitch";
import { blendChatter, chatterFromSnapshot, chatterLine, heartbeatRows } from "./threadViews";

const scope = { id: "s1" } as unknown as ServerScope;
const ok = (body: unknown) => ({ ok: true, status: 200, text: JSON.stringify(body) });

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe("Chatter and Heartbeats (K2 Projects' tile views, ported)", () => {
  it("reads the Chatter collection only, oldest first", () => {
    const snap = chatterFromSnapshot({
      ok: true,
      collection: "chatter",
      items: [
        { id: "b", seq: 2, collection: "chatter", doc: { from: "k2", to: "sew", body: "second", created_at: 20 } },
        { id: "t", seq: 3, collection: "thread", doc: { from: "rosson", body: "a Thread post" } },
        { id: "a", seq: 1, doc: { from: "sew", to: "k2", body: "\n first line\nmore", summary: "", created_at: 10 } },
      ],
      has_more: true,
    });
    expect(snap.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(snap.hasMore).toBe(true);
    expect(chatterLine(snap.items[0])).toBe("first line");
    expect(chatterLine({ summary: "", body: "" })).toBe("(no text)");
    expect(chatterLine({ summary: "x".repeat(200), body: "" })).toHaveLength(140);
  });

  it("reads heartbeat fires (a bare array, newest first) as rows oldest first, edits left out", () => {
    const rows = heartbeatRows([
      { id: 3, agentName: "k2", scheduleName: "hourly", firedAt: "2026-11-11 10:00:00", decision: "fired" },
      { id: 2, scheduleName: "hourly", firedAt: "2026-11-11 09:00:00", decision: "changed" },
      { id: 1, agentName: "k2", firedAt: "2026-11-11T08:00:00Z", decision: "skipped_busy", reason: "a turn was running" },
    ]);
    expect(rows.map((r) => [r.id, r.source, r.status, r.tone, r.detail])).toEqual([
      ["1", "k2", "Skipped", "muted", "a turn was running"],
      ["3", "k2 / hourly", "Ran", "ok", null],
    ]);
  });

  it("blends heartbeats into Chatter by time, Chatter's own order kept", () => {
    const T = 1_800_000_000; // seconds
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    const chatter = chatterFromSnapshot({
      items: [
        { id: "a", seq: 1, doc: { from: "sew", body: "one", created_at: T + 100 } },
        { id: "b", seq: 2, doc: { from: "k2", body: "two (no time)" } },
        { id: "c", seq: 3, doc: { from: "sew", body: "three", created_at: (T + 300) * 1000 } }, // ms
      ],
    }).items;
    const beats = heartbeatRows([
      { id: 9, scheduleName: "late", firedAt: iso(T + 600), decision: "fired" },
      { id: 8, scheduleName: "early", firedAt: iso(T + 50), decision: "fired" },
      { id: 7, scheduleName: "mid", firedAt: iso(T + 180), decision: "fired" },
    ]);
    expect(blendChatter(chatter, beats).map((r) => r.key)).toEqual(["h:8", "c:a", "c:b", "h:7", "c:c", "h:9"]);
    expect(blendChatter([], [])).toEqual([]);
  });

  it("the switch: Terminal, Thread, Chatter (Heartbeats lives in Chatter), Thread checked, Terminal always acts", () => {
    const onView = vi.fn();
    render(<ThreadViewSwitch view="thread" onView={onView} />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Terminal", "Thread", "Chatter"]);
    // Every segment white, as the header buttons are (not dimmed when unselected).
    for (const r of screen.getAllByRole("radio")) expect(r.style.color).toBe("rgb(255, 255, 255)");
    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    expect(onView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Chatter" }));
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(onView.mock.calls).toEqual([["chatter"], ["terminal"]]);
  });

  it("Chatter reads the agent's handle and its workspace's heartbeats, in one list", async () => {
    fetchMock.mockImplementation(async (_scope: unknown, path: string) =>
      path === "/cli/chatter"
        ? ok({ items: [{ id: "a", seq: 1, collection: "chatter", doc: { from: "sew", to: "k2", body: "hello k2", created_at: 2_000_000_000 } }] })
        : ok([{ id: 1, agentName: "k2", scheduleName: "hourly", firedAt: "2026-01-01 00:00:00", decision: "fired" }])
    );
    render(<ChatterPane scope={scope} addr="k2-companion" project="/Users/z/k2" topInset={0} />);
    await waitFor(() => expect(screen.getAllByTestId(/^(chatter|heartbeat)-row$/)).toHaveLength(2));
    const order = screen.getAllByTestId(/^(chatter|heartbeat)-row$/).map((r) => r.dataset.testid);
    expect(order).toEqual(["heartbeat-row", "chatter-row"]);
    expect(screen.getByTestId("heartbeat-row").textContent).toContain("Heartbeat · k2 / hourly");
    expect(fetchMock).toHaveBeenCalledWith(scope, "/cli/chatter", expect.objectContaining({ query: { addr: "k2-companion", limit: "50" } }));
    expect(fetchMock).toHaveBeenCalledWith(
      scope,
      "/cli/heartbeat/fires-list",
      expect.objectContaining({ query: { project: "/Users/z/k2", limit: "50" } })
    );
  });

  it("heartbeats still show when Chatter can't load, and says so when neither can", async () => {
    fetchMock.mockImplementation(async (_scope: unknown, path: string) =>
      path === "/cli/chatter"
        ? { ok: false, status: 403, text: "" }
        : ok([{ id: 1, scheduleName: "hourly", firedAt: "2026-01-01 00:00:00", decision: "no_work" }])
    );
    render(<ChatterPane scope={scope} addr="k2" project="/w" topInset={0} />);
    expect((await screen.findByTestId("heartbeat-row")).textContent).toContain("Nothing to do");
    cleanup();
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 403, text: "" });
    render(<ChatterPane scope={scope} addr="k2" project="/w" topInset={0} />);
    await waitFor(() => expect(screen.getByTestId("chatter-pane-error").textContent).toMatch(/Couldn't load it \(403\)/));
  });
});
