import { describe, expect, it } from "vitest";
import type { HomeChatMessage, HomeChatPeople } from "../../api/homeChatPure";
import type { SewCallId } from "../../api/homeChatCallsPure";
import {
  PERSON_COLORS,
  authorName,
  callerIsAdmin,
  channelPerms,
  deleteTitle,
  firstLine,
  homeChatRows,
  leaveCopy,
  memberNames,
  memberRoleLabel,
  membersSubline,
  personColor,
  personInitials,
  personInk,
  pickablePerson,
  quoteText,
  reactionTipText,
  reactorsLine,
  replyPreview,
  searchEmoji,
  sendFailedLine,
  typingNames,
} from "./homeChatModel";

const people: HomeChatPeople = {
  me: { ext: "k2:connect:me", memberId: "1" },
  people: [
    { ext: "k2:connect:ana", username: "ana", displayName: "Ana Diaz", picture: null, role: null, ready: true, memberId: "2" },
    { ext: "k2:connect:ben", username: "ben", displayName: "", picture: null, role: null, ready: false, memberId: null },
  ],
};

function msg(id: string, author: string, body = "hi", over: Partial<HomeChatMessage> = {}): HomeChatMessage {
  return {
    id,
    conv: "9",
    authorId: author,
    body,
    createdAtMs: 1_700_000_000_000 + Number(id) * 1000,
    seq: 0,
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

describe("people", () => {
  it("hashes a username to the daemon's palette, stably", () => {
    expect(PERSON_COLORS).toContain(personColor("riley"));
    expect(personColor("riley")).toBe(personColor("riley"));
    // h = 97 ('a') → 97 % 8 = 1
    expect(personColor("a")).toBe(PERSON_COLORS[1]);
  });

  it("picks the ink that reads better, clearing 4.5:1 on every person colour", () => {
    for (const c of PERSON_COLORS) expect(["#ffffff", "#000000"]).toContain(personInk(c));
    expect(personInk("#000000")).toBe("#ffffff");
    expect(personInk("#ffffff")).toBe("#000000");
  });

  it("draws two initials at 20px and up, one below", () => {
    expect(personInitials("Riley Stone", 32)).toBe("RS");
    expect(personInitials("Riley Stone", 16)).toBe("R");
    expect(personInitials("anna", 32)).toBe("A");
    expect(personInitials("  ", 32)).toBe("?");
  });

  it("names authors: You, the person, else Someone", () => {
    const names = memberNames(people);
    expect(names.get("2")).toBe("Ana Diaz");
    expect(authorName("1", "1", names)).toBe("You");
    expect(authorName("2", "1", names)).toBe("Ana Diaz");
    expect(authorName("77", "1", names)).toBe("Someone");
  });

  it("offers only ready people with a member id, never you", () => {
    expect(pickablePerson(people.people[0], "k2:connect:me")).toBe(true);
    expect(pickablePerson(people.people[1], "k2:connect:me")).toBe(false);
    expect(pickablePerson(people.people[0], "k2:connect:ana")).toBe(false);
  });
});

describe("replies", () => {
  it("quotes the original's first non-blank line, or says it's gone or not loaded", () => {
    const names = memberNames(people);
    expect(firstLine("\n\n  first \nsecond")).toBe("first");
    const p = replyPreview(msg("5", "2", "\nhello there\nmore"), "1", names);
    expect(p).toEqual({ state: "loaded", author: "Ana Diaz", line: "hello there" });
    expect(quoteText(p)).toEqual({ from: "Ana Diaz", line: "hello there" });
    expect(quoteText(replyPreview(msg("5", "2", "", { deleted: true }), "1", names)).line).toBe("Original message deleted");
    expect(replyPreview(undefined, "1", names)).toEqual({ state: "missing" });
    expect(quoteText({ state: "missing" }).line).toMatch(/Original not loaded/);
  });
});

describe("reactions", () => {
  it("names reactors with You first", () => {
    expect(reactorsLine(["Ana", "You"])).toBe("You and Ana");
    expect(reactorsLine(["A", "B", "C", "D", "E", "F", "G"])).toBe("A, B, C, D, E and 2 others");
    expect(reactionTipText(undefined, "👍")).toBe("Finding who reacted with 👍…");
    expect(reactionTipText([], "👍")).toBe("Reacted with 👍");
    expect(reactionTipText(["Ana"], "👍")).toBe("Ana reacted with 👍");
  });

  it("searches emoji by word prefixes; blank lists all, quick six first", () => {
    const all = searchEmoji("");
    expect(all.slice(0, 7)).toEqual(["👍", "❤️", "😂", "🎉", "😮", "🙏", "👎"]);
    expect(new Set(all).size).toBe(all.length);
    expect(searchEmoji("thumbs")).toEqual(["👍", "👎", "👍🏻"]);
    expect(searchEmoji("heart bro")).toEqual(["💔"]);
    expect(searchEmoji("zzzz")).toEqual([]);
  });
});

describe("the members sheet", () => {
  it("knows an admin from the people list", () => {
    expect(callerIsAdmin(null)).toBe(false);
    expect(callerIsAdmin(people)).toBe(false);
    expect(callerIsAdmin({ ...people, me: { ext: "k2:owner", memberId: "1" } })).toBe(true);
    expect(callerIsAdmin({ ...people, people: [{ ...people.people[0], role: "member" }] })).toBe(true);
  });

  it("hides what the caller's role can't do", () => {
    const base = { callerExt: "me", admin: false, creator: "them", member: true, open: true, archived: false };
    expect(channelPerms(base)).toEqual({ addPeople: true, removeOthers: false, leave: true, rename: false, remove: false });
    expect(channelPerms({ ...base, creator: "me" }).remove).toBe(true);
    expect(channelPerms({ ...base, admin: true, open: false }).removeOthers).toBe(true);
    expect(channelPerms({ ...base, admin: true, open: true }).removeOthers).toBe(false);
    expect(channelPerms({ ...base, archived: true, admin: true })).toMatchObject({ addPeople: false, rename: false, remove: false });
  });

  it("says Delete and Leave as the desktop does", () => {
    expect(deleteTitle({ name: "general", open: true })).toBe("Delete #general?");
    expect(deleteTitle({ name: "secret", open: false })).toBe("Delete secret?");
    expect(deleteTitle(null)).toBe("Delete this channel?");
    expect(leaveCopy({ name: "x", open: true }).message).toMatch(/open to everyone/);
    expect(memberRoleLabel("owner")).toBe("Owner");
    expect(memberRoleLabel("member")).toBeNull();
    expect(membersSubline({ open: false, state: "archived", people: [1] })).toBe("Invite only · 1 person · Archived: read-only");
  });

  it("words a failed send", () => {
    expect(sendFailedLine("Can't reach the server.")).toBe("Not sent (Can't reach the server). Tap Retry on the message to send it again.");
    expect(sendFailedLine("")).toBe("Not sent. Tap Retry on the message to send it again.");
  });
});

describe("rows", () => {
  const names = memberNames(people);
  const call = {
    callId: "5" as SewCallId,
    startedBy: "2",
    ended: true,
    endReason: "no_answer",
    durationMs: null,
    joinedIds: [],
    rungIds: [],
    declinedIds: [],
    missedIds: ["1"],
  };

  it("names someone else's runs, never yours; a call record is a line that breaks the run", () => {
    const rows = homeChatRows(
      [msg("1", "2"), msg("2", "2"), msg("3", "1"), msg("4", "2", "", { call }), msg("5", "2")],
      "1",
      names,
      "channel"
    );
    expect(rows.map((r) => r.kind)).toEqual(["message", "message", "message", "call", "message"]);
    const m = rows.filter((r): r is Extract<typeof r, { kind: "message" }> => r.kind === "message");
    expect(m.map((r) => r.name)).toEqual(["Ana Diaz", null, null, "Ana Diaz"]);
    expect(m[0].run).toEqual({ first: true, last: false });
    expect(m[1].run).toEqual({ first: false, last: true });
    // After the call line, Ana's next message starts a new run.
    expect(m[3].run.first).toBe(true);
  });

  it("names the other person's runs in a DM", () => {
    const rows = homeChatRows([msg("1", "2"), msg("2", "1")], "1", names, "dm");
    expect(rows.map((r) => (r.kind === "message" ? r.name : "call"))).toEqual(["Ana Diaz", null]);
  });

  it("lists who is typing, never you", () => {
    expect(typingNames(["2", "1", "9"], "1", names)).toEqual(["Ana Diaz", "Someone"]);
  });
});
