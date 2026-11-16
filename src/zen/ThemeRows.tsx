// Settings → Appearance → Palette and Accent (src/theme; wiki "Plan - Glass
// Palettes"). K2 desktop Glass's three palettes, each with its own accent:
// the palette's own, a preset, or any colour (iOS's colour picker). The
// accent's derived colours (styleAccent.ts) keep any pick readable.

import { PALETTES, paletteById } from "../theme/palettes";
import { accentFillHex } from "../theme/styleAccent";
import { useThemeStore } from "../theme/themeStore";

const MUTED = "#8e8e93";
const HAIRLINE = "0.5px solid rgba(255,255,255,.12)";

/** Presets after the palette's own: iOS's system colours (dark variants), and
 *  `yellow`, desktop's named gold (its own light and dark values). */
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

export function PaletteRow() {
  const palette = useThemeStore((s) => s.palette);
  const setPalette = useThemeStore((s) => s.setPalette);
  return (
    <div className="flex flex-col text-[17px]" style={{ padding: "11px 12px 12px 16px", gap: 10 }}>
      <span id="zen-palette-label">Palette</span>
      <div
        role="radiogroup"
        aria-labelledby="zen-palette-label"
        className="flex min-w-0 zen-glass zen-glass-pill"
        style={{ padding: 2 }}
        data-testid="palette-segments"
      >
        {PALETTES.map((p) => {
          const on = p.id === palette;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`palette-${p.id}`}
              onClick={() => setPalette(p.id)}
              className="flex-1 min-w-0 truncate text-[13px] font-medium border-0 rounded-full transition-colors duration-150 motion-reduce:transition-none flex items-center justify-center"
              style={{
                height: 28,
                padding: "0 8px",
                gap: 6,
                color: on ? "#fff" : "#a1a1aa",
                background: on ? "rgba(255,255,255,0.18)" : "transparent",
              }}
            >
              <span
                aria-hidden
                className="shrink-0 rounded-full"
                style={{ width: 10, height: 10, background: p.swatch.bg, border: "1px solid rgba(255,255,255,.35)" }}
              />
              {p.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Swatch({
  color,
  label,
  on,
  onPick,
  testId,
}: {
  color: string;
  label: string;
  on: boolean;
  onPick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      onClick={onPick}
      className="shrink-0 rounded-full border-0 p-0"
      style={{
        width: 30,
        height: 30,
        background: color,
        // A ring with a page-colour gap, like iOS's picked colour.
        boxShadow: on ? "0 0 0 2px #1c1c1e, 0 0 0 4px #fff" : "inset 0 0 0 1px rgba(255,255,255,.18)",
      }}
    />
  );
}

export function AccentRow() {
  const paletteId = useThemeStore((s) => s.palette);
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);
  const palette = paletteById(paletteId) ?? PALETTES[0];
  const custom = accent !== null && accent !== "yellow" && !ACCENT_PRESETS.some((p) => p.choice === accent);
  const shown = accentFillHex(accent, palette, palette.scheme);
  return (
    <div className="flex flex-col text-[17px]" style={{ padding: "11px 12px 14px 16px", gap: 10, borderTop: HAIRLINE }}>
      <div className="flex items-center justify-between" style={{ gap: 12 }}>
        <span id="zen-accent-label">Accent</span>
        <span style={{ color: MUTED }} data-testid="accent-value">
          {accent === null
            ? `${palette.name}'s own`
            : (ACCENT_PRESETS.find((p) => p.choice === accent)?.label ?? shown.toUpperCase())}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="zen-accent-label"
        className="flex flex-wrap items-center"
        style={{ gap: 12 }}
        data-testid="accent-swatches"
      >
        <Swatch
          color={accentFillHex(null, palette, palette.scheme)}
          label={`${palette.name}'s own`}
          on={accent === null}
          onPick={() => setAccent(null)}
          testId="accent-own"
        />
        {ACCENT_PRESETS.map((p) => (
          <Swatch
            key={p.choice}
            color={accentFillHex(p.choice, palette, palette.scheme)}
            label={p.label}
            on={accent === p.choice}
            onPick={() => setAccent(p.choice)}
            testId={`accent-${p.label.toLowerCase()}`}
          />
        ))}
        {/* Any colour: iOS's own picker behind a rainbow well. */}
        <label
          className="relative shrink-0 rounded-full overflow-hidden"
          style={{
            width: 30,
            height: 30,
            background: custom ? shown : "conic-gradient(#ff453a, #ff9f0a, #ffd60a, #30d158, #40c8e0, #0a84ff, #bf5af2, #ff375f, #ff453a)",
            boxShadow: custom ? "0 0 0 2px #1c1c1e, 0 0 0 4px #fff" : "inset 0 0 0 1px rgba(255,255,255,.18)",
          }}
        >
          <input
            type="color"
            aria-label="Custom accent colour"
            data-testid="accent-custom"
            value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : "#0a84ff"}
            onChange={(e) => setAccent(e.target.value)}
            className="absolute inset-0 opacity-0"
            style={{ width: "100%", height: "100%" }}
          />
        </label>
      </div>
    </div>
  );
}
