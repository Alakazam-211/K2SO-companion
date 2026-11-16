import { describe, expect, it } from "vitest";
import {
  HOME_CHAT_COPY_MAC,
  HOME_CHAT_COPY_NO_CHAT,
  HOME_CHAT_COPY_SPACE_PENDING,
  compareSewIds,
  homeChatBadgeText,
  homeChatNoChatLine,
  parseHomeChatAddResults,
  parseHomeChatBadge,
  parseHomeChatChannels,
  parseHomeChatCreated,
  parseHomeChatDelta,
  parseHomeChatFlags,
  parseHomeChatMembers,
  parseHomeChatMessage,
  parseHomeChatPage,
  parseHomeChatPeople,
  parseHomeChatReactors,
  parseHomeChatRefusal,
  parseHomeChatStatus,
  parseHomeChatSummary,
  refusalClosesGate,
} from "./homeChatPure";
import {
  asK2CallId,
  asSewCallId,
  callRecordLine,
  convOfDmRoom,
  dmJoinBody,
  dmRoomId,
  parseCall,
  parseCallSummary,
  parseDmCancelAnswer,
  parseDmJoinAnswer,
  parseDmLeaveAnswer,
  parseHelloCall,
  parseRing,
} from "./homeChatCallsPure";

const JUNK: unknown[] = [null, undefined, 0, 1, "x", true, [], [1, 2], { nope: 1 }];

const sewMsg = (over: Record<string, unknown> = {}) => ({
  id: "1001",
  channel_id: "55",
  author_id: "77",
  body: "hi **there**",
  created_at: "2026-11-15T10:00:00Z",
  seq: 12,
  reactions: [
    { emoji: { kind: "unicode", value: "👍" }, count: 2, me: true },
    { emoji: { kind: "custom", id: "9" }, count: 1, me: false },
    { emoji: { kind: "unicode", value: "🎉" }, count: 0, me: false },
  ],
  reference: { message_id: "990", kind: "reply" },
  deleted_at: null,
  nonce: "n-1",
  ...over,
});

describe("status and flags", () => {
  it("reads on/off, reason, camelCase flags and chat; unknown flags ignored", () => {
    const s = parseHomeChatStatus({
      ok: true,
      on: false,
      reason: "mac",
      chat: null,
      flags: { httpTyping: true, callCancel: "yes", readStateUnreadCount: true, futureThing: true },
    });
    expect(s).toEqual({
      on: false,
      reason: "mac",
      chat: null,
      flags: {
        channelMemberAddRemove: false,
        channelMembersCanLeave: false,
        httpTyping: true,
        readStateUnreadCount: true,
        memberChannelsLevelOnly: false,
        agentsDmWithBoxPeople: false,
        callCancel: false,
      },
    });
    expect(parseHomeChatStatus({ on: true, reason: "off", chat: "live", flags: null })).toMatchObject({
      on: true,
      reason: null,
      chat: "live",
    });
  });

  it("junk status is null (no `on`)", () => {
    for (const j of JUNK) expect(parseHomeChatStatus(j)).toBeNull();
    expect(parseHomeChatStatus({ on: "true" })).toBeNull();
    expect(parseHomeChatFlags("x").httpTyping).toBe(false);
  });

  it("the desktop's picker copy per reason", () => {
    expect(homeChatNoChatLine("mac")).toBe("No chat on this server (chat runs on Linux servers).");
    expect(homeChatNoChatLine("space_pending")).toBe("Chat is still being set up on this server.");
    expect(homeChatNoChatLine("off")).toBe(HOME_CHAT_COPY_NO_CHAT);
    expect(homeChatNoChatLine(null)).toBe(HOME_CHAT_COPY_NO_CHAT);
    expect(HOME_CHAT_COPY_MAC).toContain("Linux");
    expect(HOME_CHAT_COPY_SPACE_PENDING).toContain("set up");
  });
});

