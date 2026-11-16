# Glass palettes: converting the phone's colours to tokens

The phone now has K2 desktop Glass's three palettes: Obsidian (dark), Veil (light) and Dusk (dark, warm, gold accent).
Settings → Themes lets the user pick Light, Dark or Auto, a palette for each side, and an accent per palette.
`src/theme/palettes.ts` stamps every token on `<html>` as a CSS custom property, under desktop's names (`--color-*`),
with any custom accent already applied (`src/theme/styleAccent.ts`). `data-palette` (`obsidian` | `veil` | `yellow`)
and `data-scheme` (`dark` | `light`) are also on `<html>`.

The components still hard-code their colours (`#fff`, `#8e8e93`, `#0a84ff`, `#3a3a3c`, `rgba(255,255,255,.12)`, …).
This guide is the one map every conversion follows, so the whole app agrees.

## Rules

1. **Use desktop's token names, as `var(--color-…)`.** The full list is in `src/theme/glass/obsidian.json` (`color.*`).
   Never invent a new colour; pick the token whose meaning fits.
2. **No `color-mix()` in new code.** The phone supports iOS 15, and WebKit has no `color-mix()` before 16.2. If you need
   a translucent variant, use the wash, ring, overlay, scrim and shadow tokens below.
3. **Obsidian must look the same as today, or within a hair.** Obsidian's values are desktop's, and they're close to the
   phone's current literals. Veil and Dusk must then just work, because they set the same tokens.
4. **Inline styles stay inline.** `style={{ color: "var(--color-text-primary)" }}` is fine. Tailwind arbitrary values
   work too (`text-[var(--color-text-muted)]`).
5. **Tests that assert an old literal colour** (`toBe("#8e8e93")`) change to the token. Don't weaken a test's intent.
6. **Leave these alone:**
   - file-type icon colours (`src/zen/fileIcons/`);
   - workspace and group identity colours (the user's chosen avatar colours, `--group-*`);
   - the terminal renderer (`src/kessel/`), which has its own colours;
   - anything drawn over video in a call (the call screen stays dark);
   - image and syntax colours.

## The map

| Today (examples) | Meaning | Token |
|---|---|---|
| `#000`, `#0a0a0a`, `var(--root)`, `var(--background)` | the page | `--color-bg` |
| `#1c1c1e`, `var(--card)`, `var(--surface)` | a card, tile or sheet | `--color-bg-surface` |
| `#2c2c2e` | raised inside a card; input wells | `--color-bg-elevated` |
| `#101012`, deep insets | sunk below the page | `--color-bg-inset` |
| `#fff`, `#ffffff`, `white`, `#e4e4e7`, `var(--text)` (as text on the page or a card) | primary text and icons | `--color-text-primary` |
| `#c7c7cc`, `#ebebf5`, `var(--text-secondary)` | secondary text | `--color-text-secondary` |
| `#8e8e93`, `#a1a1aa`, `#a1a1a6`, `#71717a`, `#636366`, `var(--text-muted)` | muted text, captions, chevrons | `--color-text-muted` |
| `#0a84ff`, `#007aff`: a **fill under words** (a primary button, your own bubble, a count badge, the picked segment of a blue control) | the accent fill | background `--color-accent-fill`, words `--color-on-accent` |
| `#0a84ff`: **words or an icon** (a link, "Done", a blue chevron) | the accent as text | `--color-accent-text` |
| `#0a84ff`: a thin **ring, caret or progress bar** | the accent itself | `--color-accent` |
| `#fff` **on** an accent fill | the label on the accent | `--color-on-accent` |
| `#3a3a3c` (the agent's bubble) | someone else's bubble | `--color-bubble-agent` (words `--color-text-primary`) |
| your own bubble (`#0a84ff`) | your bubble | `--color-accent-fill` (words `--color-on-accent`); desktop's `--zen-bubble-me` |
| `#30d158`, `#22c55e` (on, OK, connected) | success | `--color-status-ok` |
| `#ff453a`, `#ef4444`: a dot or icon | error | `--color-status-error` |
| `#ff453a`: **words** (an error line) | error text | `--color-status-error-text` |
| red destructive button fill | danger | `--color-danger` (words `--color-on-danger`) |
| `#ff9f0a`, `#f59e0b`: a dot or icon | warning | `--color-status-warn` |
| orange or yellow **words** | warning text | `--color-status-warn-text` |
| "needs you" orange | | `--color-status-needs-you` |
| "working" blue words | | `--color-status-working` |
| `rgba(255,255,255,.08–.15)` hairline separators, `0.5px solid rgba(255,255,255,.12)` | a hairline | `--color-wash-2` |
| `rgba(255,255,255,.04–.06)` faint fills | a faint wash | `--color-wash-1` |
| `rgba(255,255,255,.08–.12)` pressed and hover rows, a selected row | row press | `--color-row-hover` (or `--color-bg-hover`) |
| `rgba(255,255,255,.15–.22)` stronger washes (the picked segment in a glass control) | a strong wash | `--color-wash-3` |
| `#333`, `var(--border)`, `var(--card-border)` (solid borders) | a border | `--color-border` |
| `rgba(255,255,255,.28)` strong borders | | `--color-border-strong` |
| `rgba(0,0,0,.4–.6)` behind a sheet or menu | a scrim | `--color-scrim` |
| `rgba(0,0,0,.3–.5)` in a box-shadow | a shadow | `--color-shadow` / `--color-shadow-soft` |
| switch track when off | | `--color-control-track-off` |
| a control's outline | | `--color-control-edge` |
| a text selection | | `--color-selection` |
| the frosted `.zen-glass` fill, edge and light catch | glass | `--color-frost-fill`, `--color-frost-edge`, `--color-frost-sheen` |
| a label over a photo or video | media label | `--color-media-label-bg` / `--color-media-label-text` |

**A white knob** (switch knob, slider thumb) stays `#fff` in every palette, as iOS does.

When a literal has no clear meaning, choose by what it does on screen: page, card, words, muted words, accent, or line.
If it is truly ambiguous, leave it and list it in your report.

## Veil's own glass (`[data-scheme="light"]`; K2 Design)

These values were given by K2 Design and handled in `src/styles/index.css`:
- **Frost:** fill `rgba(255,255,255,0.72)`, edge `#eaeaea`, sheen `rgba(255,255,255,0.9)` (the palette tokens give these).
- **Merged header ring:** a 1px `linear-gradient(to bottom, rgba(255,255,255,0.95) 0%, rgba(0,0,0,0.2) 32%,
  rgba(0,0,0,0.2) 68%, rgba(255,255,255,0.95) 100%)`, with a soft drop under it (5px blur, y 2px).
- **Header tint:** the page colour at 85%, then 55% at 45%, then transparent.
- **Tiles:** solid white, border `var(--color-border)`, shadow `0 2px 5px rgba(0,0,0,.08), 0 1px 1px rgba(0,0,0,.06)`,
  no inner sheen.
- **Jump pill:** a 45% dark rim with a 72% white fill (on dark it's the 10% white tint over a 60% black layer).

## Checking

Run `npx tsc --noEmit -p .` and `npx vitest run` (or the files you touched). Both must pass.
