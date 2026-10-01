import { describe, expect, it } from "vitest";
import { mergeThreadMessages, overlayEventsUrl } from "./threadLive";
import type { ThreadMessage } from "./threadModel";

function msg(id: string, seq: number): ThreadMessage {
  return {
    id,
    seq,
    text: id,
    from: "appa",
    at: seq,
    mine: false,
    kind: "text",
    choice: null,
  };
}

describe("mergeThreadMessages", () => {
  it("appends unseen items in seq order", () => {
    const cur = [msg("a", 1)];
    const next = mergeThreadMessages(cur, [msg("c", 3), msg("b", 2)]);
    expect(next.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the same array when every id is already present", () => {
    const cur = [msg("a", 1)];
    expect(mergeThreadMessages(cur, [msg("a", 1)])).toBe(cur);
  });
});

describe("overlayEventsUrl", () => {
  it("builds the Skin overlay events path with conversation and token", () => {
    expect(
      overlayEventsUrl("https://host.k2.dev", "tok", "conv-1")
    ).toBe("wss://host.k2.dev/cli/overlay/events?conversation=conv-1&token=tok");
  });

  it("needs an origin and a conversation", () => {
    expect(overlayEventsUrl("", "tok", "c")).toBeNull();
    expect(overlayEventsUrl("http://127.0.0.1:1", "tok", "")).toBeNull();
  });
});
