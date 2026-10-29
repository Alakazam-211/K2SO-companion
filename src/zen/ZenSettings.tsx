import type { ReactNode } from "react";
import { ABOUT } from "../lib/about";
import { usePushToggle } from "../lib/usePushToggle";
import { ZEN_FONTS, ZEN_TEXT_SIZES, useZenFontStore } from "./zenFont";
import { useMultiServerPrefs } from "./multi/prefs";
import { useRecentFirstStore } from "./recentFirst";
import { useJumpOnSendStore } from "./jumpOnSend";
import { useStashStore } from "./stash/stashStore";
import { useBackHandler } from "../lib/androidBack";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
/** iOS system green. */
const SWITCH_ON = "#30d158";

/** Zen Settings sheet (opened by the Chats header cog). iOS grouped list
 *  of `.k2-tile` cards: Notifications (the same push toggle as the old
 *  Settings page), Appearance (Zen font + text size), Lists (Recent
 *  agents first, this phone only), Experimental, and About (the old
 *  page's values plus Terminal: Kessel). The pre-Zen UI (and its
 *  "Leave Zen Mode" door) was removed in 4.1.0. */
export function ZenSettings({ onClose }: { onClose: () => void }) {
  // Android Back = Done.
  useBackHandler(true, onClose);
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
          padding: "0 16px calc(24px + var(--safe-bottom))",
          WebkitOverflowScrolling: "touch",
        }}
        data-testid="settings-scroll"
      >
        <Group label="Notifications" testId="settings-notifications">
          <PushRow />
        </Group>

        <Group label="Appearance" testId="settings-appearance">
          <FontRow />
          <TextSizeRow />
        </Group>

        <Group
          label="Chats"
          testId="settings-chats"
          footnote="Jump to newest off: sending while you read earlier messages keeps your place. Remove from stash after use on: a saved message goes from your stash once you put it in a chat. Only this phone."
        >
          <JumpOnSendRow />
          <StashRemoveAfterUseRow />
        </Group>

        <Group
          label="Lists"
          testId="settings-lists"
          footnote="Below your pinned agents, the agents you last messaged from this phone come first, on Home and Agents. Only this phone."
        >
          <RecentFirstRow />
        </Group>

        <Group
          label="Experimental"
          testId="settings-experimental"
          footnote="Lists the agents of every saved server in one place. Opening an agent on another server switches to that server."
        >
          <MultiServerRow />
        </Group>

        <Group label="About" testId="settings-about">
          <ValueRow label="App" value={ABOUT.app} />
          <ValueRow label="Version" value={ABOUT.version} divider />
          <ValueRow label="Engine" value={ABOUT.engine} divider />
          <ValueRow label="Terminal" value={ABOUT.terminal} divider />
        </Group>
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

/** Multi-server S2 (MS40): the device setting `zen.multiServer`, default
 *  ON for now when never set (an explicit off is kept). Off, the Agents
 *  list shows the active server only, as before. */
function MultiServerRow() {
  const on = useMultiServerPrefs((s) => s.multiServer);
  const setOn = useMultiServerPrefs((s) => s.setMultiServer);
  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}
    >
      <span id="zen-multi-server-label">Show agents from all servers</span>
      <span className="flex items-center shrink-0" data-testid="multi-server-switch">
        <Switch
          on={on}
          disabled={false}
          onToggle={() => setOn(!on)}
          labelledBy="zen-multi-server-label"
        />
      </span>
    </div>
  );
}

/** "Jump to newest when I send" (`jumpOnSend.ts`): phone-only, default on. */
function JumpOnSendRow() {
  const on = useJumpOnSendStore((s) => s.on);
  const setOn = useJumpOnSendStore((s) => s.setOn);
  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}
    >
      <span id="zen-jump-on-send-label">Jump to newest when I send</span>
      <span className="flex items-center shrink-0" data-testid="jump-on-send-switch">
        <Switch on={on} disabled={false} onToggle={() => setOn(!on)} labelledBy="zen-jump-on-send-label" />
      </span>
    </div>
  );
}

/** "Remove from stash after use" (stash/stashStore): a phone-only
 *  setting, default off (a used stash stays, a template). */
