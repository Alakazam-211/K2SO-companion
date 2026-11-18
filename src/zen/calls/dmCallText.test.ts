import { describe, expect, it } from "vitest";
import {
  callingLine,
  cancelFellBackText,
  dmCallEndedText,
  dmCallRetryable,
  dmJoinErrorText,
  endReasonState,
  isCallOver,
} from "./dmCallText";

describe("DM call lines", () => {
  it("maps the gates to plain lines", () => {
    expect(dmJoinErrorText("host_not_pro", "host_not_pro", "Alex", "box")).toBe("Calls need the Pro plan on that server.");
    expect(dmJoinErrorText("voice_unavailable", "voice_unavailable", "Alex", "box")).toBe(
      "Calls on box are restarting. Try again in a moment."
    );
    expect(dmJoinErrorText("chat_unavailable", "unknown", "Alex", "box")).toBe("Calls aren't available on box right now.");
    expect(dmJoinErrorText("dm_not_found", "unknown", "Alex", "box")).toBe("Your conversation with Alex isn't on box.");
    expect(dmJoinErrorText("weird", "unknown", "Alex", "box", "the hint")).toBe("Couldn't call Alex: the hint");
    expect(dmJoinErrorText("mic_denied", "mic_denied", "Alex", "box")).toMatch(/microphone/);
  });

  it("offers Try again only where it helps", () => {
    expect(dmCallRetryable("voice_unavailable")).toBe(true);
    expect(dmCallRetryable("unavailable", "voice_unavailable")).toBe(true);
    expect(dmCallRetryable("host_not_pro", "host_not_pro")).toBe(false);
    expect(dmCallRetryable("dm_not_found", "unknown")).toBe(false);
  });

  it("a call that's over (Sew's call_not_active, a re-join's call_ended) says 'Call ended', never Try again", () => {
    for (const raw of ["call_not_active", "CALL_NOT_ACTIVE", "call_ended"]) {
      expect(isCallOver(raw)).toBe(true);
      expect(dmJoinErrorText(raw, "unknown", "Alex", "box", "refused")).toBe("Call ended");
      expect(dmCallRetryable(raw, "unknown")).toBe(false);
      expect(dmCallEndedText(raw, "Alex", "box")).toBe("Call ended");
    }
    // The code read as retryable never wins over a call that's over.
    expect(dmCallRetryable("call_not_active", "voice_unavailable")).toBe(false);
    expect(isCallOver("invalid_state")).toBe(false);
  });

  it("reads an ended call; a cancelled ring is never a missed call", () => {
    expect(endReasonState("declined")).toBe("declined");
    expect(endReasonState("no_answer")).toBe("missed");
    expect(endReasonState("cancelled")).toBe("cancelled");
    expect(endReasonState(null)).toBe("ended");
  });

  it("says the caller's side and the fallback cancel", () => {
    expect(callingLine("joining", "Alex")).toBe("Calling Alex…");
    expect(callingLine("busy", "Alex")).toBe("Alex is on another call");
    expect(callingLine("missed", "Alex")).toBe("Alex didn't answer");
    expect(cancelFellBackText("Alex")).toMatch(/Alex will see a missed call/);
    expect(dmCallEndedText("network", "Alex", "box")).toBe("The call with Alex dropped: the connection was lost.");
    expect(dmCallEndedText("anything", "Alex", "box")).toBe("The call with Alex ended.");
  });
});
