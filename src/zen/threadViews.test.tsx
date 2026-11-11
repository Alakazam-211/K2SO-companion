// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../api/scopedFetch", () => ({ scopedFetch: fetchMock }));

import type { ServerScope } from "../api/scope";
import { ChatterPane, HeartbeatsPane } from "./ThreadViewPanes";
import { ThreadViewSwitch } from "./ThreadViewSwitch";
import { chatterFromSnapshot, chatterLine, heartbeatRows } from "./threadViews";

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

  it("the switch: four views, Thread checked, Terminal always acts", () => {
    const onView = vi.fn();
    render(<ThreadViewSwitch view="thread" onView={onView} />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual([
      "Terminal",
      "Thread",
      "Chatter",
      "Heartbeats",
    ]);
    // Every segment white, as the header buttons are (not dimmed when unselected).
    for (const r of screen.getAllByRole("radio")) expect(r.style.color).toBe("rgb(255, 255, 255)");
    fireEvent.click(screen.getByRole("radio", { name: "Thread" }));
    expect(onView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Chatter" }));
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(onView.mock.calls).toEqual([["chatter"], ["terminal"]]);
  });

  it("Chatter reads the agent's handle; Heartbeats its workspace", async () => {
    fetchMock.mockResolvedValue(
      ok({ items: [{ id: "a", seq: 1, collection: "chatter", doc: { from: "sew", to: "k2", body: "hello k2" } }] })
    );
    render(<ChatterPane scope={scope} addr="k2-companion" topInset={0} />);
    expect((await screen.findAllByTestId("chatter-row"))[0].textContent).toContain("hello k2");
    expect(fetchMock).toHaveBeenCalledWith(scope, "/cli/chatter", expect.objectContaining({ query: { addr: "k2-companion", limit: "50" } }));
    cleanup();
    fetchMock.mockReset().mockResolvedValue(ok([]));
    render(<HeartbeatsPane scope={scope} project="/Users/z/k2" topInset={0} />);
    expect(await screen.findByTestId("heartbeats-pane-empty")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      scope,
      "/cli/heartbeat/fires-list",
      expect.objectContaining({ query: { project: "/Users/z/k2", limit: "50" } })
    );
  });

  it("says so when the server can't answer", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: "" });
    render(<HeartbeatsPane scope={scope} project="/w" topInset={0} />);
    await waitFor(() => expect(screen.getByTestId("heartbeats-pane-error").textContent).toMatch(/Couldn't load it \(403\)/));
  });
});