describe("people and channels", () => {
  it("people: me, ready, role only when sent, display name falls back to username", () => {
    const p = parseHomeChatPeople({
      ok: true,
      me: { ext: "k2:connect:abc", memberId: 123 },
      people: [
        { ext: "k2:owner", username: "owner", displayName: "Riley Stone", picture: null, ready: true, memberId: "77", role: "owner" },
        { ext: "k2:connect:x", username: "sam", ready: false, memberId: null, picture: "https://evil/x.png" },
        { username: "no-ext" },
        "junk",
      ],
    });
    expect(p.me).toEqual({ ext: "k2:connect:abc", memberId: "123" });
    expect(p.people).toEqual([
      { ext: "k2:owner", username: "owner", displayName: "Riley Stone", picture: null, role: "owner", ready: true, memberId: "77" },
      { ext: "k2:connect:x", username: "sam", displayName: "sam", picture: null, role: null, ready: false, memberId: null },
    ]);
    for (const j of JUNK) expect(parseHomeChatPeople(j)).toEqual({ me: { ext: "", memberId: null }, people: [] });
  });

  it("channels: inviteOnly as sent, else the inverse of open; next cursor", () => {
    const c = parseHomeChatChannels({
      ok: true,
      channels: [
        { conv: "11", name: "general", open: true, inviteOnly: false, archived: false, home: true, allowAgents: false },
        { conv: 12, name: "", open: false },
        { name: "no id" },
      ],
      next: "12",
    });
    expect(c.channels).toEqual([
      { conv: "11", name: "general", open: true, inviteOnly: false, archived: false, home: true, allowAgents: false },
      { conv: "12", name: "12", open: false, inviteOnly: true, archived: false, home: false, allowAgents: false },
    ]);
    expect(c.next).toBe("12");
    for (const j of JUNK) expect(parseHomeChatChannels(j)).toEqual({ channels: [], next: null });
  });

  it("members (by slug while pending), create, add outcomes", () => {
    expect(
      parseHomeChatMembers({
        ok: true,
        conv: null,
        slug: "c-abc",
        state: "pending",
        name: "ops",
        open: false,
        inviteOnly: true,
        creator: "k2:owner",
        allowAgents: false,
        people: [{ ext: "k2:owner", state: "in" }, { state: "x" }],
        agents: [],
      })
    ).toEqual({
      conv: null,
      slug: "c-abc",
      state: "pending",
      name: "ops",
      open: false,
      inviteOnly: true,
      creator: "k2:owner",
      allowAgents: false,
      people: [{ ext: "k2:owner", state: "in" }],
      agents: [],
    });
    for (const j of JUNK) expect(parseHomeChatMembers(j)).toBeNull();
    expect(parseHomeChatCreated({ ok: true, slug: "c-1", conv: null, state: "pending", name: "ops", open: true })).toEqual({
      slug: "c-1",
      conv: null,
      state: "pending",
      name: "ops",
      open: true,
    });
    expect(parseHomeChatCreated({ conv: "1" })).toBeNull();
    expect(
      parseHomeChatAddResults({
        results: [
          { ext: "a", outcome: "added" },
          { ext: "b", outcome: "already" },
          { ext: "c", outcome: "refused: target_disabled" },
          { outcome: "added" },
        ],
      })
    ).toEqual([
      { ext: "a", outcome: "added", code: null },
      { ext: "b", outcome: "already", code: null },
      { ext: "c", outcome: "refused", code: "target_disabled" },
    ]);
  });
});

