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
  __setHomeChatSleepForTests,
  applyHomeChatFrame,
  CHANNEL_ARCHIVED_TEXT,
  DM_GONE_TEXT,
  dropHomeChatSend,
  findHomeChatSend,
  loadHomeChatNewest,
  loadHomeChatOlder,
  noteHomeChatDraft,
  resolveHomeChatConv,
  retryHomeChatSend,
  sendHomeChat,
  toggleHomeChatReaction,
} from "./homeChatActions";
import { onHomeChatMoved, resetHomeChatStore, useHomeChatStore, type HomeChatMoved } from "./homeChatStore";
import { convKey, homeChatDraftKey, sendFailedNote } from "./homeChatModel";
import { useComposerDrafts } from "../composerDrafts";
import type { HomeChatMembers } from "../../api/homeChatPure";

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

// K2 0.46.13's send refusals.
const refusal = (code: string, status: number, kind = "conflict") => ({ ok: false, kind, code, hint: `server says ${code}`, status });

describe("send: conversation_gone (a DM Sew lost)", () => {
  const NEW_KEY = convKey("s1", "77");
  let moved: HomeChatMoved[] = [];
  let unhook: () => void = () => {};
  beforeEach(() => {
    moved = [];
    unhook();
    unhook = onHomeChatMoved((m) => moved.push(m));
    useComposerDrafts.setState({ drafts: {} });
    useHomeChatStore.getState().openChat({ serverId: "s1", kind: "dm", conversationId: "9", title: "Ann", ext: "k2:ann" });
  });

  it("reopens the DM, moves everything to the new id and sends once more with the same nonce", async () => {
    useComposerDrafts.getState().setDraft(homeChatDraftKey("s1", "9"), "half a thought");
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("conversation_gone", 404, "not_found"));
    api.openHomeChatDm.mockResolvedValueOnce({ ok: true, conv: "77", created: true });
    api.sendHomeChatMessage.mockImplementationOnce(async (_s: unknown, b: { nonce: string }) => ({
      ok: true,
      message: msg("80", { conv: "77", authorId: "1", body: "hi", nonce: b.nonce }),
    }));

    expect(await sendHomeChat(scope, "9", { text: "hi", replyTo: "5" })).toBe(true);

    const [first, second] = api.sendHomeChatMessage.mock.calls.map((c) => c[1]);
    expect(api.openHomeChatDm).toHaveBeenCalledWith(scope, "k2:ann");
    expect(first).toMatchObject({ conv: "9", text: "hi", replyTo: "5" });
    // Same nonce on the new conversation; the reply's original was in the old one.
    expect(second).toMatchObject({ conv: "77", text: "hi", nonce: first.nonce, replyTo: null });

    const s = useHomeChatStore.getState();
    expect(s.open?.conversationId).toBe("77");
    expect(s.dms["s1|k2:ann"]).toBe("77");
    expect(s.convs[KEY]).toBeUndefined();
    expect(s.convs[NEW_KEY].messages.map((m) => m.id)).toEqual(["80"]);
    expect(s.sends[KEY]).toBeUndefined();
    expect(s.sends[NEW_KEY]).toEqual({});
    const drafts = useComposerDrafts.getState().drafts;
    expect(drafts[homeChatDraftKey("s1", "77")!]?.text).toBe("half a thought");
    expect(drafts[homeChatDraftKey("s1", "9")!]).toBeUndefined();
    expect(moved).toEqual([{ serverId: "s1", ext: "k2:ann", from: "9", to: "77" }]);
  });

  it("finds the person from the DM mapping when the view was opened by person", async () => {
    useHomeChatStore.setState({ open: { serverId: "s1", kind: "dm", conversationId: null, title: "Ann", ext: "k2:ann" } });
    useHomeChatStore.getState().noteDm("s1", "k2:ann", "9");
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("conversation_gone", 404, "not_found"));
    api.openHomeChatDm.mockResolvedValueOnce({ ok: true, conv: "77", created: true });
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    expect(await sendHomeChat(scope, "9", { text: "hi" })).toBe(true);
    expect(useHomeChatStore.getState().open?.conversationId).toBe("77");
    expect(useHomeChatStore.getState().dms["s1|k2:ann"]).toBe("77");
  });

  it("sends again on the same id when the reopen answers the same conversation", async () => {
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("conversation_gone", 404, "not_found"));
    api.openHomeChatDm.mockResolvedValueOnce({ ok: true, conv: "9", created: false });
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    expect(await sendHomeChat(scope, "9", { text: "hi" })).toBe(true);
    expect(api.sendHomeChatMessage.mock.calls[1][1].conv).toBe("9");
    expect(moved).toEqual([]);
    expect(useHomeChatStore.getState().open?.conversationId).toBe("9");
  });

  it("shows Not sent with a clear line when the reopen fails", async () => {
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("conversation_gone", 404, "not_found"));
    api.openHomeChatDm.mockResolvedValueOnce({ ok: false, kind: "network", code: "network", hint: "", status: null });
    expect(await sendHomeChat(scope, "9", { text: "hi" })).toBe(false);
    expect(api.sendHomeChatMessage).toHaveBeenCalledTimes(1);
    const nonce = api.sendHomeChatMessage.mock.calls[0][1].nonce;
    const s = useHomeChatStore.getState().sends[KEY][nonce];
    expect(s).toMatchObject({ status: "failed", error: DM_GONE_TEXT });
    expect(s.final).toBeFalsy();
    expect(sendFailedNote(findHomeChatSend("s1", { text: "hi" }))).toContain("couldn't be reopened");
  });

  it("tries the reopen only once", async () => {
    api.sendHomeChatMessage.mockResolvedValue(refusal("conversation_gone", 404, "not_found"));
    api.openHomeChatDm.mockResolvedValue({ ok: true, conv: "77", created: true });
    expect(await sendHomeChat(scope, "9", { text: "hi" })).toBe(false);
    expect(api.openHomeChatDm).toHaveBeenCalledTimes(1);
    expect(api.sendHomeChatMessage).toHaveBeenCalledTimes(2);
    const nonce = api.sendHomeChatMessage.mock.calls[0][1].nonce;
    expect(useHomeChatStore.getState().sends[NEW_KEY][nonce]).toMatchObject({ status: "failed", error: DM_GONE_TEXT });
    // Retry from the moved bubble keeps the nonce.
    api.sendHomeChatMessage.mockReset();
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    expect(await retryHomeChatSend(scope, "77", nonce)).toBe(true);
    expect(api.sendHomeChatMessage.mock.calls[0][1]).toMatchObject({ conv: "77", nonce });
  });
});

