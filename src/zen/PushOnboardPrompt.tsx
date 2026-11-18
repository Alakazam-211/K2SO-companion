// The one-time push onboarding prompt (4.3.0): the app's bottom-sheet
// confirm look (HomeConfirmSheet), asked once the first screen has
// settled. Who sees it and what the answers do: src/lib/pushOnboard.ts.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellRing } from "lucide-react";
import { useBackHandler } from "../lib/androidBack";
import { acceptPushOnboard, decidePushOnboard, dismissPushOnboard } from "../lib/pushOnboard";
import { useCallScreen } from "./voice/callScreen";
import { useVoiceCall } from "./voice/voiceCall";
import { useDmCalls } from "./calls/dmCall";

/** After launch, before the first look (launch animations, the list
 *  settling). */
export const PUSH_ONBOARD_DELAY_MS = 1800;
/** While the screen is busy, look again this often. */
export const PUSH_ONBOARD_RETRY_MS = 1000;

export const PUSH_ONBOARD_COPY = {
  title: "Would you like push notifications from your agents?",
  body: "K2 can tell you when an agent replies or needs you.",
  denied: "Notifications are off in iOS Settings for K2.",
  yes: "Turn on notifications",
  yesDenied: "Turn on in Settings",
  no: "Not now",
} as const;

/** Something the prompt must not cover: another sheet or dialog, the
 *  "Set your new password" step, a call (ringing, joining, in it), the
 *  person typing, or the app in the background. */
export function pushOnboardBlocked(doc: Document = document): boolean {
  if (doc.visibilityState === "hidden") return true;
  if (
    doc.querySelector(
      '[aria-modal="true"], [role="dialog"], [role="alertdialog"], [data-testid="set-password"], [data-testid="voice-call-screen"]'
    )
  ) {
    return true;
  }
  const el = doc.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return true;
  if (useCallScreen.getState().open) return true;
  if (useVoiceCall.getState().phase !== "idle") return true;
  const dm = useDmCalls.getState();
  return dm.rings.length > 0 || dm.active !== null;
}

/** Mount once in the app shell. */
export function PushOnboardHost({
  delayMs = PUSH_ONBOARD_DELAY_MS,
  retryMs = PUSH_ONBOARD_RETRY_MS,
  blocked = pushOnboardBlocked,
}: {
  delayMs?: number;
  retryMs?: number;
  blocked?: () => boolean;
}) {
  const [ask, setAsk] = useState<{ denied: boolean } | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) =>
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
      });
    void (async () => {
      await wait(delayMs);
      if (!alive) return;
      const d = await decidePushOnboard();
      if (!alive || !d.show) return;
      while (alive && blockedRef.current()) await wait(retryMs);
      if (alive) setAsk({ denied: d.denied });
    })();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [delayMs, retryMs]);

  if (!ask) return null;
  return (
    <PushOnboardSheet
      denied={ask.denied}
      onYes={() => {
        setAsk(null);
        void acceptPushOnboard(ask.denied);
      }}
      onNo={() => {
        setAsk(null);
        dismissPushOnboard();
      }}
    />
  );
}

function PushOnboardSheet({ denied, onYes, onNo }: { denied: boolean; onYes: () => void; onNo: () => void }) {
  // Android Back = Not now.
  useBackHandler(true, onNo);
  return createPortal(
    <div
      className="fixed inset-0 flex items-end justify-center"
      style={{ background: "var(--color-scrim)", zIndex: 60, fontFamily: "var(--zen-font)" }}
      data-testid="push-onboard"
      onClick={(e) => {
        if (e.target === e.currentTarget) onNo();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="push-onboard-title"
        className="w-full k2-tile k2-tile-sheet flex flex-col items-center"
        style={{
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          padding: "20px 16px max(12px, var(--safe-bottom))",
          gap: 12,
          color: "var(--color-text-primary)",
        }}
      >
        <BellRing size={28} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-accent-text)" }} />
        <h2 id="push-onboard-title" className="text-[17px] font-semibold text-center" style={{ lineHeight: 1.3 }}>
          {PUSH_ONBOARD_COPY.title}
        </h2>
        <p
          className="text-[14px] text-center"
          style={{ color: "var(--color-text-secondary)", lineHeight: 1.4 }}
          data-testid="push-onboard-body"
        >
          {PUSH_ONBOARD_COPY.body}
          {denied ? ` ${PUSH_ONBOARD_COPY.denied}` : ""}
        </p>
        <div className="flex flex-col w-full" style={{ gap: 8, marginTop: 2 }}>
          <button
            type="button"
            className="w-full text-[17px] font-semibold"
            style={{
              minHeight: 48,
              borderRadius: 12,
              border: 0,
              background: "var(--color-accent-fill)",
              color: "var(--color-on-accent)",
            }}
            data-testid="push-onboard-yes"
            onClick={onYes}
          >
            {denied ? PUSH_ONBOARD_COPY.yesDenied : PUSH_ONBOARD_COPY.yes}
          </button>
          <button
            type="button"
            className="w-full text-[17px] bg-transparent"
            style={{ minHeight: 44, border: 0, color: "var(--color-accent-text)" }}
            data-testid="push-onboard-no"
            onClick={onNo}
          >
            {PUSH_ONBOARD_COPY.no}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
