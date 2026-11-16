// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), addPluginListener: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const flows = vi.hoisted(() => ({
  acceptRing: vi.fn(async () => null),
  declineRing: vi.fn(async () => {}),
  cancelOutgoingDmCall: vi.fn(async () => {}),
  callAgainDmCall: vi.fn(async () => {}),
  startDmCall: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./dmCall", async (orig) => ({ ...(await orig<typeof import("./dmCall")>()), ...flows }));

import type { SewCallId } from "../../api/homeChatCallsPure";
import { useCallScreen } from "../voice/callScreen";
import { useVoiceCall } from "../voice/voiceCall";
import { DmCallButton } from "./DmCallButton";
import { DmCallLayer } from "./DmCallLayer";
import { __resetDmCallsForTests, useDmCalls, type ActiveDmCall, type IncomingRing } from "./dmCall";
import { __resetHomeChatOpenForTests, useHomeChatOpenRequest } from "./homeChatOpen";
import { __setRingToneForTests } from "./ringTone";

const tone = { start: vi.fn(), stop: vi.fn() };

function ringCard(over: Partial<IncomingRing> = {}): IncomingRing {
  return {
    key: "s1|4455",
    serverId: "s1",
    serverLabel: "box",
    callId: "4455" as SewCallId,
    conv: "900",
    callerName: "Alex Kim",
    silent: false,
    expiresAtMs: null,
    busy: null,
    ...over,
  };
}

function outgoing(over: Partial<ActiveDmCall> = {}): ActiveDmCall {
  return {
    serverId: "s1",
    conv: "900",
    name: "Alex",
    serverLabel: "box",
    role: "caller",
    phase: "ringing",
    k2CallId: null,
    sewCallId: "4455" as SewCallId,
    ringsAgain: 0,
    endedAt: null,
    ...over,
  };
}

beforeEach(() => {
  __resetDmCallsForTests();
  __resetHomeChatOpenForTests();
  __setRingToneForTests(tone);
  tone.start.mockClear();
  tone.stop.mockClear();
  for (const f of Object.values(flows)) f.mockClear();
});

afterEach(() => {
  cleanup();
  __setRingToneForTests(null);
});