describe("send: send_in_progress (same nonce still in flight)", () => {
  let waits: number[] = [];
  beforeEach(() => {
    waits = [];
    __setHomeChatSleepForTests(async (ms) => {
      waits.push(ms);
    });
  });

  it("waits 1 s then 2 s and sends again with the same nonce; the first message dedupes the bubble", async () => {
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("send_in_progress", 409, "retry"));
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("send_in_progress", 409, "retry"));
    api.sendHomeChatMessage.mockImplementationOnce(async (_s: unknown, b: { nonce: string }) => ({
      ok: true,
      message: msg("40", { authorId: "1", body: "yo", nonce: b.nonce }),
    }));
    expect(await sendHomeChat(scope, "9", { text: "yo" })).toBe(true);
    expect(waits).toEqual([1000, 2000]);
    const nonces = api.sendHomeChatMessage.mock.calls.map((c) => c[1].nonce);
    expect(new Set(nonces).size).toBe(1);
    expect(ids()).toEqual(["40"]);
  });

  it("dedupes against the bubble even when the answer's copy has no nonce, and against a frame that came first", async () => {
    let nonce = "";
    api.sendHomeChatMessage.mockImplementationOnce(async (_s: unknown, b: { nonce: string }) => {
      nonce = b.nonce;
      // The first message's frame arrives while the send is still answering.
      applyHomeChatFrame("s1", { type: "message", conv: "9", message: msg("41", { authorId: "1", body: "yo", nonce }) });
      return refusal("send_in_progress", 409, "retry");
    });
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: msg("41", { authorId: "1", body: "yo" }) });
    expect(await sendHomeChat(scope, "9", { text: "yo" })).toBe(true);
    expect(ids()).toEqual(["41"]);
    expect(api.sendHomeChatMessage.mock.calls[1][1].nonce).toBe(nonce);
  });

  it("gives up after the waits with Retry on the same nonce", async () => {
    api.sendHomeChatMessage.mockResolvedValue(refusal("send_in_progress", 409, "retry"));
    expect(await sendHomeChat(scope, "9", { text: "yo" })).toBe(false);
    expect(api.sendHomeChatMessage).toHaveBeenCalledTimes(3);
    const nonce = api.sendHomeChatMessage.mock.calls[0][1].nonce;
    const s = useHomeChatStore.getState().sends[KEY][nonce];
    expect(s.status).toBe("failed");
    expect(s.final).toBeFalsy();
    api.sendHomeChatMessage.mockReset();
    api.sendHomeChatMessage.mockResolvedValueOnce({ ok: true, message: null });
    expect(await retryHomeChatSend(scope, "9", nonce)).toBe(true);
    expect(api.sendHomeChatMessage.mock.calls[0][1].nonce).toBe(nonce);
  });

  it("stops waiting when the bubble was taken back", async () => {
    api.sendHomeChatMessage.mockResolvedValue(refusal("send_in_progress", 409, "retry"));
    __setHomeChatSleepForTests(async () => {
      const n = api.sendHomeChatMessage.mock.calls[0][1].nonce;
      dropHomeChatSend("s1", "9", n);
    });
    expect(await sendHomeChat(scope, "9", { text: "yo" })).toBe(false);
    expect(api.sendHomeChatMessage).toHaveBeenCalledTimes(1);
    expect(useHomeChatStore.getState().sends[KEY]).toEqual({});
    expect(ids()).toEqual([]);
  });
});