describe("summary and badges", () => {
  it("rows, badges, `with`, inviteOnly only for channels; chat defaults to unavailable", () => {
    const s = parseHomeChatSummary({
      ok: true,
      chat: "live",
      convs: [
        { conv: "1", kind: "dm", unread: true, badge: { kind: "count", n: 3 }, lastAt: "2026-11-15T10:00:00Z", lastMessageId: "9", with: "k2:owner", inviteOnly: true },
        { conv: "2", kind: "channel", unread: true, badge: { kind: "dot" }, lastAt: null, lastMessageId: null, inviteOnly: null },
        { conv: "3", kind: "channel", badge: { kind: "count", n: 0 }, inviteOnly: true },
        { kind: "dm" },
      ],
    });
    expect(s.chat).toBe("live");
    expect(s.convs).toHaveLength(3);
    expect(s.convs[0]).toMatchObject({ kind: "dm", with: "k2:owner", inviteOnly: null, badge: { kind: "count", n: 3 }, lastAtMs: Date.parse("2026-11-15T10:00:00Z") });
    expect(s.convs[1]).toMatchObject({ kind: "channel", badge: { kind: "dot" }, inviteOnly: null, with: null });
    expect(s.convs[2]).toMatchObject({ badge: { kind: "none" }, inviteOnly: true, unread: false });
    expect(parseHomeChatSummary({ chat: "weird", convs: "x" })).toEqual({ chat: "unavailable", convs: [] });
  });

  it("a badge caps at 99 and reads 99+", () => {
    expect(parseHomeChatBadge({ kind: "count", n: 500 })).toEqual({ kind: "count", n: 99 });
    expect(homeChatBadgeText({ kind: "count", n: 99 })).toBe("99+");
    expect(homeChatBadgeText({ kind: "count", n: 7 })).toBe("7");
    expect(homeChatBadgeText({ kind: "dot" })).toBe("");
    expect(homeChatBadgeText({ kind: "none" })).toBeNull();
    for (const j of JUNK) expect(parseHomeChatBadge(j)).toEqual({ kind: "none" });
  });
});

describe("messages", () => {
  it("a Sew message: reactions (unicode, count > 0), reply, nonce, ms times", () => {
    const m = parseHomeChatMessage(sewMsg({ edited_at: "2026-11-15T10:05:00Z" }));
    expect(m).toEqual({
      id: "1001",
      conv: "55",
      authorId: "77",
      body: "hi **there**",
      createdAtMs: Date.parse("2026-11-15T10:00:00Z"),
      seq: 12,
      reactions: [{ emoji: "👍", count: 2, me: true }],
      replyTo: "990",
      edited: true,
      editedAtMs: Date.parse("2026-11-15T10:05:00Z"),
      deleted: false,
      nonce: "n-1",
      call: null,
    });
  });

  it("deleted keeps its place with no words; a non-reply reference is not a reply", () => {
    const m = parseHomeChatMessage(sewMsg({ deleted_at: "2026-11-15T11:00:00Z", reference: { message_id: "1", kind: "forward" } }));
    expect(m).toMatchObject({ deleted: true, body: "", reactions: [], replyTo: null, edited: false });
  });

  it("junk messages are null; a missing body or author reads empty", () => {
    for (const j of JUNK) expect(parseHomeChatMessage(j)).toBeNull();
    expect(parseHomeChatMessage({ id: "1" })).toBeNull();
    expect(parseHomeChatMessage({ id: "1", channel_id: "2" })).toMatchObject({ body: "", authorId: "", createdAtMs: 0, reactions: [] });
  });

  it("a call's record rides on the message", () => {
    const m = parseHomeChatMessage(sewMsg({ call: { call_id: "4242", ended_at: "x", end_reason: "no_answer", missed_ids: ["9"] } }));
    expect(m?.call).toMatchObject({ callId: "4242", ended: true, missedIds: ["9"] });
  });

  it("pages sort numerically by id, oldest first (length, then string)", () => {
    const p = parseHomeChatPage({
      ok: true,
      conv: "55",
      page: { items: [sewMsg({ id: "100" }), sewMsg({ id: "99" }), sewMsg({ id: "1000" }), { junk: 1 }], has_more: true },
    });
    expect(p.messages.map((m) => m.id)).toEqual(["99", "100", "1000"]);
    expect(p.hasMore).toBe(true);
    expect(p.conv).toBe("55");
    expect(parseHomeChatPage({ page: [sewMsg()] }).hasMore).toBe(false);
    for (const j of JUNK) expect(parseHomeChatPage(j)).toEqual({ conv: null, messages: [], hasMore: false });
    expect(compareSewIds("9", "10")).toBeLessThan(0);
    expect(compareSewIds("20", "10")).toBeGreaterThan(0);
  });

  it("since: changes, or resync with the newest page", () => {
    const d = parseHomeChatDelta({
      ok: true,
      conv: "55",
      changes: { entries: [{ seq: 13, kind: "message", entity_id: "1002", message: sewMsg({ id: "1002" }) }, "x"], next_since: 13, has_more: false },
    });
    expect(d).toMatchObject({ kind: "changes", conv: "55", nextSince: 13, hasMore: false });
    if (d.kind === "changes") {
      expect(d.changes).toHaveLength(1);
      expect(d.changes[0]).toMatchObject({ seq: 13, kind: "message", entityId: "1002", message: { id: "1002" } });
    }
    const r = parseHomeChatDelta({ ok: true, conv: "55", resync: true, page: { items: [sewMsg()], has_more: true } });
    expect(r).toMatchObject({ kind: "resync", page: { hasMore: true, messages: [{ id: "1001" }] } });
    for (const j of JUNK) expect(parseHomeChatDelta(j).kind).toBe("changes");
  });

  it("reactors: member ids", () => {
    expect(parseHomeChatReactors({ ok: true, reactors: { items: [{ member_id: "7" }, { member_id: 8 }, {}], next: null } })).toEqual({
      memberIds: ["7", "8"],
      next: null,
    });
    for (const j of JUNK) expect(parseHomeChatReactors(j).memberIds).toEqual([]);
  });
});

