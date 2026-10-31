import { describe, expect, it } from "vitest";
import { pushInboxLine } from "./ChatTimingDiagnostics";

describe("Diagnostics: messages from pushes", () => {
  const base = {
    drains: 2,
    received: 5,
    landed: 3,
    partial: 1,
    skipped: { notText: 1, noServer: 0, notCached: 1, otherConversation: 0, alreadyThere: 0 },
    lastAt: 1,
  };

  it("says how many arrived, landed, were cut short, and why the rest didn't", () => {
    expect(pushInboxLine(base)).toBe(
      "Messages from pushes: 5 received · 3 added to chats (1 cut short) · skipped: 1 chat not on this phone, 1 card or not text"
    );
  });

  it("nothing yet", () => {
    expect(pushInboxLine({ ...base, drains: 0 })).toBe("Messages from pushes: none yet this session.");
  });
});
