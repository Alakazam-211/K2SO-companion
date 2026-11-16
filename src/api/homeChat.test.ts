import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, ensureBootMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), ensureBootMock: vi.fn() }));
vi.mock("./scopedFetch", () => ({ NOT_CONNECTED: "Not connected", scopedFetch: fetchMock }));
vi.mock("./scope", async (orig) => ({ ...(await orig<typeof import("./scope")>()), ensureBootStatus: ensureBootMock }));

import { fakeScope, type FakeScope } from "../test/fakeScope";
import {
  HOME_CHAT_GATE_FRESH_MS,
  HOME_CHAT_GATE_RETRY_MS,
  __resetHomeChatGateForTests,
  ackHomeChat,
  addHomeChatPeople,
  cancelDmCall,
  createHomeChatChannel,
  declineDmCall,
  deleteHomeChatChannel,
  fetchHomeChatChangesSince,
  fetchHomeChatChannels,
  fetchHomeChatMembers,
  fetchHomeChatMessages,
  fetchHomeChatPeople,
  fetchHomeChatReactors,
  fetchHomeChatStatus,
  fetchHomeChatSummary,
  homeChatGateNow,
  homeChatOffered,
  joinDmCall,
  leaveDmCall,
  leaveHomeChatChannel,
  noteHomeChatLink,
  onHomeChatGate,
  openHomeChatDm,
  reactHomeChat,
  refreshHomeChatGate,
  removeHomeChatPerson,
  renameHomeChatChannel,
  ringDmCallAgain,
  sendHomeChatMessage,
  setHomeChatAllowAgents,
  typingHomeChat,
  viewHomeChat,
  waitForHomeChatChannel,
} from "./homeChat";
import { asK2CallId, asSewCallId, type K2CallId, type SewCallId } from "./homeChatCallsPure";
import { parseHomeChatFlags } from "./homeChatPure";

type Opts = { method?: string; query?: Record<string, string>; body?: string; priority?: string; timeoutMs?: number };

const answer = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: typeof body === "string" ? body : JSON.stringify(body),
});
const refuse = (status: number, code: string, hint = "h", details?: Record<string, unknown>) =>
  answer(status, { ok: false, code, hint, error: { code, hint, ...(details ? { details } : {}) }, ...(details ? { details } : {}) });

/** Each request as `[path, method, query, parsed body]`. */
const sent = () =>
  fetchMock.mock.calls.map(([, path, o]) => {
    const opts = (o ?? {}) as Opts;
    return { path: path as string, method: opts.method ?? "GET", query: opts.query, body: opts.body ? JSON.parse(opts.body) : undefined, priority: opts.priority };
  });

let scope: FakeScope;

