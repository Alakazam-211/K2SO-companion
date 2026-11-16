import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeChatMessage } from "../../api/homeChatPure";
import type { ServerScope } from "../../api/scope";

const api = vi.hoisted(() => ({
  fetchHomeChatMessages: vi.fn(),
  fetchHomeChatPeople: vi.fn(),
  fetchHomeChatReactors: vi.fn(),
  fetchHomeChatMembers: vi.fn(),
  openHomeChatDm: vi.fn(),
  reactHomeChat: vi.fn(),
  sendHomeChatMessage: vi.fn(),
  typingHomeChat: vi.fn(),
}));
vi.mock("../../api/homeChat", () => ({ ...api, HOME_CHAT_PAGE_DEFAULT: 50, HOME_CHAT_PAGE_MAX: 100 }));

import {
  __resetHomeChatActionsForTests,
  applyHomeChatFrame,
  dropHomeChatSend,
  loadHomeChatNewest,
  loadHomeChatOlder,
  noteHomeChatDraft,
  resolveHomeChatConv,
  retryHomeChatSend,
  sendHomeChat,
  toggleHomeChatReaction,
} from "./homeChatActions";
import { resetHomeChatStore, useHomeChatStore } from "./homeChatStore";
import { convKey } from "./homeChatModel";

const scope = { id: "s1", username: () => "sam" } as unknown as ServerScope;
const KEY = convKey("s1", "9");

function msg(id: string, over: Partial<HomeChatMessage> = {}): HomeChatMessage {
  return {
    id,
    conv: "9",
    authorId: "2",
    body: `m${id}`,
    createdAtMs: Number(id) * 1000,
    seq: Number(id),
    reactions: [],
    replyTo: null,
    edited: false,
    editedAtMs: null,
    deleted: false,
    nonce: null,
    call: null,
    ...over,
  };
}

const ids = () => (useHomeChatStore.getState().convs[KEY]?.messages ?? []).map((m) => m.id);

beforeEach(() => {
  resetHomeChatStore();
  __resetHomeChatActionsForTests();
  for (const f of Object.values(api)) f.mockReset();
  useHomeChatStore.getState().setPeople("s1", { me: { ext: "k2:owner", memberId: "1" }, people: [] });
});

describe("reading", () => {
  it("reads the newest page first, then only what came after on a reopen", async () => {
    api.fetchHomeChatMessages.mockResolvedValueOnce({ ok: true, conv: "9", messages: [msg("10"), msg("11")], hasMore: true });
    await loadHomeChatNewest(scope, "9");
    expect(api.fetchHomeChatMessages).toHaveBeenLastCalledWith(scope, "9", { limit: 50 });
    expect(ids()).toEqual(["10", "11"]);
    expect(useHomeChatStore.getState().convs[KEY]).toMatchObject({ hasMore: true, loaded: true, error: null });

    api.fetchHomeChatMessages.mockResolvedValueOnce({ ok: true, conv: "9", messages: [msg("12")], hasMore: false });
    await loadHomeChatNewest(scope, "9");
    expect(api.fetchHomeChatMessages).toHaveBeenLastCalledWith(scope, "9", { after: "11", limit: 100 });
    expect(ids()).toEqual(["10", "11", "12"]);
  });

  it("keeps what it held and says why when a read fails", async () => {
    useHomeChatStore.getState().mergeMessages(KEY, [msg("10")]);
    api.fetchHomeChatMessages.mockResolvedValueOnce({ ok: false, kind: "network", code: "network", hint: "x", status: null });
    await loadHomeChatNewest(scope, "9");
    expect(ids()).toEqual(["10"]);
    expect(useHomeChatStore.getState().convs[KEY].error).toBe("Can't reach the server");
  });

  it("pages older before the oldest held", async () => {
    useHomeChatStore.getState().patchConv(KEY, { messages: [msg("20")], hasMore: true, loaded: true });
    api.fetchHomeChatMessages.mockResolvedValueOnce({ ok: true, conv: "9", messages: [msg("18"), msg("19")], hasMore: false });
    const got = await loadHomeChatOlder(scope, "9");
    expect(api.fetchHomeChatMessages).toHaveBeenLastCalledWith(scope, "9", { before: "20", limit: 50 });
    expect(got?.map((m) => m.id)).toEqual(["18", "19", "20"]);
    expect(useHomeChatStore.getState().convs[KEY].hasMore).toBe(false);
    expect(await loadHomeChatOlder(scope, "9")).toBeNull();
  });

  it("opens a DM known only by person, once", async () => {
    api.openHomeChatDm.mockResolvedValueOnce({ ok: true, conv: "44", created: true });
    const t = { serverId: "s1", kind: "dm" as const, conversationId: null, title: "Ana", ext: "k2:connect:ana" };
    expect(await resolveHomeChatConv(scope, t)).toEqual({ conv: "44" });
    expect(await resolveHomeChatConv(scope, t)).toEqual({ conv: "44" });
    expect(api.openHomeChatDm).toHaveBeenCalledTimes(1);
  });
});