describe("send: channel_archived", () => {
  const channel = (state: string): HomeChatMembers =>
    ({ conv: "9", name: "general", open: true, state, people: [] }) as unknown as HomeChatMembers;

  it("shows Not sent with no Retry and makes the channel read-only", async () => {
    useHomeChatStore.getState().setChannel(KEY, channel("active"));
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("channel_archived", 409));
    expect(await sendHomeChat(scope, "9", { text: "hello?" })).toBe(false);
    const nonce = api.sendHomeChatMessage.mock.calls[0][1].nonce;
    const s = useHomeChatStore.getState().sends[KEY][nonce];
    expect(s).toMatchObject({ status: "failed", error: CHANNEL_ARCHIVED_TEXT, final: true });
    expect(sendFailedNote(s)).toBe("This channel is archived.");
    expect(useHomeChatStore.getState().channels[KEY].state).toBe("archived");
    // No Retry: a retry does nothing.
    expect(await retryHomeChatSend(scope, "9", nonce)).toBe(false);
    expect(api.sendHomeChatMessage).toHaveBeenCalledTimes(1);
  });

  it("reads the channel again when its facts aren't held", async () => {
    api.sendHomeChatMessage.mockResolvedValueOnce(refusal("channel_archived", 409));
    api.fetchHomeChatMembers.mockResolvedValueOnce({ ok: true, members: channel("archived") });
    await sendHomeChat(scope, "9", { text: "hello?" });
    await Promise.resolve();
    expect(api.fetchHomeChatMembers).toHaveBeenCalledWith(scope, { conv: "9" });
    await vi.waitFor(() => expect(useHomeChatStore.getState().channels[KEY]?.state).toBe("archived"));
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
