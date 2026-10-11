import { describe, expect, it } from "vitest";
import {
  countWaiting,
  deliveryMissLine,
  filterByScope,
  groupByStatus,
  isTicketEventFrame,
  myAssigneeNames,
  optionsActionable,
  STATUS_SECTIONS,
  statusColor,
  statusLabel,
  type FeedbackStatus,
} from "./feedbackPure";

const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: status as FeedbackStatus,
  ...extra,
});

describe("groupByStatus", () => {
  it("groups Waiting, Needs discussion, Answered, Planned, Unlinked, Closed", () => {
    const g = groupByStatus([
      row("w", "waiting"),
      row("n", "needs_discussion"),
      row("a", "answered"),
      row("p", "planned"),
      row("r", "resolved"),
      row("d", "dismissed"),
      row("u", "waiting", { linked: false }),
      row("uc", "resolved", { linked: false }),
    ]);
    expect(g.waiting.map((r) => r.id)).toEqual(["w"]);
    expect(g.needs_discussion.map((r) => r.id)).toEqual(["n"]);
    expect(g.answered.map((r) => r.id)).toEqual(["a"]);
    expect(g.planned.map((r) => r.id)).toEqual(["p"]);
    expect(g.unlinked.map((r) => r.id)).toEqual(["u"]);
    expect(g.closed.map((r) => r.id)).toEqual(["r", "d", "uc"]);
    expect(STATUS_SECTIONS.map((s) => s.label)).toEqual([
      "Waiting",
      "Needs discussion",
      "Answered",
      "Planned",
      "Unlinked workspace",
      "Closed",
    ]);
  });

  it("an unknown status doesn't crash and lands in Closed", () => {
    const g = groupByStatus([row("x", "archived_by_future_daemon")]);
    expect(g.closed.map((r) => r.id)).toEqual(["x"]);
    expect(statusLabel("archived_by_future_daemon")).toBe("archived by future daemon");
    expect(statusColor("archived_by_future_daemon")).toBe("var(--text-muted)");
  });

  it("the badge skips unlinked waiting tickets", () => {
    expect(countWaiting([row("w", "waiting"), row("u", "waiting", { linked: false })])).toBe(1);
  });
});

describe("options and receipts", () => {
  it("options stay live until closed, never on unlinked", () => {
    expect(optionsActionable({ status: "needs_discussion", options: ["a"] })).toBe(true);
    expect(optionsActionable({ status: "planned", options: ["a"] })).toBe(true);
    expect(optionsActionable({ status: "dismissed", options: ["a"] })).toBe(false);
    expect(optionsActionable({ status: "waiting", options: ["a"], linked: false })).toBe(false);
  });

  it("deliveryMissLine only speaks on delivered:false", () => {
    expect(deliveryMissLine({ delivered: true })).toBeNull();
    expect(deliveryMissLine({})).toBeNull();
    expect(deliveryMissLine({ delivered: false, deliveryReason: "session_gone" })).toBe(
      "Saved. The agent did not receive it (session gone)."
    );
  });

  it("ticket frames are feedback_changed and ticket_changed", () => {
    expect(isTicketEventFrame({ kind: "feedback_changed", reason: "created" })).toBe(true);
    expect(isTicketEventFrame({ kind: "ticket_changed", id: "t" })).toBe(true);
    expect(isTicketEventFrame({ kind: "hello" })).toBe(false);
    expect(isTicketEventFrame(null)).toBe(false);
  });
});

describe("scope", () => {
  const rows = [
    row("mine-wait", "waiting", { assignees: ["Julie"] }),
    row("mine-ans", "answered", { assignees: ["julie"] }),
    row("other", "waiting", { assignees: ["bob"] }),
    row("unassigned", "waiting", { assignees: [] }),
    row("mine-unlinked", "waiting", { assignees: ["julie"], linked: false }),
  ];
  const me = myAssigneeNames({ owner: false, username: "julie" });

  it("Waiting on me = mine and waiting (case-insensitive, linked only)", () => {
    expect(filterByScope(rows, "waiting", me).map((r) => r.id)).toEqual(["mine-wait"]);
  });

  it("Mine = assigned to me; All = everything", () => {
    expect(filterByScope(rows, "mine", me).map((r) => r.id)).toEqual([
      "mine-wait",
      "mine-ans",
      "mine-unlinked",
    ]);
    expect(filterByScope(rows, "all", me)).toHaveLength(5);
  });

  it("the owner is `owner` plus the saved username", () => {
    expect(myAssigneeNames({ owner: true, username: "Rosson" }, ["rosson"])).toEqual([
      "owner",
      "rosson",
    ]);
    expect(myAssigneeNames(null, ["u"])).toEqual(["u"]);
  });
});
