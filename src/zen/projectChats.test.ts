// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  groupPreviewText,
  isGroupUnread,
  isProjectGroupsChangedFrame,
  markGroupSeenAt,
  memberCountText,
  sortGroupsByRecency,
  unreadGroupCount,
} from "./projectChats";
import { zenProjectPath } from "./terminalJump";

afterEach(() => localStorage.clear());

describe("projectChats", () => {
  it("unread = newest message after this device's last-seen cursor", () => {
    const at = { "s1|g:a": 100, "s1|g:b": 50, "s1|g:c": null, "s2|g:b": 999 };
    expect(unreadGroupCount("s1", ["a", "b", "c"], at)).toBe(2);
    markGroupSeenAt("s1", "a", 100);
    expect(isGroupUnread("s1", "a", 100)).toBe(false);
    expect(isGroupUnread("s1", "a", Math.floor(Date.now() / 1000) + 60)).toBe(true);
    expect(unreadGroupCount("s1", ["a", "b", "c"], at)).toBe(1);
    // Cursors are per server; no server, no badge.
    expect(isGroupUnread("s2", "a", 100)).toBe(true);
    expect(unreadGroupCount(null, ["a", "b"], at)).toBe(0);
  });

  it("sorts by newest message, untimed groups last in daemon order", () => {
    const rows = [{ id: "x" }, { id: "y" }, { id: "z" }, { id: "w" }];
    const at = { "s1|g:y": 10, "s1|g:w": 30, "s2|g:z": 99 };
    expect(sortGroupsByRecency(rows, at, "s1").map((r) => r.id)).toEqual(["w", "y", "x", "z"]);
  });

  it("formats line two and member counts", () => {
    expect(groupPreviewText({ at: 1, author: "k2", body: "hi\n  there" })).toBe("k2: hi there");
    expect(groupPreviewText({ at: 1, author: "", body: "x" })).toBe("x");
    expect(groupPreviewText(null)).toBe("");
    expect(memberCountText(1)).toBe("1 member");
    expect(memberCountText(null)).toBe("0 members");
  });

  it("recognises the app-level project_groups_changed frame", () => {
    expect(isProjectGroupsChangedFrame({ kind: "project_groups_changed", reason: "message-created" })).toBe(true);
    expect(isProjectGroupsChangedFrame({ kind: "projects_changed" })).toBe(false);
  });

  it("project deep link path", () => {
    expect(zenProjectPath("g 1")).toBe("/zen?project=g%201");
    expect(zenProjectPath("")).toBe("/zen");
  });
});