function StashRemoveAfterUseRow() {
  const on = useStashStore((s) => s.removeAfterUse);
  const setOn = useStashStore((s) => s.setRemoveAfterUse);
  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12, borderTop: HAIRLINE }}
    >
      <span id="zen-stash-remove-label">Remove from stash after use</span>
      <span className="flex items-center shrink-0" data-testid="stash-remove-after-use-switch">
        <Switch on={on} disabled={false} onToggle={() => setOn(!on)} labelledBy="zen-stash-remove-label" />
      </span>
    </div>
  );
}

/** "Recent agents first" (`recentFirst.ts`): a phone-only setting,
 *  default off. Never sent to the server. */
function RecentFirstRow() {
  const on = useRecentFirstStore((s) => s.on);
  const setOn = useRecentFirstStore((s) => s.setOn);
  return (
    <div
      className="flex items-center justify-between text-[17px]"
      style={{ minHeight: 44, padding: "6px 12px 6px 16px", gap: 12 }}
    >
      <span id="zen-recent-first-label">Recent agents first</span>
      <span className="flex items-center shrink-0" data-testid="recent-first-switch">
        <Switch
          on={on}
          disabled={false}
          onToggle={() => setOn(!on)}
          labelledBy="zen-recent-first-label"
        />
      </span>
    </div>
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

/** Content text size: an iOS stepped slider (Small / Default / Large).
 *  A native range input (0–2, step 1) over a glass track with three
 *  ticks; the white knob is the input's own thumb (.zen-text-slider in
 *  index.css). The track is inset by half the knob so the ticks sit
 *  under the knob's centre at each stop. */
function TextSizeRow() {
  const textSize = useZenFontStore((s) => s.textSize);
  const setTextSize = useZenFontStore((s) => s.setTextSize);
  const index = Math.max(
    0,
    ZEN_TEXT_SIZES.findIndex((t) => t.value === textSize)
  );
  const current = ZEN_TEXT_SIZES[index];
  return (
    <div
      className="flex flex-col text-[17px]"
      style={{ padding: "11px 12px 4px 16px", borderTop: HAIRLINE }}
      data-testid="text-size-row"
    >
      <div className="flex items-center justify-between" style={{ gap: 12 }}>
        <span id="zen-text-size-label">Text Size</span>
        <span style={{ color: MUTED }} data-testid="text-size-value">
          {current.label}
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 12 }}>
        <span aria-hidden className="shrink-0 text-[13px]" style={{ color: MUTED }}>
          A
        </span>
        <div className="relative flex-1 min-w-0" style={{ height: 44 }}>
          <div
            aria-hidden
            className="absolute pointer-events-none"
            style={{ left: SLIDER_KNOB / 2, right: SLIDER_KNOB / 2, top: 0, bottom: 0 }}
          >
            <span
              className="absolute zen-glass zen-glass-pill"
              style={{ left: 0, right: 0, top: "50%", height: 6, transform: "translateY(-50%)" }}
              data-testid="text-size-track"
            />
            {ZEN_TEXT_SIZES.map((t, i) => (
              <span
                key={t.value}
                className="absolute"
                data-testid="text-size-tick"
                style={{
                  left: `${(i / (ZEN_TEXT_SIZES.length - 1)) * 100}%`,
                  top: "50%",
                  width: 2,
                  height: 12,
                  borderRadius: 1,
                  background: "rgba(255,255,255,.45)",
                  transform: "translate(-50%, -50%)",
                }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={ZEN_TEXT_SIZES.length - 1}
            step={1}
            value={index}
            onChange={(e) => {
              const next = ZEN_TEXT_SIZES[Number(e.target.value)];
              if (next) setTextSize(next.value);
            }}
            aria-labelledby="zen-text-size-label"
            aria-valuetext={current.label}
            className="zen-text-slider absolute inset-0"
            data-testid="text-size-slider"
          />
        </div>
        <span aria-hidden className="shrink-0 text-[20px]" style={{ color: MUTED }}>
          A
        </span>
      </div>
    </div>
  );
}

/** Knob diameter; matches .zen-text-slider's thumb. */
const SLIDER_KNOB = 28;

export function Switch({
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
