import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMine,
  isOwnerAuthored,
  mountainListWhen,
  mountainTime,
  normaliseThreadItem,
} from "./threadModel";

afterEach(() => {
  vi.useRealTimers();
});

describe("threadModel", () => {
  it("treats owner and matching username as mine", () => {
    expect(isMine("owner", "baden")).toBe(true);
    expect(isMine("baden", "baden")).toBe(true);
    expect(isMine("k2so-Skin-Test-A", "baden")).toBe(false);
  });

  it("send authorship accepts owner or username and still rejects the room agent", () => {
    expect(isOwnerAuthored("owner", "baden", "k2so-companion-qa")).toBe(true);
    expect(isOwnerAuthored("baden", "baden", "k2so-companion-qa")).toBe(true);
    expect(isOwnerAuthored("k2so-companion-qa", "baden", "k2so-companion-qa")).toBe(false);
    expect(isOwnerAuthored("k2so-companion-qa", "k2so-companion-qa", "k2so-companion-qa")).toBe(false);
    expect(isOwnerAuthored("baden", "", "k2so-companion-qa")).toBe(false);
    expect(isOwnerAuthored("skin-test-a", "baden", "k2so-companion-qa")).toBe(false);
  });

  it("formats Mountain Time from unix seconds", () => {
    const s = mountainTime(1759198521);
    expect(s).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  it("list when is time today, Yesterday, weekday this week, date beyond", () => {
    const nowSec = Date.now() / 1000;
    expect(mountainListWhen(nowSec)).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
    expect(mountainListWhen(nowSec - 86400)).toBe("Yesterday");
    const midWeek = mountainListWhen(nowSec - 3 * 86400);
    expect(midWeek).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    expect(mountainListWhen(1700000000)).toMatch(/\d{1,2}\/\d{1,2}\/\d{2}/);
    expect(mountainListWhen(null)).toBe("");
  });

  it("weekday is Sun, not Sunday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T18:00:00-06:00"));
    const sunday = Date.parse("2026-09-27T12:00:00-06:00") / 1000;
    expect(mountainListWhen(sunday)).toBe("Sun");
    expect(mountainListWhen(sunday)).not.toBe("Sunday");
  });

  it("includes a date when the message is not today", () => {
    // 2023-11-14 22:13 UTC
    const s = mountainTime(1700000000);
    expect(s).toMatch(/Nov/);
    expect(s).toMatch(/\d{1,2}:\d{2}/);
  });

  it("normalises Skin-shaped items", () => {
    const m = normaliseThreadItem(
      {
        id: "m1",
        seq: 3,
        doc: { from: "k2so-Skin-Test-A", body: "hello", created_at: 1759198521 },
      },
      "baden"
    );
    expect(m?.text).toBe("hello");
    expect(m?.mine).toBe(false);
    expect(m?.from).toBe("k2so-Skin-Test-A");
  });

  it("drops empty-body items and keeps choice cards", () => {
    expect(
      normaliseThreadItem({ id: "x", seq: 1, doc: { kind: "event", from: "k2", body: "" } }, "baden")
    ).toBeNull();
    const c = normaliseThreadItem(
      {
        id: "c1",
        seq: 2,
        doc: {
          kind: "choice",
          from: "k2",
          choice: { prompt: "Pick one", options: ["A", "B"] },
        },
      },
      "baden"
    );
    expect(c?.choice?.options).toEqual(["A", "B"]);
    expect(c?.choice?.prompt).toBe("Pick one");
  });

  it("takes choice option labels from the wire objects, not String(object)", () => {
    const c = normaliseThreadItem(
      {
        id: "c2",
        seq: 18,
        doc: {
          kind: "choice",
          from: "k2so-companion-qa",
          choice: {
            prompt: "How do you want to sign in?",
            options: [{ label: "Secret" }, { label: "Phone" }, { label: "Hold" }],
          },
        },
      },
      "baden"
    );
    expect(c?.choice?.options).toEqual(["Secret", "Phone", "Hold"]);
    expect(c?.choice?.options.join(" ")).not.toMatch(/\[object Object\]/);
  });
});
describe("stash.offer (K2 0.46.7)", () => {
  it("reads doc.stash on a stash.offer; doc.body stays the readable fallback", () => {
    const m = normaliseThreadItem(
      {
        seq: 9,
        doc: {
          id: "o1",
          kind: "stash.offer",
          from: "appa",
          body: "Weekly review\n\nSummarize this week's PRs.",
          stash: { title: " Weekly review ", text: "Summarize this week's PRs." },
        },
      } as never,
      "baden"
    );
    expect(m?.text).toBe("Weekly review\n\nSummarize this week's PRs.");
    expect(m?.stashOffer).toEqual({ title: "Weekly review", text: "Summarize this week's PRs." });
  });

  it("no offer without text, or on another kind", () => {
    const of = (doc: Record<string, unknown>) =>
      normaliseThreadItem({ seq: 1, doc: { id: "x", from: "appa", body: "hi", ...doc } } as never, "baden")?.stashOffer;
    expect(of({ kind: "stash.offer", stash: { text: " " } })).toBeUndefined();
    expect(of({ kind: "text", stash: { text: "x" } })).toBeUndefined();
    expect(of({ kind: "stash.offer" })).toBeUndefined();
  });
});
