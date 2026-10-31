// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })) }));

import { createChatCache, type ChatCache } from "../zen/chatCache";
import { memoryBackend } from "../zen/chatCacheBackend";
import type { ServerEntry } from "../stores/servers";
import type { ThreadMessage } from "../zen/threadModel";
import { newestSeq } from "../zen/threadCacheMerge";
import { inboxServer, mergeInbox, parseInboxEntry, pushInboxStats, resetPushInboxStats } from "./pushInbox";

// K2 0.46.3 sealed alerts carry the message (`msg`); the NSE saves it and
// the app merges it into the chat cache — only when certain.

const srv = (id: string, url: string): ServerEntry => ({ id, nickname: id, url, username: "u", rememberPassword: false });
const ROSSON = srv("s1", "https://rosson.k2.dev");
const msg = (seq: number): ThreadMessage => ({ id: `m${seq}`, seq, text: `m${seq}`, from: "cortana", at: seq, mine: false, kind: "text", choice: null });

const raw = (over: Record<string, unknown> = {}, m: Record<string, unknown> = {}) => ({
  msg: { at: 1760959998, conversationId: "c-77", from: "cortana", id: "ov-1", kind: "text", seq: 418, text: "Deploy finished", truncated: false, ...m },
  subdomain: "rosson",
  badgeKey: "0123456789abcdef0123456789abcdef",
  addr: "k2/reviewer",
  conversationId: "c-77",
  receivedAt: 1,
  ...over,
});

let cache: ChatCache;
beforeEach(() => {
  resetPushInboxStats();
  cache = createChatCache({ backend: () => memoryBackend() });
  cache.remember({ key: "s1|t:k2/reviewer", serverId: "s1", messages: [msg(416), msg(417)], conversationId: "c-77", hasMore: true });
});

const deps = (servers: ServerEntry[] = [ROSSON], keys: Record<string, string> = {}) => ({
  cache: () => cache,
  servers: () => servers,
  badgeKeys: () => keys,
});

describe("push inbox → chat cache", () => {
  it("a sealed text message lands in its cached Thread, after the newest", async () => {
    const e = parseInboxEntry(raw())!;
    expect(await mergeInbox([e], deps())).toBe(1);
    const hit = (await cache.read("s1|t:k2/reviewer"))!.entry;
    expect(hit.messages.map((m) => m.id)).toEqual(["m416", "m417", "ov-1"]);
    expect(hit.messages[2]).toMatchObject({ text: "Deploy finished", from: "cortana", mine: false, seq: 418, provisional: true });
    expect(hit.messages[2].partial).toBeUndefined();
    expect(hit.hasMore).toBe(true);
    // Not confirmed: the next delta still starts after 417, so it fetches
    // 418 whole and anything the push didn't carry.
    expect(newestSeq(hit.messages)).toBe(417);
    expect(await mergeInbox([e], deps())).toBe(0); // already there
  });

  it("a message cut short to fit the push lands as partial (the rest comes with the server's copy)", async () => {
    const e = parseInboxEntry(raw({}, { truncated: true, text: "Release notes draft, section by section. Rel" }))!;
    expect(await mergeInbox([e], deps())).toBe(1);
    const hit = (await cache.read("s1|t:k2/reviewer"))!.entry;
    expect(hit.messages[2]).toMatchObject({ id: "ov-1", partial: true, provisional: true });
    expect(newestSeq(hit.messages)).toBe(417);
    expect(pushInboxStats()).toMatchObject({ drains: 1, received: 1, landed: 1, partial: 1 });
  });

  it("skips what isn't certain: cards, secrets, no cache, another conversation; and counts why", async () => {
    const skip = [
      raw({}, { kind: "choice" }),
      raw({}, { kind: "secret", text: "" }),
      raw({ addr: "other" }),
      raw({}, { conversationId: "c-OTHER" }),
      raw({ subdomain: "nobody" }),
    ].map((r) => parseInboxEntry(r)!);
    expect(await mergeInbox(skip, deps())).toBe(0);
    expect(pushInboxStats().skipped).toEqual({ notText: 2, noServer: 1, notCached: 1, otherConversation: 1, alreadyThere: 0 });
  });

  it("server: one account on that label, else the badgeKey must pick exactly one", () => {
    const A = srv("a", "https://rosson.k2.dev");
    const B = srv("b", "https://rosson.k2.dev");
    const e = { subdomain: "rosson", badgeKey: "0123456789abcdef0123456789abcdef" };
    expect(inboxServer(e, [ROSSON], {})?.id).toBe("s1");
    expect(inboxServer(e, [A, B], {})).toBeNull();
    expect(inboxServer(e, [A, B], { b: "0123456789abcdef0123456789abcdef" })?.id).toBe("b");
    expect(inboxServer({ subdomain: "", badgeKey: "" }, [ROSSON], {})).toBeNull();
  });

  it("entries without a message id are ignored", () => {
    expect(parseInboxEntry({ msg: { text: "x" } })).toBeNull();
    expect(parseInboxEntry(null)).toBeNull();
  });
});

describe("drain triggers", () => {
  it("drains on launch, on foreground, and on every alert shown while open (badgeTotals)", async () => {
    const core = await import("@tauri-apps/api/core");
    const invoke = vi.mocked(core.invoke);
    invoke.mockReset();
    invoke.mockResolvedValue({ available: true, items: [] });
    const listen = vi.mocked(core.addPluginListener);
    const { installPushInboxDrain } = await import("./pushInbox");
    const stop = installPushInboxDrain();
    expect(invoke).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(listen).toHaveBeenCalledWith("k2-push", "badgeTotals", expect.any(Function));
    const onAlert = listen.mock.calls[0][2] as () => void;
    onAlert();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("plugin:k2-push|e2e_op", { op: "drainInbox" });
    stop();
  });
});
