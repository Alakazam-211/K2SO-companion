import { describe, expect, it } from "vitest";
import { actionResultMessage, normaliseThreadItem } from "./threadModel";
import { sameMessage } from "./threadCacheMerge";

// K2 0.46.3 action cards: `choice.action.result.message` shows under the
// chosen option once the card is answered.

const card = (choice: Record<string, unknown>) =>
  normaliseThreadItem({ doc: { id: "c1", seq: 1, kind: "choice", from: "k2", body: "Keep it?", created_at: 1, choice } } as never, "me")!;

describe("action card result line", () => {
  it("answered + result.message → resultMessage", () => {
    const m = card({
      prompt: "Keep as yours?",
      options: ["Keep", "Discard"],
      answer: "Keep",
      status: "answered",
      action: { id: "garden.keep", params: {}, result: { message: " Kept as yours. Undo in Settings → Gardens → Local Data. " } },
    });
    expect(m.choice?.answer).toBe("Keep");
    expect(m.choice?.resultMessage).toBe("Kept as yours. Undo in Settings → Gardens → Local Data.");
  });

  it("not answered, no action, empty or non-string message → none", () => {
    expect(actionResultMessage({ status: "open", action: { result: { message: "x" } } })).toBeNull();
    expect(actionResultMessage({ status: "answered" })).toBeNull();
    expect(actionResultMessage({ status: "answered", action: { result: { message: "  " } } })).toBeNull();
    expect(actionResultMessage({ status: "answered", action: { result: { message: 3 } } })).toBeNull();
    expect(card({ options: ["A"], answer: "A" }).choice?.resultMessage).toBeUndefined();
  });

  it("a result arriving later changes the row (re-render)", () => {
    const before = card({ options: ["Keep"], answer: "Keep", status: "answered", action: { id: "x" } });
    const after = card({ options: ["Keep"], answer: "Keep", status: "answered", action: { id: "x", result: { message: "Done." } } });
    expect(sameMessage(before, after)).toBe(false);
  });
});