describe("sending", () => {
  it("shows the bubble at once and swaps in the server's copy by nonce", async () => {
    let answer: (v: unknown) => void = () => {};
    api.sendHomeChatMessage.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const p = sendHomeChat(scope, "9", { text: " hello ", replyTo: "5" });
    const sent = api.sendHomeChatMessage.mock.calls[0][1];
    expect(sent).toMatchObject({ conv: "9", text: "hello", replyTo: "5" });
    expect(ids()).toEqual([`~${sent.nonce}`]);
    expect(useHomeChatStore.getState().sends[KEY][sent.nonce].status).toBe("sending");
    answer({ ok: true, message: msg("30", { authorId: "1", body: "hello", nonce: sent.nonce }) });
    expect(await p).toBe(true);
    expect(ids()).toEqual(["30"]);
    expect(useHomeChatStore.getState().sends[KEY]).toEqual({});
  });

  it("retries a failed send with the same nonce, so it never posts twice", async () => {
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: false, kind: "server", code: "sew_error", hint: "Sew said no", status: 502 });
    expect(await sendHomeChat(scope, "9", { text: "hi" })).toBe(false);
    const nonce = api.sendHomeChatMessage.mock.calls[0][1].nonce;
    expect(useHomeChatStore.getState().sends[KEY][nonce]).toMatchObject({ status: "failed", error: "Sew said no" });
    expect(ids()).toEqual([`~${nonce}`]);

    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    expect(await retryHomeChatSend(scope, "9", nonce)).toBe(true);
    expect(api.sendHomeChatMessage.mock.calls[1][1].nonce).toBe(nonce);

    // Typing the same words again after a failure reuses it too.
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: false, kind: "server", code: "x", hint: "no", status: 500 });
    await sendHomeChat(scope, "9", { text: "again" });
    const n2 = api.sendHomeChatMessage.mock.calls[2][1].nonce;
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    await sendHomeChat(scope, "9", { text: "again" });
    expect(api.sendHomeChatMessage.mock.calls[3][1].nonce).toBe(n2);
  });

  it("takes a Not sent bubble back for editing", async () => {
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: false, kind: "network", code: "network", hint: "", status: null });
    await sendHomeChat(scope, "9", { text: "fix me" });
    const nonce = api.sendHomeChatMessage.mock.calls[0][1].nonce;
    expect(dropHomeChatSend("s1", "9", nonce)?.text).toBe("fix me");
    expect(ids()).toEqual([]);
  });
});

describe("typing", () => {
  it("says typing at most once per 8 s per conversation, never for a blank box", () => {
    expect(noteHomeChatDraft(scope, "9", "  ", 1000)).toBe(false);
    expect(noteHomeChatDraft(scope, "9", "h", 1000)).toBe(true);
    expect(noteHomeChatDraft(scope, "9", "he", 8999)).toBe(false);
    expect(noteHomeChatDraft(scope, "9", "hel", 9000)).toBe(true);
    expect(api.typingHomeChat).toHaveBeenCalledTimes(2);
  });
});

describe("reactions", () => {
  it("toggles at once and puts it back on a refusal", async () => {
    useHomeChatStore.getState().mergeMessages(KEY, [msg("10", { reactions: [{ emoji: "👍", count: 1, me: false }] })]);
    api.reactHomeChat.mockResolvedValueOnce({ ok: false, kind: "denied", code: "not_a_member", hint: "You're not in it", status: 403 });
    const p = toggleHomeChatReaction(scope, "9", "10", "👍");
    expect(useHomeChatStore.getState().convs[KEY].messages[0].reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
    expect(api.reactHomeChat).toHaveBeenCalledWith(scope, { conv: "9", msg: "10", emoji: "👍", on: true });
    expect(await p).toBe("You're not in it");
    expect(useHomeChatStore.getState().convs[KEY].messages[0].reactions).toEqual([{ emoji: "👍", count: 1, me: false }]);
  });
});

describe("frames", () => {
  it("merges messages, marks deletes, sets reaction counts, notes and clears typing", () => {
    useHomeChatStore.getState().mergeMessages(KEY, [msg("10")]);
    applyHomeChatFrame("s1", { type: "typing", conv: "9", member: "2" }, 1000);
    expect(useHomeChatStore.getState().typing[KEY]).toEqual({ "2": 11_000 });
    applyHomeChatFrame("s1", { type: "message", conv: "9", message: msg("11") });
    expect(ids()).toEqual(["10", "11"]);
    expect(useHomeChatStore.getState().typing[KEY]).toEqual({});
    applyHomeChatFrame("s1", { type: "reaction", conv: "9", msg: "10", emoji: "🎉", on: true, count: 3, member: "5", mine: false });
    expect(useHomeChatStore.getState().convs[KEY].messages[0].reactions).toEqual([{ emoji: "🎉", count: 3, me: false }]);
    applyHomeChatFrame("s1", { type: "deleted", conv: "9", id: "10" });
    expect(useHomeChatStore.getState().convs[KEY].messages[0]).toMatchObject({ deleted: true, body: "" });
    // A conversation never opened here is left alone.
    applyHomeChatFrame("s1", { type: "message", conv: "77", message: msg("1", { conv: "77" }) });
    expect(useHomeChatStore.getState().convs[convKey("s1", "77")]).toBeUndefined();
  });
});
