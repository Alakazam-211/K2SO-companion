// Settings → Themes (Riley 2026-11-16; desktop's Settings → Themes, K2
// StylesSection.tsx): Light, Dark or Auto; the palette for each side, which
// are also Auto's two picks; and an accent for each of the three palettes.
// The tokens and accent maths are K2's own (src/theme; wiki "Plan - Glass
// Palettes"). Per device, as on the desktop.

import { useState, type ReactNode } from "react";
import { useBackHandler } from "../lib/androidBack";
import { BackArrowButton } from "./BackArrowButton";
import { PALETTES, paletteById, type Palette, type PaletteId, type SchemeMode } from "../theme/palettes";
import { accentFillHex } from "../theme/styleAccent";
import { useThemeStore } from "../theme/themeStore";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";
/** A picked swatch or card: iOS's ring with a page-colour gap. */
const PICKED_RING = "0 0 0 2px #1c1c1e, 0 0 0 4px #fff";

export const SCHEME_MODES: readonly { id: SchemeMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "auto", label: "Auto" },
];

/** Presets after the palette's own: iOS's system colours (dark variants),
 *  and `yellow`, desktop's named gold (its own light and dark values). */
export const ACCENT_PRESETS: readonly { choice: string; label: string }[] = [
  { choice: "#0a84ff", label: "Blue" },
  { choice: "#bf5af2", label: "Purple" },
  { choice: "#ff375f", label: "Pink" },
  { choice: "#ff453a", label: "Red" },
  { choice: "#ff9f0a", label: "Orange" },
  { choice: "yellow", label: "Yellow" },
  { choice: "#30d158", label: "Green" },
  { choice: "#40c8e0", label: "Teal" },
  { choice: "#8e8e93", label: "Graphite" },
];

/** What Settings' Themes row says: the palette on screen, and Auto. */
export function themeSummary(shown: PaletteId, mode: SchemeMode): string {
  const name = paletteById(shown)?.name ?? "Obsidian";
  return mode === "auto" ? `Auto · ${name}` : name;
}

function Group({ label, footnote, testId, children }: { label: string; footnote?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 20 }} data-testid={testId}>
      <h2 className="text-[12px] uppercase tracking-wide font-normal" style={{ color: MUTED, padding: "0 16px 6px" }}>
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

