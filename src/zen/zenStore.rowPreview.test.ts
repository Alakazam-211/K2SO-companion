// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";

vi.mock("../api/client", async (orig) => {
  const real = await orig<typeof import("../api/client")>();
  return {
    FEATURE_THREAD_LATEST: real.FEATURE_THREAD_LATEST,
    THREAD_LATEST_MAX_ADDRS: real.THREAD_LATEST_MAX_ADDRS,
    getActivitySnapshot: vi.fn(async () => ({ ok: false, error: "route not found", status: 404 })),
    getThread: vi.fn(),
    getThreadLatest: vi.fn(),
    serverHasFeature: vi.fn(),
    getToken: vi.fn(() => "tok"),
    // Session-waking calls: a snippet read must never reach these.
    ensurePinnedChat: vi.fn(),
    spawnTerminal: vi.fn(),
    spawnBackgroundTerminal: vi.fn(),
    spawnSidecarSession: vi.fn(),
    spawnTabSession: vi.fn(),
    spawnResumeTab: vi.fn(),
    getThreadActivity: vi.fn(),
    postThread: vi.fn(),
  };
});

// Multi-server (MA6): Zen's server is the real active server s1; every
// snippet key is `s1|t:<addr>`.

vi.mock("./overlayEvents", () => ({ connectOverlayEvents: vi.fn() }));

import * as client from "../api/client";
import { useServersStore } from "../stores/servers";
import { __resetScopesForTests, noteBootStatus, scopeFor } from "../api/scope";
import { connectOverlayEvents } from "./overlayEvents";
import { fetchThreadLasts, resetLastAtQueue, rowLastFromLatest } from "./lastAtFetch";
import { lastPreview, type RowLast } from "./rowPreview";
import {
  ROW_PREVIEW_CACHE_CAP,
  ROW_PREVIEW_CACHE_KEY,
  readRowPreviews,
  resetRowPreviewMemo,
  writeRowPreviews,
} from "./rowPreviewCache";
import { RowSnippet } from "./RowSnippet";
import { resetThreadPreviewQueue, useZenStore } from "./zenStore";

const latest = (addr: string, extra: Record<string, unknown> = {}) => ({
  addr,
  conversationId: `c-${addr}`,
  seq: 5,
  at: 1_760_000_000,
  from: addr,
  via: "thread",
  kind: "text",
  preview: `hello from ${addr}`,
  ...extra,
});

const S1 = scopeFor("s1");

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  resetRowPreviewMemo();
  resetThreadPreviewQueue();
  resetLastAtQueue();
  __resetScopesForTests();
  useServersStore.setState({
    hydrated: true,
    servers: [{ id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "tok" },
  });
  useZenStore.setState({ agentSource: "live", previewByKey: {}, lastAtByKey: {}, agents: [] });
});

describe("rowLastFromLatest", () => {
  it("compose is You; a choice drops the server's Asked:; a secret keeps no text", () => {
    expect(rowLastFromLatest(latest("appa", { from: "owner", via: "compose" }), "baden")?.mine).toBe(true);
    expect(rowLastFromLatest(latest("appa"), "baden")?.mine).toBe(false);
    expect(
      rowLastFromLatest(latest("appa", { kind: "choice", preview: "Asked: Ship it?" }), "baden")?.text
    ).toBe("Ship it?");
    const secret = rowLastFromLatest(
      latest("appa", { kind: "secret", preview: "Asked for a secret" }),
      "baden"
    );
    expect(secret?.text).toBe("");
    expect(lastPreview(secret)).toEqual({ kind: "snippet", mine: false, nodes: ["Asked for a secret"] });
  });

  it("an empty Thread is null (No messages yet)", () => {
    expect(
      rowLastFromLatest(latest("appa", { seq: null, at: null, from: null, kind: null, preview: null }), "baden")
    ).toBeNull();
  });
});