describe("refusals", () => {
  const k2 = (status: number, code: string, hint = "h", details?: Record<string, unknown>) =>
    [
      status,
      JSON.stringify({ ok: false, code, hint, error: { code, hint, ...(details ? { details } : {}) }, ...(details ? { details } : {}) }),
    ] as const;

  const cases: Array<[readonly [number, string], string, string]> = [
    [[404, JSON.stringify({ error: "route not found" })], "not_supported", "not_supported"],
    [[404, "Not Found"], "not_supported", "not_supported"],
    [k2(404, "not_found"), "not_supported", "not_supported"],
    [k2(404, "home_chat_off"), "off", "home_chat_off"],
    [k2(404, "voice_rooms_off"), "off", "voice_rooms_off"],
    [k2(503, "chat_unavailable", "chat isn't available on this server (mac)"), "unavailable", "chat_unavailable"],
    [k2(403, "person_login_required"), "wrong_login", "person_login_required"],
    [k2(403, "agents_use_k2_chat"), "wrong_login", "agents_use_k2_chat"],
    [k2(403, "app_session_not_allowed"), "wrong_login", "app_session_not_allowed"],
    [k2(401, "unauthenticated"), "auth", "unauthenticated"],
    [k2(403, "device_session_ended"), "auth", "device_session_ended"],
    [[401, ""], "auth", "unauthenticated"],
    [[403, JSON.stringify({ error: "Invalid or missing auth token" })], "auth", "unauthenticated"],
    [k2(403, "host_not_pro"), "plan", "host_not_pro"],
    [k2(503, "voice_unavailable", "lane down", { retry_after_ms: 2000 }), "retry", "voice_unavailable"],
    [k2(404, "dm_not_found"), "not_found", "dm_not_found"],
    [k2(404, "channel_not_found"), "not_found", "channel_not_found"],
    [k2(404, "person_not_found"), "not_found", "person_not_found"],
    [k2(403, "not_a_member"), "denied", "not_a_member"],
    [k2(403, "admin_required"), "denied", "admin_required"],
    [k2(403, "not_creator"), "denied", "not_creator"],
    [k2(403, "target_disabled"), "denied", "target_disabled"],
    [k2(403, "not_a_person"), "denied", "not_a_person"],
    [k2(409, "channel_open"), "conflict", "channel_open"],
    [k2(409, "channel_archived"), "conflict", "channel_archived"],
    [k2(503, "chat_member_pending", "soon", { retry_after_ms: 2000 }), "retry", "chat_member_pending"],
    [k2(429, "too_many_sockets"), "retry", "too_many_sockets"],
    [k2(400, "usage"), "usage", "usage"],
    [k2(405, "method_not_allowed"), "usage", "method_not_allowed"],
    [[405, JSON.stringify({ error: "POST required" })], "usage", "http_405"],
    [k2(500, "internal"), "server", "internal"],
    [k2(502, "sew_error"), "server", "sew_error"],
    [k2(403, "something_new"), "denied", "something_new"],
    [k2(418, "teapot"), "usage", "teapot"],
    [[500, "<html>oops</html>"], "server", "http_500"],
  ];

  it.each(cases)("%j → %s / %s", ([status, text], kind, code) => {
    const r = parseHomeChatRefusal(status, text);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe(kind);
    expect(r.code).toBe(code);
    expect(r.status).toBe(status);
  });

  it("keeps hint, details, retryAfterMs and the chat_unavailable reason", () => {
    const r = parseHomeChatRefusal(
      503,
      JSON.stringify({
        ok: false,
        code: "chat_unavailable",
        hint: "chat isn't available on this server (space_pending)",
        error: { code: "chat_unavailable", hint: "chat isn't available on this server (space_pending)" },
      })
    );
    expect(r).toMatchObject({ kind: "unavailable", reason: "space_pending", hint: "chat isn't available on this server (space_pending)" });
    expect(r.retryAfterMs).toBeUndefined();
    const calls = parseHomeChatRefusal(503, JSON.stringify({ ok: false, code: "chat_unavailable", hint: "calls aren't available on this server (sew_off)" }));
    expect(calls.reason).toBe("sew_off");
    const space = parseHomeChatRefusal(503, JSON.stringify({ ok: false, code: "chat_unavailable", hint: "the K5 Space isn't ready yet" }));
    expect(space.reason).toBe("space_pending");
    const pend = parseHomeChatRefusal(
      503,
      JSON.stringify({ ok: false, code: "chat_member_pending", hint: "soon", details: { retry_after_ms: 2000 }, error: { code: "chat_member_pending", hint: "soon", details: { retry_after_ms: 2000 } } })
    );
    expect(pend.retryAfterMs).toBe(2000);
    const voice = parseHomeChatRefusal(503, JSON.stringify({ ok: false, code: "voice_unavailable", hint: "x", details: { reason: "voice_unavailable", heldMs: 5, retry_after_ms: 2000 } }));
    expect(voice).toMatchObject({ kind: "retry", reason: "voice_unavailable", retryAfterMs: 2000, details: { heldMs: 5 } });
  });

  it("a transient chat_unavailable (Sew unreachable, with a retry) is retry and keeps the gate", () => {
    const r = parseHomeChatRefusal(
      503,
      JSON.stringify({ ok: false, code: "chat_unavailable", hint: "K2 could not reach this server's chat: refused", details: { retry_after_ms: 2000 } })
    );
    expect(r.kind).toBe("retry");
    expect(r.code).toBe("chat_unavailable");
    expect(refusalClosesGate(r)).toBe(false);
  });

  it("off and unavailable close the gate; not_supported from a route doesn't", () => {
    expect(refusalClosesGate(parseHomeChatRefusal(...k2(404, "home_chat_off")))).toBe(true);
    expect(refusalClosesGate(parseHomeChatRefusal(...k2(503, "chat_unavailable", "chat isn't available on this server (off)")))).toBe(true);
    expect(refusalClosesGate(parseHomeChatRefusal(404, "{}"))).toBe(false);
    expect(refusalClosesGate(parseHomeChatRefusal(...k2(403, "not_a_member")))).toBe(false);
  });
});

