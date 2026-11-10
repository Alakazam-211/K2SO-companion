// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { otherSenderCount, senderLabel, senderPicture, useThreadPicturesOn } from "./threadPictures";

describe("Thread pictures", () => {
  it("counts senders other than me, by name, any case", () => {
    expect(otherSenderCount([{ mine: true, from: "owner" }, { mine: false, from: "sew" }, { mine: false, from: "Sew" }])).toBe(1);
    expect(otherSenderCount([{ mine: false, from: "sew" }, { mine: false, from: "system" }])).toBe(2);
  });

  it("turns on at two other senders, stays on for that Thread, resets on a switch", () => {
    const hook = renderHook(({ k, n }) => useThreadPicturesOn(k, n), { initialProps: { k: "s\na", n: 1 } });
    expect(hook.result.current).toBe(false);
    hook.rerender({ k: "s\na", n: 2 });
    expect(hook.result.current).toBe(true);
    hook.rerender({ k: "s\na", n: 1 });
    expect(hook.result.current).toBe(true);
    hook.rerender({ k: "s\nb", n: 1 });
    expect(hook.result.current).toBe(false);
  });

  it("uses the agent's own picture, else initials on the sender's hue", () => {
    const agents = [{ id: "1", name: "Sew", initial: "S", addr: "sew", iconUrl: "data:x", color: "#123" }] as never;
    expect(senderPicture("sew", agents)).toEqual({ initial: "S", color: "#123", iconUrl: "data:x" });
    const other = senderPicture("baden", agents);
    expect(other.iconUrl).toBeNull();
    expect(other.color).toMatch(/^hsl\(/);
    expect(senderPicture("baden", agents)).toEqual(other);
  });
});

describe("Sender label", () => {
  const agents = [
    { id: "demo", name: "demo-agent", initial: "D", addr: "review-demo-7" },
    { id: "grp", name: "Team", initial: "T", addr: "team", kind: "group" as const, groupId: "g1" },
  ];
  it("shows an agent's display name, matched on its handle in any case", () => {
    expect(senderLabel("review-demo-7", agents)).toBe("demo-agent");
    expect(senderLabel(" Review-Demo-7 ", agents)).toBe("demo-agent");
  });
  it("keeps from when no agent has that handle (a person, a bot, a project chat)", () => {
    expect(senderLabel("review-demo-8", agents)).toBe("review-demo-8");
    expect(senderLabel("team", agents)).toBe("team");
    expect(senderLabel("demo-agent", agents)).toBe("demo-agent");
    expect(senderLabel("", agents)).toBe("");
  });
});