describe("fetchThreadLasts", () => {
  it("one batched thread/latest call for several rows; time and snippet from the same item", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockResolvedValue({
      ok: true,
      data: { ok: true, items: [latest("appa"), latest("quiet", { at: 1_760_000_100 }), latest("gone", { error: { code: "not_found" } })] },
    });
    const { via, lasts } = await fetchThreadLasts(S1, ["appa", "quiet", "gone"], "baden");
    expect(via).toBe("latest");
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
    expect(client.getThreadLatest).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), ["appa", "quiet", "gone"]);
    expect(client.getThread).not.toHaveBeenCalled();
    expect(lasts.get("quiet")).toMatchObject({ at: 1_760_000_100, seq: 5, text: "hello from quiet", flat: true });
    expect(lasts.get("gone")).toBeNull();
  });

  it("splits past the daemon's 50-addr cap", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockImplementation(async (_scope, addrs: string[]) => ({
      ok: true,
      data: { items: addrs.map((a) => latest(a)) },
    }));
    const addrs = Array.from({ length: 61 }, (_, i) => `a${i}`);
    const { lasts } = await fetchThreadLasts(S1, addrs, "baden");
    expect(client.getThreadLatest).toHaveBeenCalledTimes(2);
    expect(lasts.size).toBe(61);
  });

  it("no thread-latest feature: falls back to thread?limit=1 per row", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(false);
    vi.mocked(client.getThread).mockImplementation(async (_scope, addr: string) => ({
      ok: true,
      data: {
        items: [{ seq: 9, doc: { seq: 9, from: "owner", body: `**hi** ${addr}`, created_at: 77, via: "compose" } }],
      },
    }));
    const { via, lasts } = await fetchThreadLasts(S1, ["appa", "quiet"], "baden");
    expect(via).toBe("per-row");
    expect(client.getThreadLatest).not.toHaveBeenCalled();
    expect(client.getThread).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "appa", 1);
    expect(client.getThread).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "quiet", 1);
    expect(lasts.get("appa")).toMatchObject({ at: 77, seq: 9, mine: true, text: "**hi** appa" });
    expect(lasts.get("appa")?.flat).toBeUndefined();
  });

  it("a failed batch falls back per row instead of blanking the list", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockResolvedValue({ ok: false, error: "HTTP 502", status: 502 });
    vi.mocked(client.getThread).mockResolvedValue({ ok: true, data: { items: [] } });
    const { lasts } = await fetchThreadLasts(S1, ["appa"], "baden");
    expect(client.getThread).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "appa", 1);
    expect(lasts.get("appa")).toBeNull();
  });
});

