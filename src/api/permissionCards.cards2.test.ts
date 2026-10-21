import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...a: unknown[]) => tauriFetch(...a) }));

import { __resetScopesForTests, noteBootStatus, scopeFor } from "./scope";
import { getThread } from "./client";
import { fetchThreadDelta } from "./threadDelta";
import { catchupBody, postCatchup } from "./threadCatchup";
import { overlayEventsUrl } from "../zen/threadLive";
import { useServersStore } from "../stores/servers";

// K2 0.46.3 permission cards: `cards=2` on every Thread read and socket,
// only when the server lists `permission-cards-v1` (contract v1 §1).

const ok = (body: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body });

beforeEach(() => {
  tauriFetch.mockReset();
  tauriFetch.mockResolvedValue(ok({ items: [] }));
  __resetScopesForTests();
  useServersStore.setState({
    servers: [{ id: "s1", nickname: "H", url: "https://home.k2.dev", username: "rosson", rememberPassword: false }],
    activeServerId: "s1",
    tokens: { s1: "t" },
    recovery: {},
  });
});

const lastUrl = () => new URL(tauriFetch.mock.calls[tauriFetch.mock.calls.length - 1][0] as string);

describe("cards=2", () => {
  it("off without the feature; on for page, delta, catch-up and the overlay socket with it", async () => {
    noteBootStatus("s1", { version: "0.46.2", features: [] });
    await getThread(scopeFor("s1"), "billing");
    expect(lastUrl().searchParams.get("cards")).toBeNull();

    noteBootStatus("s1", { version: "0.46.3", features: ["permission-cards-v1", "thread-delta-v1"] });
    await getThread(scopeFor("s1"), "billing");
    expect(lastUrl().searchParams.get("cards")).toBe("2");
    await fetchThreadDelta(scopeFor("s1"), "billing", 40);
    expect(lastUrl().searchParams.get("cards")).toBe("2");
    tauriFetch.mockResolvedValue(ok({ ok: true, threads: [] }));
    await postCatchup(scopeFor("s1"), catchupBody([{ addr: "billing", afterSeq: 1 }], []));
    expect(JSON.parse((tauriFetch.mock.calls[tauriFetch.mock.calls.length - 1][1] as { body: string }).body).cards).toBe(2);
    expect(overlayEventsUrl("https://home.k2.dev", "t", "c-1", { cards2: true })).toContain("cards=2");
    expect(overlayEventsUrl("https://home.k2.dev", "t", "c-1")).not.toContain("cards=");
  });
});
