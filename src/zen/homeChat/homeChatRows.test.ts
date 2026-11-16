import { describe, expect, it } from "vitest";
import type { HomeChatGate } from "../../api/homeChat";
import { HOME_CHAT_COPY_MAC, HOME_CHAT_COPY_NO_CHAT, NO_HOME_CHAT_FLAGS, type HomeChatSummary } from "../../api/homeChatPure";
import { unreadCountText } from "../unread";
import {
  PERSON_COLORS,
  badgeUnread,
  channelInviteOnly,
  channelRow,
  chatRowLine,
  chatRowParts,
  chatRowQuiet,
  matchesElsewhere,
  mightBeSamePerson,
  personColor,
  personInitials,
  personInk,
  personRow,
  pickablePerson,
  relativeLuminance,
  samePersonCopy,
  summaryRowFor,
} from "./homeChatRows";

const gate = (over: Partial<HomeChatGate>): HomeChatGate => ({
  offered: false,
  feature: true,
  on: null,
  reason: null,
  flags: { ...NO_HOME_CHAT_FLAGS },
  chat: null,
  checkedAt: 1,
  refusal: null,
  pickerLine: null,
  ...over,
});

describe("person colour (brief §2.5, §5 item 9)", () => {
  it("hashes the username like the daemon: h = (h*31 + unit) >>> 0, % 8", () => {
    const ref = (s: string) => {
      let h = 0;
      for (const ch of s.split("")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return PERSON_COLORS[h % 8];
    };
    for (const u of ["owner", "ana", "ben", "chloe", "a-very-long-username-to-overflow-32-bits"]) {
      expect(personColor(u)).toBe(ref(u));
    }
    // A known value: "a" is 97 → 97 % 8 = 1 → petrol.
    expect(personColor("a")).toBe("#3a87a8");
    expect(personColor("")).toBe(PERSON_COLORS[0]);
  });

  it("takes black or white ink, whichever contrasts more; every hue clears 4.5:1", () => {
    for (const c of PERSON_COLORS) {
      const ink = personInk(c);
      const l = relativeLuminance(c);
      const ratio = ink === "#ffffff" ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    expect(personInk("#000000")).toBe("#ffffff");
    expect(personInk("#ffffff")).toBe("#000000");
  });

  it("initials: two parts give two letters; owner reads Owner", () => {
    expect(personInitials("Ana Ruiz")).toBe("AR");
    expect(personInitials("chloe")).toBe("C");
    expect(personInitials("owner")).toBe("O");
    expect(personInitials("  ")).toBe("?");
    expect(personInitials("élodie dupont")).toBe("ÉD");
  });
});

describe("Same person? (brief §2.4, §5 item 8; desktop lib/home-chat/people.ts)", () => {
  const p = (ext: string, username: string, displayName: string) => ({ ext, username, displayName });

  it("matches the same username, or the same real full name", () => {
    expect(mightBeSamePerson(p("k2:connect:a", "ana", "Ana"), p("k2:connect:b", "ANA", "x"))).toBe(true);
    expect(mightBeSamePerson(p("k2:connect:a", "ana1", "Ana Ruiz"), p("k2:connect:b", "aruiz", "ana  ruiz"))).toBe(true);
  });

  it("never by the owner's username (always `owner`), nor a name that is just the username", () => {
    expect(mightBeSamePerson(p("k2:owner", "owner", "owner"), p("k2:owner", "owner", "owner"))).toBe(false);
    expect(mightBeSamePerson(p("k2:owner", "owner", "Rosa Lind"), p("k2:owner", "owner", "Rosa Lind"))).toBe(true);
    expect(mightBeSamePerson(p("k2:connect:a", "sam", "sam"), p("k2:connect:b", "samuel", "sam"))).toBe(false);
  });

  it("lists matches on other servers only", () => {
    const ana = p("k2:connect:a", "ana", "Ana Ruiz");
    const hits = matchesElsewhere(ana, "s1", {
      s1: [p("k2:connect:z", "ana", "Ana Ruiz")],
      s2: [p("k2:connect:y", "ana", "A"), p("k2:connect:x", "bob", "Bob")],
      s3: undefined,
    });
    expect(hits.map((h) => [h.serverId, h.person.ext])).toEqual([["s2", "k2:connect:y"]]);
  });

  it("copies the desktop's words", () => {
    const c = samePersonCopy("Ana R.", "Ana Ruiz", "Studio");
    expect(c.title).toBe("Is Ana R. the same person as Ana Ruiz on Studio?");
    expect(c.body).toBe(
      "Same person keeps one row: Ana Ruiz's row stays, and its menu's “Also on” switches servers. Different person adds a second row."
    );
  });
});

describe("rows", () => {
  it("builds person and channel rows (`<ext>::<host>`, `<conv>::<host>`) and parses them back", () => {
    const row = personRow({ ext: "k2:connect:abc-1", displayName: "Ana" }, "box-1")!;
    expect(row).toEqual({ kind: "person", address: "k2:connect:abc-1::box-1", workspaceId: null, label: "Ana" });
    expect(chatRowParts(row)).toEqual({ kind: "person", handle: "k2:connect:abc-1", host: "box-1" });
    expect(personRow({ ext: "k2:workspace:x", displayName: "Bot" }, "box-1")).toBeNull();
    expect(personRow({ ext: "k2:principal:x", displayName: "App" }, "box-1")).toBeNull();
    const ch = channelRow("501", "general", "box-1")!;
    expect(chatRowParts(ch)).toEqual({ kind: "channel", handle: "501", host: "box-1" });
    expect(channelRow("abc", "x", "box-1")).toBeNull();
    expect(chatRowParts({ address: "alpha::box-1" })).toBeNull();
  });

  it("pickable: ready people only", () => {
    const base = { ext: "k2:owner", username: "owner", displayName: "O", picture: null, role: null, memberId: "1" };
    expect(pickablePerson({ ...base, ready: true })).toBe(true);
    expect(pickablePerson({ ...base, ready: false })).toBe(false);
  });

  it("finds a row's summary: channel by id; person by the opened DM, else `with`", () => {
    const summary: HomeChatSummary = {
      chat: "live",
      convs: [
        { conv: "9", kind: "dm", unread: true, badge: { kind: "count", n: 2 }, lastAt: null, lastAtMs: null, lastMessageId: null, with: "k2:connect:a", inviteOnly: null },
        { conv: "8", kind: "dm", unread: false, badge: { kind: "none" }, lastAt: null, lastAtMs: null, lastMessageId: null, with: null, inviteOnly: null },
        { conv: "501", kind: "channel", unread: true, badge: { kind: "dot" }, lastAt: null, lastAtMs: null, lastMessageId: null, with: null, inviteOnly: true },
      ],
    };
    expect(summaryRowFor(summary, {}, "person", "k2:connect:a")?.conv).toBe("9");
    expect(summaryRowFor(summary, { "k2:connect:b": "8" }, "person", "k2:connect:b")?.conv).toBe("8");
    expect(summaryRowFor(summary, {}, "channel", "501")?.inviteOnly).toBe(true);
    expect(summaryRowFor(null, {}, "channel", "501")).toBeNull();
  });

  it("badges: a dot draws no number; a count; 99+ at the cap", () => {
    expect(badgeUnread({ kind: "none" })).toBeNull();
    expect(badgeUnread({ kind: "dot" })).toMatchObject({ tone: "unread", count: 1 });
    expect(badgeUnread({ kind: "count", n: 3 })?.count).toBe(3);
    expect(unreadCountText(badgeUnread({ kind: "count", n: 99 })?.count)).toBe("99+");
  });

  it("invite-only: the summary says, else the channel list, else unknown (#)", () => {
    const list = [{ conv: "5", name: "x", open: false, inviteOnly: true, archived: false, home: false, allowAgents: false }];
    expect(channelInviteOnly(false, list, "5")).toBe(false);
    expect(channelInviteOnly(null, list, "5")).toBe(true);
    expect(channelInviteOnly(undefined, [], "5")).toBeNull();
  });

  it("greys a row with the reason; a gate not read yet is not a reason (never dropped)", () => {
    const base = { saved: true, signedIn: true, serverLabel: "Parity" };
    expect(chatRowQuiet({ ...base, look: null })).toBeNull();
    expect(chatRowQuiet({ ...base, look: { gate: gate({ checkedAt: null }), summary: null, summaryError: null } })).toBeNull();
    expect(chatRowQuiet({ ...base, saved: false, look: null })?.line).toBe("Parity is not saved on this phone");
    expect(chatRowQuiet({ ...base, signedIn: false, look: null })?.line).toBe("Sign in to Parity");
    expect(
      chatRowQuiet({ ...base, look: { gate: gate({ on: false, reason: "mac", pickerLine: HOME_CHAT_COPY_MAC }), summary: null, summaryError: null } })
    ).toEqual({ line: HOME_CHAT_COPY_MAC, noChat: true });
    // An older server (no `home-chat-v1`): no chat.
    expect(chatRowQuiet({ ...base, look: { gate: gate({ feature: false }), summary: null, summaryError: null } })).toEqual({
      line: HOME_CHAT_COPY_NO_CHAT,
      noChat: true,
    });
    // A blip reading the status: can't be reached, still opens later.
    expect(
      chatRowQuiet({
        ...base,
        look: { gate: gate({ refusal: { ok: false, kind: "network", code: "network", hint: "", status: null } }), summary: null, summaryError: null },
      })
    ).toEqual({ line: "Parity can’t be reached", noChat: false });
    const open = gate({ offered: true, on: true });
    expect(chatRowQuiet({ ...base, look: { gate: open, summary: { chat: "unavailable", convs: [] }, summaryError: null } })?.noChat).toBe(false);
    expect(chatRowQuiet({ ...base, look: { gate: open, summary: { chat: "live", convs: [] }, summaryError: null } })).toBeNull();
  });

  it("line two", () => {
    expect(chatRowLine("person", null, null)).toBe("Direct message");
    expect(chatRowLine("channel", true, null)).toBe("Invite-only channel");
    expect(chatRowLine("channel", null, null)).toBe("Channel");
    expect(chatRowLine("channel", false, badgeUnread({ kind: "count", n: 4 }))).toBe("New messages");
  });
});