describe("DmCallLayer", () => {
  it("draws nothing with nothing going on", () => {
    render(<DmCallLayer />);
    expect(screen.queryByTestId("dm-call-layer")).toBeNull();
    expect(tone.start).not.toHaveBeenCalled();
  });

  it("a ring card: the caller, Incoming call, Decline and Accept, with the ring sound", () => {
    useDmCalls.setState({ rings: [ringCard()] });
    render(<DmCallLayer />);
    expect(screen.getByTestId("dm-ring-name").textContent).toBe("Alex Kim");
    expect(screen.getByTestId("dm-ring-sub").textContent).toBe("Incoming call");
    expect(tone.start).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dm-ring-accept"));
    expect(flows.acceptRing).toHaveBeenCalledWith("s1|4455");
    fireEvent.click(screen.getByTestId("dm-ring-decline"));
    expect(flows.declineRing).toHaveBeenCalledWith("s1|4455");
  });

  it("a silent ring shows the card without sound", () => {
    useDmCalls.setState({ rings: [ringCard({ silent: true })] });
    render(<DmCallLayer />);
    expect(screen.getByTestId("dm-ring-card")).toBeTruthy();
    expect(tone.start).not.toHaveBeenCalled();
  });

  it("stops the sound and the card the moment the ring stops", () => {
    useDmCalls.setState({ rings: [ringCard()] });
    render(<DmCallLayer />);
    act(() => useDmCalls.setState({ rings: [] }));
    expect(screen.queryByTestId("dm-ring-card")).toBeNull();
    expect(tone.stop).toHaveBeenCalled();
  });

  it("while answering, the buttons wait and the line says so", () => {
    useDmCalls.setState({ rings: [ringCard({ busy: "accepting" })] });
    render(<DmCallLayer />);
    expect(screen.getByTestId("dm-ring-sub").textContent).toBe("Joining…");
    expect((screen.getByTestId("dm-ring-accept") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("dm-ring-decline") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a tap on the card opens the DM", () => {
    useDmCalls.setState({ rings: [ringCard()] });
    render(<DmCallLayer />);
    fireEvent.click(screen.getByTestId("dm-ring-name"));
    expect(useHomeChatOpenRequest.getState().pending).toMatchObject({ serverId: "s1", conversationId: "900", from: "ring-card" });
  });

  it("the caller's bar: Calling… with Cancel and Ring again", () => {
    useDmCalls.setState({ active: outgoing() });
    render(<DmCallLayer />);
    expect(screen.getByTestId("dm-calling-line").textContent).toBe("Calling Alex… Ringing");
    fireEvent.click(screen.getByTestId("dm-call-cancel"));
    expect(flows.cancelOutgoingDmCall).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dm-call-again"));
    expect(flows.callAgainDmCall).toHaveBeenCalled();
  });

  it("after a decline: the line and Call again, no Cancel", () => {
    useDmCalls.setState({ active: outgoing({ phase: "declined", endedAt: 1 }) });
    render(<DmCallLayer />);
    expect(screen.getByTestId("dm-calling-line").textContent).toBe("Alex declined");
    expect(screen.queryByTestId("dm-call-cancel")).toBeNull();
    expect(screen.getByTestId("dm-call-again")).toBeTruthy();
  });

  it("no bar once the call is up, nor for the one who answered", () => {
    useDmCalls.setState({ active: outgoing({ phase: "connected" }) });
    render(<DmCallLayer />);
    expect(screen.queryByTestId("dm-calling-bar")).toBeNull();
    act(() => useDmCalls.setState({ active: outgoing({ role: "answerer", phase: "joining" }) }));
    expect(screen.queryByTestId("dm-calling-bar")).toBeNull();
  });

  it("a notice with Try again calls again", () => {
    useDmCalls.setState({
      notice: { text: "Calls on box are restarting. Try again in a moment.", retry: { serverId: "s1", conv: "900", name: "Alex" } },
    });
    render(<DmCallLayer />);
    fireEvent.click(screen.getByTestId("dm-call-retry"));
    expect(flows.startDmCall).toHaveBeenCalledWith("s1", "900", { name: "Alex" });
    expect(useDmCalls.getState().notice).toBeNull();
  });
});

describe("DmCallButton", () => {
  it("calls the DM", () => {
    render(<DmCallButton serverId="s1" conversationId="900" name="Alex" />);
    const b = screen.getByTestId("dm-call-button");
    expect(b.getAttribute("aria-label")).toBe("Call Alex");
    fireEvent.click(b);
    expect(flows.startDmCall).toHaveBeenCalledWith("s1", "900", { name: "Alex" });
  });

  it("waits while it rings out, and opens the call screen once in the call", () => {
    useDmCalls.setState({ active: outgoing() });
    render(<DmCallButton serverId="s1" conversationId="900" name="Alex" />);
    expect(screen.getByTestId("dm-call-button").getAttribute("data-state")).toBe("calling");
    act(() => {
      useDmCalls.setState({ active: outgoing({ phase: "connected" }) });
      useVoiceCall.setState({
        phase: "connected",
        room: { serverId: "s1", serverLabel: "box", roomId: "dm:900", roomName: "Alex", limit: 2, dm: { conv: "900" } },
      });
    });
    const b = screen.getByTestId("dm-call-button");
    expect(b.getAttribute("data-state")).toBe("in-call");
    fireEvent.click(b);
    expect(useCallScreen.getState().open).toBe(true);
    expect(flows.startDmCall).not.toHaveBeenCalled();
    act(() => {
      useVoiceCall.setState({ phase: "idle", room: null });
      useCallScreen.setState({ open: false });
    });
  });
});
