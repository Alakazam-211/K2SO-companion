import { Phone, PhoneCall } from "lucide-react";
import { useCallScreen } from "../voice/callScreen";
import { useVoiceCall } from "../voice/voiceCall";
import { isFinalPhase, startDmCall, useDmCalls, type DmCallPhase } from "./dmCall";

// The Call button for a DM's header (the chat view's `headerActions`
// slot). Idle: calls. While this DM's call is up: opens the call screen.
// While it rings out: the layer's bar (DmCallLayer) has Cancel, so this
// only shows it's calling.

export interface DmCallState {
  /** This DM's call here: its phase, or null for none. */
  phase: DmCallPhase | null;
  /** The media is up for this DM (joining, connected or reconnecting). */
  inCall: boolean;
}

/** This DM's call, for a header or a record line. */
export function useDmCallState(serverId: string, conversationId: string): DmCallState {
  const phase = useDmCalls((s) =>
    s.active && s.active.serverId === serverId && s.active.conv === conversationId && !isFinalPhase(s.active.phase)
      ? s.active.phase
      : null
  );
  const inCall = useVoiceCall(
    (s) => s.phase !== "idle" && s.room?.serverId === serverId && s.room?.dm?.conv === conversationId
  );
  return { phase, inCall };
}

/** Call back from a call's record line (`onCallBack(conversation)`). */
export function callBack(serverId: string, conversationId: string, name?: string | null) {
  return startDmCall(serverId, conversationId, { name });
}

export function DmCallButton({
  serverId,
  conversationId,
  name,
  size = 36,
}: {
  serverId: string;
  conversationId: string;
  /** The other person's name (the bar, the call screen). */
  name: string;
  size?: number;
}) {
  const { phase, inCall } = useDmCallState(serverId, conversationId);
  const callingOut = phase === "joining" || phase === "ringing" || phase === "busy";
  const label = inCall && !callingOut ? `Open the call with ${name}` : callingOut ? `Calling ${name}` : `Call ${name}`;
  return (
    <button
      type="button"
      className="zen-glass zen-glass-pill flex items-center justify-center"
      style={{
        width: size,
        height: size,
        padding: 0,
        color: inCall || callingOut ? "var(--color-status-ok)" : "var(--color-text-primary)",
      }}
      aria-label={label}
      disabled={callingOut}
      onClick={() => {
        if (inCall) useCallScreen.getState().ask();
        else void startDmCall(serverId, conversationId, { name });
      }}
      data-testid="dm-call-button"
      data-state={inCall ? "in-call" : callingOut ? "calling" : "idle"}
    >
      {inCall || callingOut ? <PhoneCall size={18} aria-hidden="true" /> : <Phone size={18} aria-hidden="true" />}
    </button>
  );
}
