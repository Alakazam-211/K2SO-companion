// Resolve CSS `color-mix(in srgb, …)` to a plain colour before it is
// stamped. The phone supports iOS 15.0, and WebKit has no color-mix() before
// iOS 16.2: a token like Glass's `color-mix(in srgb, var(--color-accent) 82%,
// white)` would be an invalid value there, and the property would fall back
// to nothing. So palettes.ts resolves every mix (following `var()`
// references through the palette's own values) and stamps the result.
//
// Only what the Glass token files use: hex (#rgb, #rrggbb), rgb()/rgba(),
// `white`, `black`, `transparent`, `var(--x)`, nested color-mix(), and one
// or two percentages. Anything else is left as written.

type Rgba = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/** Split on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

function parseColor(raw: string, vars: Readonly<Record<string, string>>, depth: number): Rgba | null {
  const s = raw.trim();
  if (depth > 12) return null;
  const named = NAMED[s.toLowerCase()];
  if (named) return named;
  const v = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(s);
  if (v) {
    const value = vars[v[1]] ?? v[2];
    return value === undefined ? null : parseColor(value, vars, depth + 1);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  const mix = /^color-mix\(\s*in\s+srgb\s*,(.*)\)$/is.exec(s);
  if (mix) return mixColors(mix[1], vars, depth + 1);
  return null;
}

/** `A [p%], B [q%]` (CSS Color 5: a missing percentage is the rest of 100;
 *  premultiplied alpha; percentages summing under 100 scale the alpha). */
function mixColors(args: string, vars: Readonly<Record<string, string>>, depth: number): Rgba | null {
  const parts = splitTop(args);
  if (parts.length !== 2) return null;
  const sides = parts.map((p) => {
    const m = /^(.*?)\s+([\d.]+)%$/s.exec(p);
    return m ? { color: m[1], pct: +m[2] as number | null } : { color: p, pct: null as number | null };
  });
  let [p1, p2] = [sides[0].pct, sides[1].pct];
  if (p1 === null && p2 === null) [p1, p2] = [50, 50];
  else if (p1 === null) p1 = 100 - (p2 as number);
  else if (p2 === null) p2 = 100 - p1;
  const total = (p1 as number) + (p2 as number);
  if (total <= 0) return null;
  const c1 = parseColor(sides[0].color, vars, depth);
  const c2 = parseColor(sides[1].color, vars, depth);
  if (!c1 || !c2) return null;
  const w1 = (p1 as number) / total;
  const w2 = (p2 as number) / total;
  const a = c1.a * w1 + c2.a * w2;
  const ch = (k: "r" | "g" | "b") => (a === 0 ? 0 : (c1[k] * c1.a * w1 + c2[k] * c2.a * w2) / a);
  return { r: ch("r"), g: ch("g"), b: ch("b"), a: a * Math.min(1, total / 100) };
}

function format(c: Rgba): string {
  const [r, g, b] = [c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))));
  if (c.a >= 0.9995) return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r}, ${g}, ${b}, ${+c.a.toFixed(3)})`;
}

/** A value with each color-mix() in it resolved, wherever it sits (a whole
 *  colour, or inside a shadow: `0 10px 30px color-mix(…)`). One it can't
 *  resolve is left as written, and a `var()` outside a mix stays a var. */
export function resolveColorMix(value: string, vars: Readonly<Record<string, string>>): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.toLowerCase().indexOf("color-mix(", i);
    if (at < 0) return out + value.slice(i);
    let depth = 0;
    let end = -1;
    for (let j = at + "color-mix".length; j < value.length; j++) {
      if (value[j] === "(") depth++;
      else if (value[j] === ")" && --depth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end < 0) return out + value.slice(i);
    const mix = value.slice(at, end);
    const c = parseColor(mix, vars, 0);
    out += value.slice(i, at) + (c ? format(c) : mix);
    i = end;
  }
}

/** Every property of `vars` with its color-mix() resolved against `vars`. */
export function resolveAllColorMix(vars: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = resolveColorMix(v, vars);
  return out;
}