describe("DM calls: the two ids stay apart", () => {
  it("Sew's id is digits; K2's is vc_…; each refuses the other", () => {
    expect(asSewCallId("4242")).toBe("4242");
    expect(asSewCallId(4242)).toBe("4242");
    expect(asSewCallId("vc_abc")).toBeNull();
    expect(asK2CallId("vc_abc")).toBe("vc_abc");
    expect(asK2CallId("4242")).toBeNull();
    for (const j of JUNK) expect(asK2CallId(j)).toBeNull();
  });

  it("the join answer keeps vc_ callId and call.id apart, and drops Sew's media join", () => {
    const a = parseDmJoinAnswer({
      ok: true,
      callId: "vc_9f",
      dm: "55",
      room: { id: "dm:55", kind: "dm", channelId: "55" },
      call: { id: "4242", channel_id: "55", started_by: "77", state: "ringing", participant_ids: ["77"], rings: [{ member_id: "88", state: "ringing" }] },
      created: true,
      relayOnly: false,
      heldMs: 0,
      join: { url: "wss://voice.x", token: "SECRET", call_credential: "CRED" },
      server: "riley",
    });
    expect(a).toMatchObject({ callId: "vc_9f", sewCallId: "4242", dm: "55", room: { id: "dm:55", kind: "dm", channelId: "55" }, created: true, server: "riley" });
    expect(a?.call).toMatchObject({ callId: "4242", conv: "55", state: "ringing", ended: false, rings: [{ memberId: "88", state: "ringing" }] });
    expect(JSON.stringify(a)).not.toContain("SECRET");
    expect(JSON.stringify(a)).not.toContain("CRED");
    for (const j of JUNK) expect(parseDmJoinAnswer(j)).toBeNull();
    expect(parseDmJoinAnswer({ callId: "4242", dm: "55" })).toBeNull();
  });

  it("join body, room ids", () => {
    expect(dmJoinBody("55")).toEqual({ dm: "55", join: {} });
    expect(dmJoinBody("55", { self_mute: true }, true)).toEqual({ dm: "55", join: { self_mute: true }, callAnswer: true });
    expect(dmRoomId("55")).toBe("dm:55");
    expect(convOfDmRoom("dm:55")).toBe("55");
    expect(convOfDmRoom("room-1")).toBeNull();
    expect(convOfDmRoom("dm:")).toBeNull();
  });

  it("cancel answers: a real cancel, or a leave without Sew's callCancel", () => {
    expect(parseDmCancelAnswer({ ok: true, cancelled: true, via: "cancel", callId: "4242" })).toEqual({ cancelled: true, via: "cancel", callId: "4242", hint: null });
    expect(parseDmCancelAnswer({ ok: true, cancelled: false, via: "leave", callId: "4242", hint: "they see a missed call" })).toMatchObject({ cancelled: false, via: "leave", hint: "they see a missed call" });
    expect(parseDmLeaveAnswer({ ok: true, left: true, already: true, why: "call_ended", room: "dm:55" })).toEqual({ left: true, already: true, why: "call_ended", room: "dm:55" });
    expect(parseDmLeaveAnswer(null)).toEqual({ left: false, already: false, why: null, room: null });
  });

  it("rings, calls and hello calls; junk is null", () => {
    expect(parseRing({ call_id: "4242", channel_id: "55", started_by: "77", ringing: false, silent: true, reason: "cancelled", expires_at: "2026-11-15T10:00:45Z" })).toEqual({
      callId: "4242",
      conv: "55",
      startedBy: "77",
      ringing: false,
      silent: true,
      reason: "cancelled",
      expiresAtMs: Date.parse("2026-11-15T10:00:45Z"),
    });
    expect(parseCall({ call: { id: "1", channel_id: "2", state: "ended", end_reason: "declined" } })).toMatchObject({ ended: true, endReason: "declined" });
    expect(parseHelloCall({ callId: "4242", conv: "55", startedBy: "77", ringing: true, silent: false, expiresAt: null, call: null })).toMatchObject({
      ring: { callId: "4242", conv: "55", ringing: true },
      call: null,
    });
    for (const j of JUNK) {
      expect(parseRing(j)).toBeNull();
      expect(parseCall(j)).toBeNull();
      expect(parseHelloCall(j)).toBeNull();
      expect(parseCallSummary(j)).toBeNull();
    }
  });

  it("the record line: cancelled is never missed", () => {
    const base = parseCallSummary({ call_id: "1", ended_at: "x", missed_ids: ["9"] })!;
    expect(callRecordLine(base, "9").text).toBe("Missed call");
    expect(callRecordLine({ ...base, endReason: "cancelled" }, "9").text).toBe("Cancelled");
    expect(callRecordLine({ ...base, missedIds: [], joinedIds: ["1", "2"], durationMs: 64_000 }, "9").text).toBe("Call · 1:04");
    expect(callRecordLine({ ...base, ended: false }, "9")).toEqual({ kind: "live", text: "Call in progress", callBack: false });
  });
});
