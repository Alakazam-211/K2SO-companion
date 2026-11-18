import { useEffect, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Phone, PhoneOff, RotateCw, X } from "lucide-react";
import { useServersStore } from "../../stores/servers";
import { callingLine } from "./dmCallText";
import {
  acceptRing,
  callAgainDmCall,
  canRingAgain,
  cancelOutgoingDmCall,
  clearDmCallNotice,
  declineRing,
  startDmCall,
  useDmCalls,
  type ActiveDmCall,
  type IncomingRing,
} from "./dmCall";
import { requestOpenHomeChat } from "./homeChatOpen";
import { ringTone } from "./ringTone";
import { useCallRingStore } from "./callRing";

// DM calls over every screen (mounted once, App.tsx), top of the screen:
//   - a ring card per incoming ring: the caller, "Incoming call", Decline
//     and Accept; the ring sound unless the ring is silent or Settings →
//     Calls → Ring for incoming calls is off (callRing.ts); it goes the
//     moment the ring stops (any reason) or times out;
//   - the caller's bar: "Calling Alex…" with Cancel and Call again, then
//     "Alex declined" / "Alex didn't answer" with Call again for a moment;
//   - the last line worth saying (a gate, a failed join, a cancel that
//     fell back to a leave), with Try again when it's worth one.
// Once the call is up, the voice call's own tile and call screen take over.
// Palette tokens only (docs/glass-palettes-conversion.md).

const CIRCLE = 44;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

