import { describe, expect, it } from "vitest";
import { parseCallRecording, parseRecordingControls, recordingButtons } from "./callRecording";
import { parseRecordingControlsAnswer, recordingErrorText, recordingNoticeText } from "./voiceWire";

describe("Record and Stop (K2 0.46.11, Sew 0.9.2)", () => {
  it("reads the controls answer's rights exactly, nulls left out (K2 hasn't seen Sew's policies)", () => {
    const a = parseRecordingControlsAnswer(
      {
        ok: true,
        room: "standup",
        channelId: "48831765147549720",
        myPerms: "8192",
        recordCalls: true,
        manageChannels: false,
        agentReaders: true,
        rights: { dm: false, recordingEnabled: null, recordingDmEnabled: false, recordCapped: true, agent: false },
      },
      "standup"
    );
    expect(a).toEqual({
      rights: { room: "standup", my_perms: "8192", dm: false, recording_dm_enabled: false, record_capped: true, agent: false },
      voiceChatOnly: false,
      agentReaders: true,
    });
    // A Voice & Chat only login: no rights to hand over.
    expect(parseRecordingControlsAnswer({ ok: true, voiceChatOnly: true, recordCalls: false }, "standup")).toEqual({
      rights: null,
      voiceChatOnly: true,
      agentReaders: false,
    });
    expect(() => parseRecordingControlsAnswer(null, "standup")).toThrow();
  });

  it("shows only what the plugin says: its controls, else the recording's own, else nothing", () => {
    const recording = parseCallRecording({ recording_id: "r1", recorder_present: true, can_stop: true, my_consent: "granted" });
    expect(recording).toEqual({ recordingId: "r1", live: true, required: false, canRecord: false, canStop: true });
    expect(recordingButtons({ controls: null, recording: null, off: false })).toEqual({ canRecord: false, canStop: false });
    expect(recordingButtons({ controls: null, recording, off: false })).toEqual({ canRecord: false, canStop: true });
    const controls = parseRecordingControls({ can_record: true, can_stop: false });
    expect(recordingButtons({ controls, recording, off: false })).toEqual({ canRecord: true, canStop: false });
    expect(recordingButtons({ controls, recording, off: true })).toEqual({ canRecord: false, canStop: false });
    expect(parseRecordingControls({ can_record: "yes" })).toBeNull();
    expect(parseCallRecording(null)).toBeNull();
  });

  it("words K2's notice for its rooms as desktop does", () => {
    const facts = { startedByName: null, required: true, audioKeepDays: 1, appReaders: ["Notes"], agentReaders: false };
    const join = recordingNoticeText("Standup", { ask: "join", ...facts }, true);
    expect(join).toEqual({
      title: "Standup is being recorded",
      lines: [
        "This room records every call with more than one person.",
        "Everyone's voice is recorded and transcribed. The transcript is kept in this room's chat.",
        "The audio is kept for 1 day.",
        "Notes can read the transcript.",
        "Agents on this server may read the transcript.",
        "Joining means being recorded.",
      ],
      ok: "OK",
      leave: "Don't join",
    });
    const inCall = recordingNoticeText("Standup", { ask: "in_call", ...facts, required: false, appReaders: [] }, false);
    expect(inCall.title).toBe("This call is being recorded");
    expect(inCall.lines[0]).toBe("This room records its calls.");
    expect(inCall.lines[inCall.lines.length - 1]).toBe("Staying in the call means being recorded.");
    expect(inCall.leave).toBe("Leave call");
  });

  it("says a refusal in desktop's words", () => {
    expect(recordingErrorText("start", "recording_active")).toBe("This call is already being recorded.");
    expect(recordingErrorText("start", "recording_disabled")).toBe("Recording is off on this server.");
    expect(recordingErrorText("stop", "boom")).toBe("K2 couldn't stop the recording.");
  });
});