describe("store: row snippets", () => {
  it("rows observed in one tick share one thread/latest call", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockImplementation(async (_scope, addrs: string[]) => ({
      ok: true,
      data: { items: addrs.map((a) => latest(a)) },
    }));
    const z = useZenStore.getState();
    z.ensureLastAt("s1|t:appa");
    z.ensureLastAt("s1|t:quiet");
    z.ensureLastAt("s1|t:sales");
    await vi.waitFor(() => expect(useZenStore.getState().previewByKey["s1|t:sales"]).toBeTruthy());
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.getThreadLatest).mock.calls[0][1]).toEqual(["appa", "quiet", "sales"]);
    expect(useZenStore.getState().lastAtByKey["s1|t:quiet"]).toBe(1_760_000_000);
    // Visible again within 30 s: no new read.
    useZenStore.getState().ensureLastAt("s1|t:appa");
    await flush();
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
  });

  it("cached snippets show before the fetch resolves, then only moved rows update", async () => {
    const cached: RowLast = { at: 100, seq: 5, mine: false, kind: "text", text: "from cache" };
    writeRowPreviews("dtl.k2.dev", { appa: cached, quiet: { ...cached, text: "quiet cache" } });
    resetRowPreviewMemo(); // a cold launch reads localStorage
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    let answer!: (v: unknown) => void;
    vi.mocked(client.getThreadLatest).mockReturnValue(new Promise((r) => (answer = r)) as never);

    useZenStore.getState().ensureLastAt("s1|t:appa");
    useZenStore.getState().ensureLastAt("s1|t:quiet");
    // Synchronously, before any answer.
    expect(useZenStore.getState().previewByKey["s1|t:appa"]).toMatchObject({ text: "from cache" });
    expect(useZenStore.getState().lastAtByKey["s1|t:appa"]).toBe(100);
    const { rerender } = render(
      createElement(RowSnippet, { preview: lastPreview(useZenStore.getState().previewByKey["s1|t:appa"]) })
    );
    expect(screen.getByText("from cache")).not.toBeNull();

    const before = useZenStore.getState().previewByKey;
    const quietBefore = before["s1|t:quiet"];
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    answer({
      ok: true,
      data: {
        items: [
          latest("appa", { seq: 6, at: 200, preview: "new **news**" }),
          // Same seq + at: nothing moved, even though the server text is flat.
          latest("quiet", { seq: 5, at: 100, preview: "quiet cache" }),
        ],
      },
    });
    await vi.waitFor(() =>
      expect(useZenStore.getState().previewByKey["s1|t:appa"]).toMatchObject({ seq: 6, text: "new **news**" })
    );
    expect(useZenStore.getState().previewByKey["s1|t:quiet"]).toBe(quietBefore);
    rerender(createElement(RowSnippet, { preview: lastPreview(useZenStore.getState().previewByKey["s1|t:appa"]) }));
    expect(screen.getByText("news").tagName).toBe("STRONG");
    // The new item is on the device for the next launch.
    resetRowPreviewMemo();
    expect(readRowPreviews("dtl.k2.dev").appa).toMatchObject({ seq: 6, at: 200 });
  });

  it("an unchanged seq is no store update at all", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockResolvedValue({ ok: true, data: { items: [latest("appa")] } });
    await useZenStore.getState().refreshThreadPreviews({ addrs: ["appa"] });
    const shown = useZenStore.getState().previewByKey;
    const listener = vi.fn();
    const off = useZenStore.subscribe(listener);
    await useZenStore.getState().refreshThreadPreviews({ addrs: ["appa"], force: true });
    off();
    expect(client.getThreadLatest).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
    expect(useZenStore.getState().previewByKey).toBe(shown);
  });

  it("the sweep is one batched call, and only on a server with thread-latest", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(false);
    await useZenStore.getState().refreshThreadPreviews({ addrs: [] }); // launch: cache seeded
    useZenStore.setState({
      previewByKey: {
        "s1|t:appa": { at: 1, seq: 1, mine: false, kind: "text", text: "a" },
        "s1|t:quiet": { at: 1, seq: 1, mine: false, kind: "text", text: "q" },
      },
    });
    vi.mocked(client.serverHasFeature).mockResolvedValue(false);
    await useZenStore.getState().refreshThreadPreviews();
    expect(client.getThread).not.toHaveBeenCalled();
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockResolvedValue({ ok: true, data: { items: [] } });
    await useZenStore.getState().refreshThreadPreviews();
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.getThreadLatest).mock.calls[0][1].sort()).toEqual(["appa", "quiet"]);
    // Inside 30 s the sweep asks nothing.
    await useZenStore.getState().refreshThreadPreviews();
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
  });

  it("a turn that ends re-reads that row at once", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockResolvedValue({ ok: true, data: { items: [latest("appa")] } });
    await useZenStore.getState().refreshThreadPreviews({ addrs: ["appa"] });
    useZenStore.setState({
      agents: [{ id: "/ws", name: "appa", initial: "A", path: "/ws", addr: "appa", kind: "agent" }],
    });
    vi.mocked(client.getActivitySnapshot).mockResolvedValueOnce({
      ok: true,
      data: { rows: [], workspaces: [{ workspacePath: "/ws", display: "working" }] },
    });
    await useZenStore.getState().refreshActivity();
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
    vi.mocked(client.getActivitySnapshot).mockResolvedValue({
      ok: true,
      data: { rows: [], workspaces: [{ workspacePath: "/ws", display: "idle" }] },
    });
    await useZenStore.getState().refreshActivity();
    await vi.waitFor(() => expect(client.getThreadLatest).toHaveBeenCalledTimes(2));
  });

  it("a Thread event updates its row at once, full Markdown over a flat preview", () => {
    useZenStore.setState({
      threadAddr: "appa",
      thread: [],
      previewByKey: { "s1|t:appa": { at: 5, seq: 7, mine: false, kind: "text", text: "flat", flat: true } },
    });
    useZenStore.getState().ingestThreadRaw({
      seq: 7,
      doc: { seq: 7, id: "m7", from: "appa", body: "# Done\n\n- a\n- b", created_at: 5 },
    });
    expect(useZenStore.getState().previewByKey["s1|t:appa"]).toMatchObject({ seq: 7, text: "# Done\n\n- a\n- b" });
    useZenStore.getState().ingestThreadRaw({
      seq: 8,
      doc: { seq: 8, id: "m8", from: "owner", body: "thanks", created_at: 9 },
    });
    expect(useZenStore.getState().previewByKey["s1|t:appa"]).toMatchObject({ seq: 8, mine: true, text: "thanks" });
    expect(useZenStore.getState().lastAtByKey["s1|t:appa"]).toBe(9);
  });

  it("snippet reads never wake a session or open the overlay socket", async () => {
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    vi.mocked(client.getThreadLatest).mockResolvedValue({ ok: true, data: { items: [latest("appa")] } });
    useZenStore.getState().ensureLastAt("s1|t:appa");
    await vi.waitFor(() => expect(useZenStore.getState().previewByKey["s1|t:appa"]).toBeTruthy());
    await useZenStore.getState().refreshThreadPreviews({ force: true });
    for (const fn of [
      client.ensurePinnedChat,
      client.spawnTerminal,
      client.spawnBackgroundTerminal,
      client.spawnSidecarSession,
      client.spawnTabSession,
      client.spawnResumeTab,
      client.getThreadActivity,
      client.postThread,
      connectOverlayEvents,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("row snippet cache", () => {
  it("keeps the newest 200 entries, per host + addr", () => {
    const last: RowLast = { at: 1, seq: 1, mine: false, kind: "text", text: "x" };
    for (let i = 0; i < ROW_PREVIEW_CACHE_CAP + 25; i++) writeRowPreviews("dtl.k2.dev", { [`a${i}`]: last });
    writeRowPreviews("other.k2.dev", { a0: { ...last, text: "other" } });
    const stored = JSON.parse(localStorage.getItem(ROW_PREVIEW_CACHE_KEY) || "{}");
    expect(Object.keys(stored).length).toBe(ROW_PREVIEW_CACHE_CAP);
    resetRowPreviewMemo();
    const mine = readRowPreviews("dtl.k2.dev");
    expect(mine.a0).toBeUndefined(); // oldest fell off
    expect(mine[`a${ROW_PREVIEW_CACHE_CAP + 24}`]).toMatchObject({ text: "x" });
    expect(readRowPreviews("other.k2.dev").a0).toMatchObject({ text: "other" });
  });

  it("a broken or blocked store reads as empty and never throws", () => {
    localStorage.setItem(ROW_PREVIEW_CACHE_KEY, "{not json");
    resetRowPreviewMemo();
    expect(readRowPreviews("dtl.k2.dev")).toEqual({});
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      writeRowPreviews("dtl.k2.dev", { appa: { at: 1, seq: 1, mine: false, kind: "text", text: "x" } })
    ).not.toThrow();
    set.mockRestore();
    expect(readRowPreviews("dtl.k2.dev").appa).toMatchObject({ text: "x" });
  });
});

describe("RowSnippet", () => {
  it("bold/italic are strong/em, inline code a chip, a table the marker, all inline", () => {
    const { container } = render(
      createElement(RowSnippet, {
        preview: lastPreview({
          at: 1,
          seq: 1,
          mine: true,
          kind: "text",
          text: "**Done** with *care*: `npm test`\n\n| a | b |\n|---|---|\n| 1 | 2 |",
        }),
      })
    );
    expect(container.textContent).toBe("You: Done with care: npm test [table]");
    expect(container.querySelector("strong")?.textContent).toBe("Done");
    expect(container.querySelector("em")?.textContent).toBe("care");
    const chip = screen.getByTestId("row-preview-code");
    expect(chip.tagName).toBe("CODE");
    expect(chip.getAttribute("style")).toMatch(/monospace/);
    expect(screen.getByTestId("row-preview-table").textContent).toBe("[table]");
    expect(container.querySelector("table, div, p, br, ul, li, h1, h2, pre")).toBeNull();
  });
});

describe("refreshRemotePreviews (S3b: Home rows from another server)", () => {
  beforeEach(() => {
    useServersStore.setState({
      servers: [
        { id: "s1", nickname: "", url: "https://dtl.k2.dev", username: "baden", rememberPassword: false },
        { id: "s2", nickname: "B", url: "https://bravo.k2.dev", username: "baden", rememberPassword: false },
      ],
      activeServerId: "s1",
      tokens: { s1: "tok", s2: "tok-b" },
    });
  });

  it("seeds B's snippets from this device's cache under B's host key, without a fetch", async () => {
    writeRowPreviews("bravo.k2.dev", { docs: { text: "cached on B", kind: "text", mine: false, at: 7, seq: 1 } });
    writeRowPreviews("dtl.k2.dev", { docs: { text: "on A", kind: "text", mine: false, at: 9, seq: 1 } });
    resetRowPreviewMemo();
    await useZenStore.getState().refreshRemotePreviews("s2", ["docs"], { fetch: false });
    expect(useZenStore.getState().previewByKey["s2|t:docs"]?.text).toBe("cached on B");
    expect(useZenStore.getState().lastAtByKey["s2|t:docs"]).toBe(7);
    expect(useZenStore.getState().previewByKey["s1|t:docs"]).toBeUndefined();
    expect(client.getThreadLatest).not.toHaveBeenCalled();
  });

  it("fetches on B's scope only when B lists thread-latest; never per-row GETs", async () => {
    vi.mocked(client.getThreadLatest).mockResolvedValue({ ok: true, data: { items: [latest("docs")] } });
    vi.mocked(client.serverHasFeature).mockResolvedValue(true);
    await useZenStore.getState().refreshRemotePreviews("s2", ["docs"], { fetch: true });
    expect(client.getThreadLatest).not.toHaveBeenCalled();
    expect(client.getThread).not.toHaveBeenCalled();
    noteBootStatus("s2", { version: "0.45.5", features: ["thread-latest"] });
    await useZenStore.getState().refreshRemotePreviews("s2", ["docs"], { fetch: true });
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.getThreadLatest).mock.calls[0][0]).toMatchObject({ id: "s2" });
    expect(useZenStore.getState().previewByKey["s2|t:docs"]?.text).toBe("hello from docs");
    expect(readRowPreviews("bravo.k2.dev").docs?.text).toBe("hello from docs");
    // Throttled per addr.
    await useZenStore.getState().refreshRemotePreviews("s2", ["docs"], { fetch: true });
    expect(client.getThreadLatest).toHaveBeenCalledTimes(1);
  });
});
