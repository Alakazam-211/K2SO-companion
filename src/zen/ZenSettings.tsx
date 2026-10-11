import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ABOUT } from "../lib/about";
import { usePushToggle } from "../lib/usePushToggle";
import { ZEN_FONTS, useZenFontStore } from "./zenFont";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
/** iOS system green. */
const SWITCH_ON = "#30d158";

/** Where "Leave Zen Mode" goes: the old UI's server list. `/servers` has
 *  no ServerGuard, so it never bounces back to `/zen`; the old UI's
 *  ZenReturnButton is the way back in. */
export const LEAVE_ZEN_PATH = "/servers";

/** Zen Settings sheet (opened by the Chats header cog). iOS grouped list
 *  of `.k2-tile` cards: Notifications (the same push toggle as the old
 *  Settings page), Appearance (Zen font), About (the same values as the
 *  old page), and Leave Zen Mode. */
export function ZenSettings({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 6, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="overlay-settings"
    >
      <div
        className="grid items-center shrink-0"
        style={{
          gridTemplateColumns: "1fr auto 1fr",
          minHeight: 44,
          padding: "12px 12px 8px",
          columnGap: 8,
        }}
      >
        <button
          type="button"
          className="text-[17px] justify-self-start zen-glass zen-glass-pill"
          style={{ minHeight: 34, padding: "0 14px", color: "#fff" }}
          onClick={onClose}
        >
          Done
        </button>
        <h1 className="text-[17px] font-semibold pointer-events-none">Settings</h1>
        <span />
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          padding: "0 16px calc(24px + env(safe-area-inset-bottom))",
          WebkitOverflowScrolling: "touch",
        }}
        data-testid="settings-scroll"
      >
        <Group label="Notifications" testId="settings-notifications">
          <PushRow />
        </Group>

        <Group label="Appearance" testId="settings-appearance">
          <FontRow />
        </Group>

        <Group label="About" testId="settings-about">
          <ValueRow label="App" value={ABOUT.app} />
          <ValueRow label="Version" value={ABOUT.version} divider />
          <ValueRow label="Engine" value={ABOUT.engine} divider />
        </Group>

        <div className="k2-tile overflow-hidden" style={{ borderRadius: 14, marginTop: 28 }}>
          <button
            type="button"
            className="w-full text-center text-[17px]"
            style={{ minHeight: 48, padding: "12px 16px", color: "var(--accent)" }}
            onClick={() => {
              onClose();
              navigate(LEAVE_ZEN_PATH);
            }}
          >
            Leave Zen Mode
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({
  label,
  testId,
  footnote,
  children,
}: {
  label: string;
  testId: string;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: 20 }} data-testid={testId}>
      <h2
        className="text-[12px] uppercase tracking-wide font-normal"
        style={{ color: MUTED, padding: "0 16px 6px" }}
      >
        {label}
      </h2>
      <div className="k2-tile overflow-hidden" style={{ borderRadius: 14 }}>
        {children}
      </div>
      {footnote ? (
        <p className="text-[13px]" style={{ color: MUTED, padding: "6px 16px 0", lineHeight: 1.35 }}>
          {footnote}
        </p>
      ) : null}
    </section>
  );
}

function ValueRow({
  label,
  value,
  divider,
}: {
  label: string;
  value: ReactNode;
  divider?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "11px 16px", borderTop: divider ? HAIRLINE : undefined }}
    >
      <span>{label}</span>
      <span className="truncate text-right" style={{ color: MUTED, marginLeft: 16, maxWidth: "60%" }}>
        {value}
      </span>
    </div>
  );
}

/** Same state and calls as the old Settings page's PushRow
 *  (`usePushToggle`). While the probe runs, or a toggle is in flight, the
 *  switch is disabled with a spinner beside it. Dormant builds show a
 *  disabled switch and the old page's "Unavailable…" text underneath. */
function PushRow() {
  const { available, reason, enabled, busy, toggle } = usePushToggle();
  const pending = available === null || busy;
  const unavailable = available === false;
  const note = unavailable
    ? reason
      ? `Unavailable: ${reason}`
      : "Not available in this build"
    : null;

  return (
    <>
      <div
        className="flex items-center justify-between text-[17px]"
        style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}
      >
        <span id="zen-push-label">Push Notifications</span>
        <span className="flex items-center shrink-0" style={{ gap: 10 }}>
          {pending ? <Spinner /> : null}
          <Switch
            on={enabled}
            disabled={pending || unavailable}
            onToggle={() => void toggle()}
            labelledBy="zen-push-label"
          />
        </span>
      </div>
      {note ? (
        <p
          className="text-[13px] break-words"
          style={{ color: MUTED, padding: "0 16px 10px", lineHeight: 1.35 }}
          data-testid="push-unavailable"
        >
          {note}
        </p>
      ) : null}
    </>
  );
}

/** Zen UI font: an iOS segmented control (System | Meslo Nerd Font).
 *  The control sits full-width under the label: in Meslo (wide mono) the
 *  "Meslo Nerd Font" segment does not fit beside the label at 375pt. */
function FontRow() {
  const font = useZenFontStore((s) => s.font);
  const setFont = useZenFontStore((s) => s.setFont);
  return (
    <div className="flex flex-col text-[17px]" style={{ padding: "11px 12px 12px 16px", gap: 10 }}>
      <span id="zen-font-label">Font</span>
      <div
        role="radiogroup"
        aria-labelledby="zen-font-label"
        className="flex min-w-0 zen-glass zen-glass-pill"
        style={{ padding: 2 }}
        data-testid="font-segments"
      >
        {ZEN_FONTS.map((f) => {
          const on = f.value === font;
          return (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`font-${f.value}`}
              onClick={() => setFont(f.value)}
              className="flex-1 min-w-0 truncate text-[13px] font-medium border-0 rounded-full transition-colors duration-150 motion-reduce:transition-none"
              style={{
                height: 28,
                padding: "0 8px",
                color: on ? "#fff" : "#a1a1aa",
                background: on ? "rgba(255,255,255,0.18)" : "transparent",
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Switch({
  on,
  disabled,
  onToggle,
  labelledBy,
}: {
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
  labelledBy: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onToggle}
      // 51×31 iOS track inside a 44px-tall hit area.
      className="flex items-center justify-center"
      style={{ height: 44, opacity: disabled ? 0.5 : 1 }}
    >
      <span
        className={`relative block transition-colors duration-200 motion-reduce:transition-none ${
          on ? "" : "zen-glass"
        }`}
        style={{
          width: 51,
          height: 31,
          borderRadius: 999,
          background: on ? SWITCH_ON : undefined,
          border: on ? "0.5px solid transparent" : undefined,
        }}
        data-testid="push-switch-track"
      >
        <span
          className="absolute transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{
            top: 1.5,
            left: 1.5,
            width: 27,
            height: 27,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 3px 8px rgba(0,0,0,.15), 0 1px 1px rgba(0,0,0,.16)",
            transform: on ? "translateX(20px)" : "translateX(0)",
          }}
        />
      </span>
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={MUTED}
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-label="Working"
      role="status"
      data-testid="push-pending"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