beforeEach(() => {
  fetchMock.mockReset();
  ensureBootMock.mockReset();
  ensureBootMock.mockResolvedValue(null);
  __resetHomeChatGateForTests();
  scope = fakeScope({ id: "s1", features: ["home-chat-v1"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const sewMsg = { id: "1001", channel_id: "55", author_id: "77", body: "hi", created_at: "2026-11-15T10:00:00Z", seq: 1, nonce: "n1" };

describe("routes: paths, methods, exact bodies", () => {
  it("reads: status, people, channels, summary, messages, since, reactors, members", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(200, { ok: true, on: true, reason: null, flags: { httpTyping: true }, chat: "live" }))
      .mockResolvedValueOnce(answer(200, { ok: true, me: { ext: "k2:connect:a", memberId: "1" }, people: [] }))
      .mockResolvedValueOnce(answer(200, { ok: true, channels: [{ conv: "11", name: "g", open: true }], next: null }))
      .mockResolvedValueOnce(answer(200, { ok: true, chat: "live", convs: [] }))
      .mockResolvedValueOnce(answer(200, { ok: true, conv: "55", page: { items: [sewMsg], has_more: false } }))
      .mockResolvedValueOnce(answer(200, { ok: true, conv: "55", resync: true, page: { items: [sewMsg], has_more: true } }))
      .mockResolvedValueOnce(answer(200, { ok: true, reactors: { items: [{ member_id: "7" }] } }))
      .mockResolvedValueOnce(answer(200, { ok: true, conv: null, slug: "c-x", state: "pending", name: "n", open: false, people: [], agents: [] }));

    const st = await fetchHomeChatStatus(scope);
    expect(st.ok && st.status.on && st.status.flags.httpTyping).toBe(true);
    const ppl = await fetchHomeChatPeople(scope);
    expect(ppl.ok && ppl.me.memberId).toBe("1");
    const ch = await fetchHomeChatChannels(scope, { q: " gen ", after: "10" });
    expect(ch.ok && ch.channels[0].conv).toBe("11");
    const sum = await fetchHomeChatSummary(scope, ["1", "bad", "2"]);
    expect(sum.ok && sum.chat).toBe("live");
    const page = await fetchHomeChatMessages(scope, "55", { before: "2000", limit: 500 });
    expect(page.ok && page.messages[0].id).toBe("1001");
    const since = await fetchHomeChatChangesSince(scope, "55", 12);
    expect(since.ok && since.delta.kind).toBe("resync");
    const rx = await fetchHomeChatReactors(scope, "1001", "👍");
    expect(rx.ok && rx.memberIds).toEqual(["7"]);
    const mem = await fetchHomeChatMembers(scope, { slug: "c-x" });
    expect(mem.ok && mem.members.state).toBe("pending");

    expect(sent()).toEqual([
      { path: "/cli/home-chat/status", method: "GET", query: undefined, body: undefined, priority: "background" },
      { path: "/cli/home-chat/people", method: "GET", query: undefined, body: undefined, priority: "background" },
      { path: "/cli/home-chat/channels", method: "GET", query: { q: "gen", after: "10" }, body: undefined, priority: "background" },
      { path: "/cli/home-chat/summary", method: "GET", query: { convs: "1,2" }, body: undefined, priority: "background" },
      { path: "/cli/home-chat/messages", method: "GET", query: { conv: "55", limit: "100", before: "2000" }, body: undefined, priority: "user" },
      { path: "/cli/home-chat/messages", method: "GET", query: { conv: "55", since: "12" }, body: undefined, priority: "user" },
      { path: "/cli/home-chat/reactors", method: "GET", query: { msg: "1001", emoji: "u:👍" }, body: undefined, priority: "user" },
      { path: "/cli/home-chat/channels/members", method: "GET", query: { slug: "c-x" }, body: undefined, priority: "user" },
    ]);
  });

  it("writes send exactly the keys the daemon takes (deny_unknown_fields)", async () => {
    fetchMock.mockImplementation(async (_s, path: string) => {
      const bodies: Record<string, unknown> = {
        "/cli/home-chat/dm": { ok: true, conv: 55, created: true },
        "/cli/home-chat/send": { ok: true, message: sewMsg },
        "/cli/home-chat/react": { ok: true, message: sewMsg },
        "/cli/home-chat/ack": { ok: true },
        "/cli/home-chat/typing": { ok: true, via: "gateway", sent: true },
        "/cli/home-chat/view": { ok: true, joined: true },
        "/cli/home-chat/channels/create": { ok: true, slug: "c-1", conv: null, state: "pending", name: "ops", open: false },
        "/cli/home-chat/channels/add": { ok: true, results: [{ ext: "k2:owner", outcome: "added" }] },
        "/cli/home-chat/channels/remove": { ok: true, removed: true },
        "/cli/home-chat/channels/leave": { ok: true, left: true },
        "/cli/home-chat/channels/rename": { ok: true },
        "/cli/home-chat/channels/delete": { ok: true, archived: true },
        "/cli/home-chat/channels/allow-agents": { ok: true, allowAgents: true },
      };
      return answer(200, bodies[path]);
    });
    const dm = await openHomeChatDm(scope, " k2:owner ");
    expect(dm).toEqual({ ok: true, conv: "55", created: true });
    const s1 = await sendHomeChatMessage(scope, { conv: "55", text: "hi", nonce: "n1" });
    expect(s1.ok && s1.message?.id).toBe("1001");
    await sendHomeChatMessage(scope, { conv: "55", text: "re", nonce: "n2", replyTo: "990" });
    await reactHomeChat(scope, { conv: "55", msg: "1001", emoji: " 👍 ", on: true });
    expect(await ackHomeChat(scope, "55")).toEqual({ ok: true });
    expect(await typingHomeChat(scope, "55")).toEqual({ ok: true, via: "gateway", sent: true });
    expect(await viewHomeChat(scope, "55", true)).toEqual({ ok: true, joined: true });
    expect(await createHomeChatChannel(scope, { name: " ops ", open: false, members: ["k2:owner"] })).toMatchObject({ ok: true, slug: "c-1", conv: null });
    expect(await addHomeChatPeople(scope, "11", ["k2:owner"])).toEqual({ ok: true, results: [{ ext: "k2:owner", outcome: "added", code: null }] });
    expect(await removeHomeChatPerson(scope, "11", "k2:connect:x")).toEqual({ ok: true, removed: true });
    expect(await leaveHomeChatChannel(scope, "11")).toEqual({ ok: true, left: true });
    expect(await renameHomeChatChannel(scope, "11", " new ")).toEqual({ ok: true });
    expect(await deleteHomeChatChannel(scope, "11")).toEqual({ ok: true, archived: true });
    expect(await setHomeChatAllowAgents(scope, "11", true)).toEqual({ ok: true, allowAgents: true });

    expect(sent().map(({ path, method, body }) => [path, method, body])).toEqual([
      ["/cli/home-chat/dm", "POST", { ext: "k2:owner" }],
      ["/cli/home-chat/send", "POST", { conv: "55", text: "hi", nonce: "n1" }],
      ["/cli/home-chat/send", "POST", { conv: "55", text: "re", nonce: "n2", replyTo: "990" }],
      ["/cli/home-chat/react", "POST", { conv: "55", msg: "1001", emoji: "👍", on: true }],
      ["/cli/home-chat/ack", "POST", { conv: "55" }],
      ["/cli/home-chat/typing", "POST", { conv: "55" }],
      ["/cli/home-chat/view", "POST", { conv: "55", open: true }],
      ["/cli/home-chat/channels/create", "POST", { name: "ops", open: false, members: ["k2:owner"] }],
      ["/cli/home-chat/channels/add", "POST", { conv: "11", ext: ["k2:owner"] }],
      ["/cli/home-chat/channels/remove", "POST", { conv: "11", ext: "k2:connect:x" }],
      ["/cli/home-chat/channels/leave", "POST", { conv: "11" }],
      ["/cli/home-chat/channels/rename", "POST", { conv: "11", name: "new" }],
      ["/cli/home-chat/channels/delete", "POST", { conv: "11" }],
      ["/cli/home-chat/channels/allow-agents", "POST", { conv: "11", on: true }],
    ]);
  });

  it("bad ids and empty sends never reach the server", async () => {
    const results = [
      await fetchHomeChatMessages(scope, "abc"),
      await fetchHomeChatMessages(scope, "55", { before: "x" }),
      await sendHomeChatMessage(scope, { conv: "55", text: "  ", nonce: "n" }),
      await sendHomeChatMessage(scope, { conv: "55", text: "hi", nonce: "" }),
      await sendHomeChatMessage(scope, { conv: "55", text: "hi", nonce: "n", replyTo: "../x" }),
      await reactHomeChat(scope, { conv: "55", msg: "1", emoji: "", on: true }),
      await fetchHomeChatMembers(scope, { slug: "nope" }),
      await createHomeChatChannel(scope, { name: " ", open: true, members: [] }),
      await createHomeChatChannel(scope, { name: "x".repeat(101), open: true, members: [] }),
      await fetchHomeChatChangesSince(scope, "55", -1),
      await openHomeChatDm(scope, "  "),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, kind: "usage" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("client-side failures: network, not connected, removed, not JSON", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Request timed out"));
    expect(await fetchHomeChatPeople(scope)).toMatchObject({ ok: false, kind: "network", hint: "Request timed out" });
    fetchMock.mockRejectedValueOnce(new Error("Not connected"));
    expect(await fetchHomeChatPeople(scope)).toMatchObject({ ok: false, kind: "not_connected" });
    const gone = new Error("Lab was removed from this phone");
    gone.name = "ServerRemovedError";
    fetchMock.mockRejectedValueOnce(gone);
    expect(await fetchHomeChatPeople(scope)).toMatchObject({ ok: false, kind: "removed" });
    fetchMock.mockResolvedValueOnce(answer(200, "<html>portal</html>"));
    expect(await fetchHomeChatPeople(scope)).toMatchObject({ ok: false, kind: "bad_response", status: 200 });
  });

  it("refusals come back typed (never thrown)", async () => {
    fetchMock.mockResolvedValueOnce(refuse(403, "person_login_required"));
    expect(await fetchHomeChatPeople(scope)).toMatchObject({ ok: false, kind: "wrong_login", code: "person_login_required", status: 403 });
    fetchMock.mockResolvedValueOnce(refuse(503, "chat_member_pending", "soon", { retry_after_ms: 2000 }));
    expect(await openHomeChatDm(scope, "k2:connect:x")).toMatchObject({ ok: false, kind: "retry", retryAfterMs: 2000 });
    fetchMock.mockResolvedValueOnce(refuse(409, "channel_open"));
    expect(await removeHomeChatPerson(scope, "11", "k2:connect:x")).toMatchObject({ ok: false, kind: "conflict", code: "channel_open" });
  });

  it("waitForHomeChatChannel polls by slug until the id shows, or gives up at 30 s", async () => {
    let t = 0;
    const deps = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const pending = answer(200, { ok: true, conv: null, slug: "c-1", state: "pending", name: "n", open: false });
    fetchMock.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(answer(200, { ok: true, conv: "77", slug: "c-1", state: "active" }));
    expect(await waitForHomeChatChannel(scope, "c-1", deps)).toEqual({ ok: true, conv: "77" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(t).toBe(2_000);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(pending);
    t = 0;
    expect(await waitForHomeChatChannel(scope, "c-1", deps)).toEqual({ ok: true, conv: null });
    expect(t).toBe(30_000);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(refuse(404, "channel_not_found"));
    expect(await waitForHomeChatChannel(scope, "c-1", deps)).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("DM calls", () => {
  it("join posts {dm, join}, keeps K2's and Sew's ids apart, and never returns the media join", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(200, {
        ok: true,
        callId: "vc_0a1b",
        dm: "55",
        room: { id: "dm:55", kind: "dm", channelId: "55" },
        call: { id: "4242", channel_id: "55", state: "ringing" },
        created: true,
        relayOnly: false,
        heldMs: 0,
        join: { url: "wss://voice.x", token: "MEDIA-TOKEN" },
      })
    );
    const r = await joinDmCall(scope, "55", { join: { self_mute: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.callId).toBe("vc_0a1b");
    expect(r.answer.sewCallId).toBe("4242");
    expect(JSON.stringify(r)).not.toContain("MEDIA-TOKEN");
    expect(sent()[0]).toMatchObject({ path: "/cli/voice/join", method: "POST", body: { dm: "55", join: { self_mute: true } } });
    expect((fetchMock.mock.calls[0][2] as Opts).timeoutMs).toBeGreaterThanOrEqual(20_000);
  });

  it("decline / ring / cancel take Sew's id; leave takes K2's", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(200, { ok: true, declined: true, callId: "4242" }))
      .mockResolvedValueOnce(answer(200, { ok: true, rung: true, callId: "4242", sew: {} }))
      .mockResolvedValueOnce(answer(200, { ok: true, cancelled: false, via: "leave", callId: "4242", hint: "missed" }))
      .mockResolvedValueOnce(answer(200, { ok: true, left: true, already: false, room: "dm:55" }));
    const sew = asSewCallId("4242") as SewCallId;
    const k2 = asK2CallId("vc_0a1b") as K2CallId;
    expect(await declineDmCall(scope, "55", sew)).toEqual({ ok: true, declined: true });
    expect(await ringDmCallAgain(scope, "55", sew, ["88"])).toEqual({ ok: true, rung: true });
    expect(await cancelDmCall(scope, "55", sew)).toEqual({ ok: true, cancelled: false, via: "leave", callId: "4242", hint: "missed" });
    expect(await leaveDmCall(scope, k2)).toEqual({ ok: true, left: true, already: false, why: null, room: "dm:55" });
    expect(sent().map(({ path, body }) => [path, body])).toEqual([
      ["/cli/voice/call/decline", { dm: "55", callId: "4242" }],
      ["/cli/voice/call/ring", { dm: "55", callId: "4242", memberIds: ["88"] }],
      ["/cli/voice/call/cancel", { dm: "55", callId: "4242" }],
      ["/cli/voice/call/leave", { callId: "vc_0a1b" }],
    ]);
    // Type-level only (never run): each id goes only where it belongs.
    const typeOnly = () => {
      // @ts-expect-error K2's call id is not Sew's.
      void declineDmCall(scope, "55", k2);
      // @ts-expect-error Sew's call id is not K2's.
      void leaveDmCall(scope, sew);
    };
    expect(typeof typeOnly).toBe("function");
  });

  it("maps the DM call gates", async () => {
    const codes: Array<[ReturnType<typeof refuse>, string]> = [
      [refuse(503, "chat_unavailable", "calls aren't available on this server (mac)"), "unavailable"],
      [refuse(403, "host_not_pro"), "plan"],
      [refuse(503, "voice_unavailable", "down", { retry_after_ms: 2000 }), "retry"],
      [refuse(404, "dm_not_found"), "not_found"],
      [answer(404, { error: "route not found" }), "not_supported"],
    ];
    for (const [res, kind] of codes) {
      fetchMock.mockResolvedValueOnce(res);
      expect(await joinDmCall(scope, "55")).toMatchObject({ ok: false, kind });
    }
  });
});

describe("the gate: home-chat-v1 AND status.on, never assumed", () => {
  const on = answer(200, { ok: true, on: true, reason: null, flags: { callCancel: true }, chat: "live" });

  it("feature missing: not offered, status never asked (boot re-read once)", async () => {
    scope.setFeatures([]);
    expect(await homeChatOffered(scope)).toBe(false);
    expect(ensureBootMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const g = homeChatGateNow(scope);
    expect(g).toMatchObject({ offered: false, feature: false, on: null, reason: null, pickerLine: null });
  });

  it("feature appears after the boot re-read: then status decides", async () => {
    scope.setFeatures(null);
    ensureBootMock.mockImplementation(async () => {
      scope.setFeatures(["home-chat-v1"]);
      return null;
    });
    fetchMock.mockResolvedValueOnce(on);
    expect(await homeChatOffered(scope)).toBe(true);
  });

  it("feature + status on: offered, with flags and chat", async () => {
    fetchMock.mockResolvedValueOnce(on);
    const g = await refreshHomeChatGate(scope);
    expect(g).toMatchObject({ offered: true, feature: true, on: true, reason: null, chat: "live", pickerLine: null });
    expect(g.flags.callCancel).toBe(true);
    expect(ensureBootMock).not.toHaveBeenCalled();
  });

  it.each([
    ["mac", answer(200, { ok: true, on: false, reason: "mac", flags: {}, chat: null }), "No chat on this server (chat runs on Linux servers)."],
    ["space_pending", answer(200, { ok: true, on: false, reason: "space_pending", flags: {}, chat: null }), "Chat is still being set up on this server."],
    ["sew_off", answer(200, { ok: true, on: false, reason: "sew_off", flags: {}, chat: null }), "No chat on this server."],
    ["off", refuse(404, "home_chat_off"), "No chat on this server."],
  ])("status off (%s): not offered, reason and picker line", async (reason, res, line) => {
    fetchMock.mockResolvedValueOnce(res);
    const g = await refreshHomeChatGate(scope);
    expect(g).toMatchObject({ offered: false, feature: true, on: false, reason, pickerLine: line });
  });

  it("an older server (plain 404) or a non-person login: not offered", async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { error: "route not found" }));
    expect(await homeChatOffered(scope)).toBe(false);
    expect(homeChatGateNow(scope).refusal?.kind).toBe("not_supported");
    fetchMock.mockResolvedValueOnce(refuse(403, "person_login_required"));
    const g = await refreshHomeChatGate(scope, { force: true });
    expect(g).toMatchObject({ offered: false, refusal: { kind: "wrong_login" } });
  });

  it("caches per server: fresh for 2 min, single-flight, per-server", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(on);
    const [a, b] = await Promise.all([homeChatOffered(scope), homeChatOffered(scope)]);
    expect(a && b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOME_CHAT_GATE_FRESH_MS - 1);
    await homeChatOffered(scope);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await homeChatOffered(scope);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Another server has its own gate.
    const other = fakeScope({ id: "s2", features: ["home-chat-v1"] });
    expect(homeChatGateNow(other).offered).toBe(false);
    await homeChatOffered(other);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a blip keeps what was known and asks again after 15 s", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(on);
    await refreshHomeChatGate(scope);
    vi.advanceTimersByTime(HOME_CHAT_GATE_FRESH_MS);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const g = await refreshHomeChatGate(scope);
    expect(g).toMatchObject({ offered: true, refusal: { kind: "network" } });
    fetchMock.mockResolvedValueOnce(on);
    await refreshHomeChatGate(scope);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(HOME_CHAT_GATE_RETRY_MS);
    await refreshHomeChatGate(scope);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("the feature leaving /boot-status closes the gate at once", async () => {
    fetchMock.mockResolvedValueOnce(on);
    await refreshHomeChatGate(scope);
    scope.setFeatures([]);
    expect(homeChatGateNow(scope).offered).toBe(false);
  });

  it("a route's home_chat_off or chat_unavailable closes the gate and tells listeners", async () => {
    fetchMock.mockResolvedValueOnce(on);
    await refreshHomeChatGate(scope);
    const heard: boolean[] = [];
    const stop = onHomeChatGate((id, g) => id === "s1" && heard.push(g.offered));
    fetchMock.mockResolvedValueOnce(refuse(503, "chat_unavailable", "chat isn't available on this server (sew_off)"));
    await fetchHomeChatSummary(scope);
    expect(homeChatGateNow(scope)).toMatchObject({ offered: false, reason: "sew_off" });
    expect(heard).toEqual([false]);
    // Not a closing refusal: a transient one keeps it closed/open as it was.
    fetchMock.mockResolvedValueOnce(on);
    await refreshHomeChatGate(scope, { force: true });
    fetchMock.mockResolvedValueOnce(refuse(503, "chat_unavailable", "K2 could not reach this server's chat: x", { retry_after_ms: 2000 }));
    await fetchHomeChatSummary(scope);
    expect(homeChatGateNow(scope).offered).toBe(true);
    stop();
  });

  it("the socket's hello updates flags and chat on an open gate, never opens a closed one", async () => {
    const flags = parseHomeChatFlags({ httpTyping: true, readStateUnreadCount: true });
    noteHomeChatLink(scope, { flags, chat: "live" });
    expect(homeChatGateNow(scope).offered).toBe(false);
    fetchMock.mockResolvedValueOnce(answer(200, { ok: true, on: true, reason: null, flags: {}, chat: "connecting" }));
    await refreshHomeChatGate(scope);
    noteHomeChatLink(scope, { flags, chat: "live" });
    expect(homeChatGateNow(scope)).toMatchObject({ chat: "live", flags: { httpTyping: true, readStateUnreadCount: true } });
  });
});