/** iOS segmented control in the settings glass (the Font row's look). */
function Segments<T extends string>({
  options,
  value,
  onPick,
  label,
  testId,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onPick: (id: T) => void;
  label: string;
  testId: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex min-w-0 zen-glass zen-glass-pill" style={{ padding: 2 }} data-testid={testId}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`${testId}-${o.id}`}
            onClick={() => onPick(o.id)}
            className="flex-1 min-w-0 truncate text-[13px] font-medium border-0 rounded-full transition-colors duration-150 motion-reduce:transition-none"
            style={{
              height: 28,
              padding: "0 8px",
              color: on ? "#fff" : "#a1a1aa",
              background: on ? "rgba(255,255,255,0.18)" : "transparent",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A palette as a small preview: its page, a surface bubble, a line of its
 *  text and its accent (this palette's own choice). */
function PaletteCard({ p, picked, onPick }: { p: Palette; picked: boolean; onPick: () => void }) {
  const accent = useThemeStore((s) => s.accents[p.id]);
  const fill = accentFillHex(accent, p, p.scheme);
  const text = p.vars["--color-text-primary"];
  const bubble = p.vars["--color-bubble-agent"] ?? p.swatch.surface;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={picked}
      aria-label={`${p.name}, ${p.scheme === "light" ? "light" : "dark"}`}
      data-testid={`theme-palette-${p.id}`}
      onClick={onPick}
      className="flex flex-col items-center border-0 p-0 bg-transparent"
      style={{ gap: 6, width: 92 }}
    >
      <span
        aria-hidden
        className="flex flex-col justify-end"
        style={{
          width: 92,
          height: 64,
          borderRadius: 12,
          padding: 8,
          gap: 5,
          background: p.swatch.bg,
          boxShadow: picked ? PICKED_RING : "inset 0 0 0 1px rgba(255,255,255,.18)",
        }}
      >
        <span style={{ alignSelf: "flex-start", width: 46, height: 12, borderRadius: 6, background: bubble }} />
        <span className="flex items-center justify-between">
          <span style={{ width: 34, height: 4, borderRadius: 2, background: text, opacity: 0.8 }} />
          <span style={{ width: 16, height: 16, borderRadius: 8, background: fill }} />
        </span>
      </span>
      <span className="text-[13px]" style={{ color: picked ? "#fff" : "#a1a1aa" }}>
        {p.name}
      </span>
    </button>
  );
}

function PaletteSide({ side }: { side: "light" | "dark" }) {
  const current = useThemeStore((s) => s[side]);
  const pickPalette = useThemeStore((s) => s.pickPalette);
  return (
    <div
      role="radiogroup"
      aria-label={side === "light" ? "Light palette" : "Dark palette"}
      className="flex flex-wrap"
      style={{ padding: "14px 16px", gap: 16 }}
      data-testid={`theme-side-${side}`}
    >
      {PALETTES.filter((p) => p.scheme === side).map((p) => (
        <PaletteCard key={p.id} p={p} picked={p.id === current} onPick={() => pickPalette(p.id)} />
      ))}
    </div>
  );
}

function Swatch({ color, label, on, onPick, testId }: { color: string; label: string; on: boolean; onPick: () => void; testId: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      onClick={onPick}
      className="shrink-0 rounded-full border-0 p-0"
      style={{ width: 30, height: 30, background: color, boxShadow: on ? PICKED_RING : "inset 0 0 0 1px rgba(255,255,255,.18)" }}
    />
  );
}

/** One palette's accent: its own, a preset, or any colour (iOS's picker). */
function AccentPicker({ p }: { p: Palette }) {
  const accent = useThemeStore((s) => s.accents[p.id]);
  const setAccent = useThemeStore((s) => s.setAccent);
  const custom = accent !== null && !ACCENT_PRESETS.some((x) => x.choice === accent);
  const shown = accentFillHex(accent, p, p.scheme);
  return (
    <div className="flex flex-col text-[17px]" style={{ padding: "11px 16px 14px", gap: 12, borderTop: HAIRLINE }}>
      <div className="flex items-center justify-between" style={{ gap: 12 }}>
        <span id="theme-accent-label">{p.name}'s accent</span>
        <span style={{ color: MUTED }} data-testid="accent-value">
          {accent === null ? "Its own" : (ACCENT_PRESETS.find((x) => x.choice === accent)?.label ?? shown.toUpperCase())}
        </span>
      </div>
      <div role="radiogroup" aria-labelledby="theme-accent-label" className="flex flex-wrap items-center" style={{ gap: 12 }} data-testid="accent-swatches">
        <Swatch color={accentFillHex(null, p, p.scheme)} label={`${p.name}'s own`} on={accent === null} onPick={() => setAccent(p.id, null)} testId="accent-own" />
        {ACCENT_PRESETS.map((x) => (
          <Swatch
            key={x.choice}
            color={accentFillHex(x.choice, p, p.scheme)}
            label={x.label}
            on={accent === x.choice}
            onPick={() => setAccent(p.id, x.choice)}
            testId={`accent-${x.label.toLowerCase()}`}
          />
        ))}
        <label
          className="relative shrink-0 rounded-full overflow-hidden"
          style={{
            width: 30,
            height: 30,
            background: custom ? shown : "conic-gradient(#ff453a, #ff9f0a, #ffd60a, #30d158, #40c8e0, #0a84ff, #bf5af2, #ff375f, #ff453a)",
            boxShadow: custom ? PICKED_RING : "inset 0 0 0 1px rgba(255,255,255,.18)",
          }}
        >
          <input
            type="color"
            aria-label={`Any colour for ${p.name}'s accent`}
            data-testid="accent-custom"
            value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : "#0a84ff"}
            onChange={(e) => setAccent(p.id, e.target.value)}
            className="absolute inset-0 opacity-0"
            style={{ width: "100%", height: "100%" }}
          />
        </label>
      </div>
    </div>
  );
}

export function ThemesPage({ onBack }: { onBack: () => void }) {
  useBackHandler(true, onBack);
  const mode = useThemeStore((s) => s.mode);
  const shown = useThemeStore((s) => s.shown);
  const setMode = useThemeStore((s) => s.setMode);
  // Whose accent is being edited: the palette on screen to start with.
  const [editing, setEditing] = useState<PaletteId>(shown);
  const editingPalette = paletteById(editing) ?? PALETTES[0];
  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ background: "#000", zIndex: 7, paddingTop: "env(safe-area-inset-top)" }}
      data-testid="themes-page"
    >
      <div className="grid items-center shrink-0" style={{ gridTemplateColumns: "1fr auto 1fr", minHeight: 44, padding: "12px 12px 8px", columnGap: 8 }}>
        <BackArrowButton onClick={onBack} />
        <h1 className="text-[17px] font-semibold pointer-events-none">Themes</h1>
        <span />
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ padding: "0 16px calc(24px + var(--safe-bottom))", WebkitOverflowScrolling: "touch" }}
        data-testid="themes-scroll"
      >
        <Group label="Appearance" testId="themes-appearance" footnote={mode === "auto" ? "Auto follows your iPhone's Light or Dark appearance, with the palettes below." : undefined}>
          <div style={{ padding: "11px 12px 12px 16px" }}>
            <Segments options={SCHEME_MODES} value={mode} onPick={setMode} label="Light, Dark or Auto" testId="theme-mode" />
          </div>
        </Group>

        <Group label="Light palette" testId="themes-light">
          <PaletteSide side="light" />
        </Group>

        <Group label="Dark palette" testId="themes-dark" footnote="Each palette keeps its own accent below. Only this phone.">
          <PaletteSide side="dark" />
        </Group>

        <Group label="Accent" testId="themes-accent">
          <div style={{ padding: "11px 12px 12px 16px" }}>
            <Segments
              options={PALETTES.map((p) => ({ id: p.id, label: p.name }))}
              value={editing}
              onPick={setEditing}
              label="Which palette's accent"
              testId="accent-palette"
            />
          </div>
          <AccentPicker p={editingPalette} />
        </Group>
      </div>
    </div>
  );
}