function Avatar({ name }: { name: string }) {
  return (
    <div
      className="shrink-0 flex items-center justify-center text-[15px] font-semibold"
      style={{
        width: CIRCLE,
        height: CIRCLE,
        borderRadius: CIRCLE / 2,
        background: "var(--color-bg-elevated)",
        color: "var(--color-text-primary)",
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

function RoundButton({
  label,
  kind,
  onClick,
  disabled,
  testId,
  children,
}: {
  label: string;
  kind: "accept" | "decline" | "plain";
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  children: ReactNode;
}) {
  const fill =
    kind === "accept" ? "var(--color-status-ok)" : kind === "decline" ? "var(--color-danger)" : "var(--color-bg-elevated)";
  const ink = kind === "plain" ? "var(--color-text-primary)" : "var(--color-on-danger)";
  return (
    <button
      type="button"
      className="shrink-0 flex items-center justify-center"
      style={{
        width: CIRCLE,
        height: CIRCLE,
        borderRadius: CIRCLE / 2,
        background: fill,
        color: ink,
        opacity: disabled ? 0.5 : 1,
      }}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function Card({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      className="k2-tile flex items-center pointer-events-auto"
      style={{
        gap: 12,
        padding: "10px 12px",
        borderRadius: 18,
        background: "var(--color-bg-surface)",
        boxShadow: "0 8px 24px var(--color-shadow)",
      }}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** One incoming ring. A tap on the words opens the DM. */
export function RingCard({ ring, showServer }: { ring: IncomingRing; showServer: boolean }) {
  const busy = ring.busy !== null;
  return (
    <Card testId="dm-ring-card">
      <button
        type="button"
        className="min-w-0 flex-1 flex items-center text-left"
        style={{ gap: 12 }}
        onClick={() => requestOpenHomeChat(ring.serverId, ring.conv, "ring-card")}
      >
        <Avatar name={ring.callerName} />
        <span className="min-w-0 flex flex-col">
          <span className="text-[16px] font-semibold truncate" style={{ color: "var(--color-text-primary)" }} data-testid="dm-ring-name">
            {ring.callerName}
          </span>
          <span className="text-[13px] truncate" style={{ color: "var(--color-text-secondary)" }} data-testid="dm-ring-sub">
            {ring.busy === "accepting"
              ? "Joining…"
              : ring.busy === "declining"
                ? "Declining…"
                : showServer && ring.serverLabel
                  ? `Incoming call · ${ring.serverLabel}`
                  : "Incoming call"}
          </span>
        </span>
      </button>
      <RoundButton label={`Decline the call from ${ring.callerName}`} kind="decline" disabled={busy} onClick={() => void declineRing(ring.key)} testId="dm-ring-decline">
        <PhoneOff size={20} aria-hidden="true" />
      </RoundButton>
      <RoundButton label={`Accept the call from ${ring.callerName}`} kind="accept" disabled={busy} onClick={() => void acceptRing(ring.key)} testId="dm-ring-accept">
        <Phone size={20} aria-hidden="true" />
      </RoundButton>
    </Card>
  );
}

/** The caller's bar while it rings, and its last word. */
export function CallingBar({ call }: { call: ActiveDmCall }) {
  if (call.role !== "caller" || call.phase === "connected") return null;
  const ringingOut = call.phase === "joining" || call.phase === "ringing" || call.phase === "busy";
  const again = canRingAgain(call);
  return (
    <Card testId="dm-calling-bar">
      <Avatar name={call.name} />
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold truncate" style={{ color: "var(--color-text-primary)" }} data-testid="dm-calling-line">
          {callingLine(call.phase === "joining" ? "joining" : call.phase, call.name)}
        </div>
        {call.serverLabel ? (
          <div className="text-[13px] truncate" style={{ color: "var(--color-text-muted)" }}>
            {call.serverLabel}
          </div>
        ) : null}
      </div>
      {again ? (
        <RoundButton label={ringingOut ? `Ring ${call.name} again` : `Call ${call.name} again`} kind="plain" onClick={() => void callAgainDmCall()} testId="dm-call-again">
          <RotateCw size={18} aria-hidden="true" />
        </RoundButton>
      ) : null}
      {ringingOut ? (
        <RoundButton label="Cancel the call" kind="decline" onClick={() => void cancelOutgoingDmCall()} testId="dm-call-cancel">
          <PhoneOff size={20} aria-hidden="true" />
        </RoundButton>
      ) : null}
    </Card>
  );
}

function NoticeLine() {
  const notice = useDmCalls((s) => s.notice);
  if (!notice) return null;
  return (
    <Card testId="dm-call-notice">
      <p className="min-w-0 flex-1 text-[14px]" style={{ color: "var(--color-status-warn-text)" }} data-testid="dm-call-notice-text">
        {notice.text}
      </p>
      {notice.retry ? (
        <button
          type="button"
          className="zen-glass zen-glass-pill text-[14px] shrink-0"
          style={{ minHeight: 34, padding: "0 12px", color: "var(--color-text-primary)" }}
          onClick={() => {
            const t = notice.retry;
            clearDmCallNotice();
            if (t) void startDmCall(t.serverId, t.conv, { name: t.name });
          }}
          data-testid="dm-call-retry"
        >
          Try again
        </button>
      ) : null}
      <button
        type="button"
        className="shrink-0 flex items-center justify-center"
        style={{ width: 32, height: 32, color: "var(--color-text-muted)" }}
        aria-label="Dismiss"
        onClick={clearDmCallNotice}
        data-testid="dm-call-notice-close"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </Card>
  );
}

/** The ring sound: on while any ring isn't silent and the ring setting is on. */
function useRingSound(loud: boolean): void {
  useEffect(() => {
    const tone = ringTone();
    if (loud) tone.start();
    else tone.stop();
    return () => tone.stop();
  }, [loud]);
}

export function DmCallLayer() {
  const rings = useDmCalls((s) => s.rings);
  const active = useDmCalls((s) => s.active);
  const notice = useDmCalls((s) => s.notice);
  const servers = useServersStore((s) => s.servers.length);
  const ringOn = useCallRingStore((s) => s.on);
  const loud = useMemo(() => ringOn && rings.some((r) => !r.silent && r.busy === null), [rings, ringOn]);
  useRingSound(loud);
  const showBar = !!active && active.role === "caller" && active.phase !== "connected";
  if (rings.length === 0 && !showBar && !notice) return null;
  return createPortal(
    <div
      className="fixed left-0 right-0 flex flex-col pointer-events-none zen-font"
      style={{ top: "calc(env(safe-area-inset-top) + 8px)", padding: "0 12px", gap: 8, zIndex: 60 }}
      role="region"
      aria-label="Calls"
      data-testid="dm-call-layer"
    >
      {rings.map((r) => (
        <RingCard key={r.key} ring={r} showServer={servers > 1} />
      ))}
      {showBar && active ? <CallingBar call={active} /> : null}
      <NoticeLine />
    </div>,
    document.body
  );
}
