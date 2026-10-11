import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

import {
  commentFeedback,
  fetchAllFeedback,
  fetchFeedbackShow,
  fetchTicketUsers,
  resolveFeedback,
} from "./feedback";
import { useServersStore } from "../stores/servers";

function reply(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

function lastCall(): { url: string; body: Record<string, unknown> | undefined } {
  const [url, init] = tauriFetch.mock.calls[tauriFetch.mock.calls.length - 1] as [
    string,
    { body?: string },
  ];
  return { url, body: init?.body ? JSON.parse(init.body) : undefined };
}

beforeEach(() => {
  tauriFetch.mockReset();
  useServersStore.setState({
    servers: [
      { id: "s1", nickname: "t", url: "http://127.0.0.1:9", username: "u", rememberPassword: false },
    ],
    activeServerId: "s1",
    tokens: { s1: "tok" },
  });
});

afterEach(() => {
  useServersStore.setState({ servers: [], activeServerId: null, tokens: {} });
});

describe("commentFeedback", () => {
  it("an option tap sends optionPick:true and no author", async () => {
    tauriFetch.mockResolvedValue(reply(200, { ok: true, id: "t1", status: "answered" }));
    await commentFeedback("t1", "Pro", { optionPick: true });
    const { url, body } = lastCall();
    expect(url).toContain("/cli/feedback/comment");
    expect(body).toEqual({ id: "t1", body: "Pro", optionPick: true });
    expect(body).not.toHaveProperty("author");
  });

  it("free text is a plain comment: no optionPick, no author", async () => {
    tauriFetch.mockResolvedValue(reply(200, { ok: true, id: "t1", status: "needs_discussion" }));
    await commentFeedback("t1", "Can we talk about it?");
    expect(lastCall().body).toEqual({ id: "t1", body: "Can we talk about it?" });
  });
});

describe("fetchFeedbackShow", () => {
  it("adds brief=1 only when asked", async () => {
    tauriFetch.mockResolvedValue(reply(200, { ok: true, id: "t1", comments: [] }));
    await fetchFeedbackShow("t1");
    expect(lastCall().url).not.toContain("brief=1");
    await fetchFeedbackShow("t1", { brief: true });
    expect(lastCall().url).toContain("brief=1");
  });
});

describe("resolveFeedback", () => {
  it("answered carries the agreed answer; other statuses don't", async () => {
    tauriFetch.mockResolvedValue(reply(200, { ok: true }));
    await resolveFeedback("t1", "answered", "Pro");
    expect(lastCall().body).toEqual({ id: "t1", status: "answered", answer: "Pro" });
    await resolveFeedback("t1", "planned");
    expect(lastCall().body).toEqual({ id: "t1", status: "planned" });
  });

  it("surfaces the nested error hint", async () => {
    tauriFetch.mockResolvedValue(
      reply(400, { ok: false, error: { code: "usage", hint: "bad status" } })
    );
    await expect(resolveFeedback("t1", "waiting")).rejects.toThrow("bad status");
  });
});

describe("fetchTicketUsers", () => {
  it("prefers tickets/settings people (0.45.4)", async () => {
    tauriFetch.mockResolvedValue(
      reply(200, {
        ok: true,
        people: [
          { value: "owner", label: "Rosson (owner)" },
          { value: "julie", label: "julie" },
          { value: "gone", label: "gone", disabled: true },
        ],
      })
    );
    expect(await fetchTicketUsers()).toEqual(["owner", "julie"]);
  });

  it("falls back to /cli/users on an older daemon", async () => {
    tauriFetch
      .mockResolvedValueOnce(reply(404, "route not found"))
      .mockResolvedValueOnce(reply(200, { users: [{ username: "julie" }] }));
    expect(await fetchTicketUsers()).toEqual(["owner", "julie"]);
    expect(lastCall().url).toContain("/cli/users");
  });
});

describe("fetchAllFeedback", () => {
  it("uses list-all and keeps linked:false rows", async () => {
    tauriFetch.mockResolvedValue(
      reply(200, {
        ok: true,
        items: [
          { id: "a", status: "waiting", createdAt: 1, linked: true, projectName: "K2", projectPath: "/k2" },
          { id: "b", status: "waiting", createdAt: 2, linked: false, projectName: null, projectPath: null },
        ],
      })
    );
    const rows = await fetchAllFeedback([]);
    expect(lastCall().url).toContain("/cli/feedback/list-all");
    expect(rows.map((r) => [r.id, r.linked])).toEqual([
      ["b", false],
      ["a", true],
    ]);
  });

  it("fans out per workspace when list-all is missing", async () => {
    tauriFetch
      .mockResolvedValueOnce(reply(404, "route not found"))
      .mockResolvedValueOnce(reply(200, { ok: true, items: [{ id: "a", status: "waiting", createdAt: 1 }] }));
    const rows = await fetchAllFeedback([{ name: "K2", path: "/k2" }]);
    expect(lastCall().url).toContain("/cli/feedback/list?");
    expect(rows[0]).toMatchObject({ id: "a", projectName: "K2" });
  });
});
